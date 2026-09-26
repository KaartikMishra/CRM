/**
 * Approval for changing an order's charges.
 *
 * The rule this exists for: *creating* a financial record is ordinary work, but
 * *editing* one that already exists is not. An order's first set of charges is
 * an initial entry and applies straight away. Changing a set that is already
 * there is a change to money somebody has already been told about, so it is
 * proposed rather than made, and decided by somebody holding SALES ASSIGN.
 *
 * This deliberately mirrors sales-change-request.service.ts line for line —
 * the same status enum, the same requestedBy/reviewedBy/reviewedAt/reviewNote
 * pairing, the same SALES ASSIGN capability, the same refusal to let anybody
 * review their own request. It is a second file only because what is proposed
 * is a different shape: a line request names one line, while charges are
 * replaced as a whole set.
 *
 * The one invariant worth stating plainly: a PENDING request moves no money.
 * Nothing here writes to SalesOrderCharge until a decision is APPROVED, so the
 * order goes on charging exactly what it charged before, the payable is
 * unchanged, and the payment ceiling built on it is unchanged with it. There is
 * no window in which the detail page and the database disagree.
 */

import { compareAmount, salesChargesSchema } from '@rs/shared';
import type { ReviewChangeRequestInput, SalesOrderDetail, SetSalesChargesInput } from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { resolvePermission } from '../../services/permission.service.js';
import { canReviewChange, isSelfReview } from '../../policies/sales-access.js';
import { assertNotClosed } from './sales-status.js';
import * as repo from './sales.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './sales.service.js';

/** The resolved SALES ASSIGN capability for this person. */
const mayApprove = (actor: AuthenticatedUser): Promise<boolean> =>
  resolvePermission(actor.id, actor.role, 'SALES', 'ASSIGN');

const requestNotFound = (): AppError =>
  AppError.notFound('CHARGE_CHANGE_REQUEST_NOT_FOUND', 'That charge change could not be found.');

/**
 * Files a proposed replacement for an order's charges.
 *
 * Called only when the order already has charges — `setSalesCharges` decides
 * that, because it is the one place that knows whether this is an initial entry
 * or an edit.
 */
export async function requestChargeChange(
  tx: Parameters<typeof repo.activeTotal>[0],
  actor: AuthenticatedUser,
  orderId: string,
  input: SetSalesChargesInput,
  at: Date,
): Promise<void> {
  const open = await tx.salesChargeChangeRequest.findFirst({
    where: { orderId, status: 'PENDING' },
    select: { id: true },
  });

  if (open) {
    throw AppError.conflict(
      'CHARGE_CHANGE_ALREADY_PENDING',
      'This order already has a charge change waiting for approval. That one has to be decided first.',
    );
  }

  await tx.salesChargeChangeRequest.create({
    data: {
      orderId,
      status: 'PENDING',
      // Stored as given and re-validated on the way out, so a row edited by
      // hand cannot become an approved charge.
      proposedCharges: input.charges,
      requestedById: actor.id,
      requestedAt: at,
    },
  });
}

/**
 * Approve or reject, in one path so the two cannot drift.
 *
 * A rejection is only ever a record: the charges are left exactly alone, which
 * is what makes "reject" mean the original values stand.
 */
async function review(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  decision: 'APPROVED' | 'REJECTED',
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  const reviewer = await mayApprove(actor);

  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canReviewChange(reviewer, order)) throw forbidden();

    const request = await tx.salesChargeChangeRequest.findFirst({
      where: { id: requestId, orderId },
      select: { id: true, status: true, proposedCharges: true, requestedById: true },
    });
    if (!request) throw requestNotFound();

    // Checked after the capability, so someone with no review rights at all
    // learns nothing about which requests exist.
    if (isSelfReview({ id: actor.id, role: actor.role }, request.requestedById)) {
      throw new AppError(
        'SELF_REVIEW_NOT_ALLOWED',
        403,
        'You cannot review your own change request. Someone else has to decide it.',
      );
    }

    if (request.status !== 'PENDING') {
      throw AppError.conflict(
        'CHARGE_CHANGE_NOT_PENDING',
        'That charge change has already been decided.',
      );
    }

    await tx.salesChargeChangeRequest.update({
      where: { id: requestId },
      // Status, reviewer and moment written together, the same pairing the item
      // requests use.
      data: {
        status: decision,
        reviewedById: actor.id,
        reviewedAt: at,
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });

    if (decision === 'REJECTED') return at;

    /*
      Re-validated rather than trusted.

      What comes back is Json, and the row has sat in the database since it was
      filed. Running it through the same schema the endpoint uses means an
      approved charge went through exactly the checks a directly applied one
      would have.
    */
    const parsed = salesChargesSchema.safeParse(request.proposedCharges);
    if (!parsed.success) {
      throw AppError.conflict(
        'CHARGE_CHANGE_INVALID',
        'That proposal is no longer valid and cannot be applied. Ask for it to be filed again.',
      );
    }

    await repo.replaceCharges(tx, orderId, parsed.data);

    /*
      The same two guards a direct edit passes, applied after the write so they
      see the set just stored.

      They are re-run here and not at filing time because the order can move in
      between: a payment recorded while the request sat pending can make a
      discount that was fine when proposed impossible to apply now.
    */
    const payable = await repo.activeTotal(tx, orderId);
    const paid = order.paidAmount.toString();

    if (compareAmount(payable, '0.00') < 0) {
      throw AppError.validation('A discount cannot take the order below zero.', [
        { path: 'charges', message: 'The discount is larger than the order' },
      ]);
    }

    if (compareAmount(paid, payable) > 0) {
      throw AppError.conflict(
        'PAYMENT_EXCEEDS_TOTAL',
        `These charges would take the order below the ${paid} already paid.`,
      );
    }

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

export function approveChargeChange(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  return review(actor, orderId, requestId, 'APPROVED', input);
}

export function rejectChargeChange(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  return review(actor, orderId, requestId, 'REJECTED', input);
}
