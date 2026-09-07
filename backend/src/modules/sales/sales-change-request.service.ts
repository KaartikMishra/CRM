/**
 * Product change requests — the only way an order's lines change after it is
 * created.
 *
 * The rule the whole workflow rests on: a request is a record of what somebody
 * asked for, and nothing else. It creates no line, edits no line, deletes no
 * line. Order value sums SalesOrderItem rows, so a request cannot move money
 * however long it sits pending. Only approval touches the products, and it does
 * so inside the same transaction and row lock every other Sales mutation uses.
 *
 * Reviewing is the SALES ASSIGN capability, resolved through the same permission
 * service every other capability goes through — never a role comparison, so a
 * per-user grant or revocation applies here exactly as it does elsewhere. It is
 * checked at the route and again here, so a hand-crafted request cannot reach
 * the decision by skipping the middleware.
 */

import { Prisma } from '@rs/database';
import {
  MAX_ITEMS_PER_SALES_ORDER,
  compareAmount,
  type CreateChangeRequestInput,
  type ReviewChangeRequestInput,
  type SalesOrderDetail,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { resolvePermission } from '../../services/permission.service.js';
import {
  canRequestItemChange,
  canReviewChange,
  isSelfReview,
} from '../../policies/sales-access.js';
import { assertNotClosed } from './sales-status.js';
import * as repo from './sales.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './sales.service.js';

/** The resolved SALES ASSIGN capability for this person. */
const mayReview = (actor: AuthenticatedUser): Promise<boolean> =>
  resolvePermission(actor.id, actor.role, 'SALES', 'ASSIGN');

const requestNotFound = (): AppError =>
  AppError.notFound('CHANGE_REQUEST_NOT_FOUND', 'That change request could not be found.');

const itemNotFound = (): AppError =>
  AppError.notFound('SALES_ITEM_NOT_FOUND', 'That product line could not be found.');

/**
 * Refuses a decision that would leave the order worth less than has been paid.
 *
 * Checked here as well as by the deferred money-guard trigger, so the reviewer
 * gets a sentence naming the numbers rather than a constraint violation.
 */
async function assertStillCoversPayments(
  tx: Prisma.TransactionClient,
  orderId: string,
  paidAmount: Prisma.Decimal,
): Promise<void> {
  const total = await repo.activeTotal(tx, orderId);
  const paid = paidAmount.toString();

  if (compareAmount(paid, total) > 0) {
    throw AppError.conflict(
      'TOTAL_BELOW_PAID',
      `This order already has ${paid} paid against it, so approving this would leave it worth only ${total}.`,
    );
  }
}

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------

/**
 * Files a request. Never touches a product.
 *
 * The one-open-request-per-line rule is checked here for a readable message and
 * guaranteed by a partial unique index, so two people racing the same line end
 * up with one request and one honest conflict rather than two contradictory
 * proposals.
 */
export async function createChangeRequest(
  actor: AuthenticatedUser,
  orderId: string,
  input: CreateChangeRequestInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canRequestItemChange({ id: actor.id, role: actor.role }, order)) throw forbidden();

    if (input.type === 'ADD') {
      // A proposal that could never be approved is not worth recording.
      const existing = await tx.salesOrderItem.count({ where: { orderId } });
      if (existing >= MAX_ITEMS_PER_SALES_ORDER) {
        throw AppError.conflict(
          'ITEM_LIMIT_REACHED',
          `An order can hold at most ${MAX_ITEMS_PER_SALES_ORDER} products.`,
        );
      }
    } else {
      // The line must exist and belong to *this* order — looking it up by id
      // alone would let a caller attach a request to someone else's product.
      const item = await repo.findItemInOrder(tx, orderId, input.itemId);
      if (!item) throw itemNotFound();

      const open = await tx.salesItemChangeRequest.findFirst({
        where: { itemId: input.itemId, status: 'PENDING' },
        select: { id: true, type: true },
      });
      if (open) {
        throw AppError.conflict(
          'CHANGE_REQUEST_ALREADY_PENDING',
          'This product already has a change waiting for approval. That one has to be decided first.',
        );
      }
    }

    await tx.salesItemChangeRequest.create({
      data: {
        orderId,
        type: input.type,
        status: 'PENDING',
        requestedById: actor.id,
        requestedAt: at,
        ...(input.type === 'REMOVE'
          ? { itemId: input.itemId }
          : {
              ...(input.type === 'EDIT' ? { itemId: input.itemId } : {}),
              productName: input.productName,
              productId: input.productId ?? null,
              productImageId: input.productImageAssetId ?? null,
              quantity: input.quantity,
              price: new Prisma.Decimal(input.price),
            }),
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

// ---------------------------------------------------------------------------
//  Review
// ---------------------------------------------------------------------------

type Decision = 'APPROVED' | 'REJECTED';

/**
 * Decides a request, and — only on approval — applies it.
 *
 * Everything is revalidated inside the lock rather than trusted from the route:
 * that the request still exists, still belongs to this order, is still pending,
 * that the order is still open, that the reviewer is not the requester, and
 * that the target line is still there. Two reviewers racing the same request
 * therefore produce one decision and one honest CHANGE_REQUEST_NOT_PENDING,
 * which is also what makes a repeated approval safe rather than doubly applied.
 */
async function review(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  decision: Decision,
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  const reviewer = await mayReview(actor);

  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canReviewChange(reviewer, order)) throw forbidden();

    const request = await tx.salesItemChangeRequest.findFirst({
      where: { id: requestId, orderId },
      select: {
        id: true,
        type: true,
        status: true,
        itemId: true,
        productName: true,
        productId: true,
        productImageId: true,
        quantity: true,
        price: true,
        requestedById: true,
      },
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
        'CHANGE_REQUEST_NOT_PENDING',
        'That change request has already been decided.',
      );
    }

    await tx.salesItemChangeRequest.update({
      where: { id: requestId },
      // Status, reviewer and moment are written together, satisfying
      // sales_change_review_recorded_together and sales_change_decided_has_reviewer.
      data: {
        status: decision,
        reviewedById: actor.id,
        reviewedAt: at,
        ...(input.note ? { reviewNote: input.note } : {}),
      },
    });

    // A rejection is only ever a record. The products are left exactly alone.
    if (decision === 'REJECTED') return at;

    if (request.type === 'ADD') {
      await tx.salesOrderItem.create({
        data: {
          orderId,
          lineNo: await repo.nextLineNo(tx, orderId),
          productName: request.productName!,
          productId: request.productId,
          productImageId: request.productImageId,
          quantity: request.quantity!,
          price: request.price!,
          status: 'ACTIVE',
          // Credited to whoever asked for it, and to whoever let it in.
          proposedById: request.requestedById,
          approvedById: actor.id,
          approvedAt: at,
        },
      });
    } else {
      // Re-read under the lock: the line could have gone since the request.
      const item = await repo.findItemInOrder(tx, orderId, request.itemId!);
      if (!item) throw itemNotFound();

      if (request.type === 'EDIT') {
        await tx.salesOrderItem.update({
          where: { id: item.id },
          data: {
            productName: request.productName!,
            // Only when the request carried one. An edit that says nothing
            // about the catalogue must not silently unlink an already-linked
            // line — that would break procurement allocation invisibly.
            ...(request.productId ? { productId: request.productId } : {}),
            productImageId: request.productImageId,
            quantity: request.quantity!,
            price: request.price!,
            approvedById: actor.id,
            approvedAt: at,
          },
        });
      } else {
        const activeCount = await tx.salesOrderItem.count({ where: { orderId } });
        if (activeCount <= 1) {
          throw AppError.conflict(
            'LAST_ACTIVE_ITEM',
            'An order must keep at least one product, so this removal cannot be approved.',
          );
        }
        await tx.salesOrderItem.delete({ where: { id: item.id } });
      }
    }

    // Only an approval can move the total, so only an approval is checked.
    await assertStillCoversPayments(tx, orderId, order.paidAmount);

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

export function approveChangeRequest(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  return review(actor, orderId, requestId, 'APPROVED', input);
}

export function rejectChangeRequest(
  actor: AuthenticatedUser,
  orderId: string,
  requestId: string,
  input: ReviewChangeRequestInput,
): Promise<SalesOrderDetail> {
  return review(actor, orderId, requestId, 'REJECTED', input);
}
