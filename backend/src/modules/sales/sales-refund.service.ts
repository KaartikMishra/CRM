/**
 * Money owed back to the customer, and whether it has actually gone.
 *
 * The rule this whole file exists to enforce: **cancelling refunds nothing.**
 * Calling off an order says the goods are not coming. Whether money goes back,
 * how much, and when are separate facts somebody has to state — so a cancelled
 * order reports an amount *refundable* and stays that way until a refund is
 * recorded against it.
 *
 * There is no payment gateway behind this CRM, so nothing here reverses a real
 * payment. A refund is an internal record of a decision (PENDING) and then of a
 * settlement (COMPLETED), and the difference between the two is the point: an
 * order can be cancelled, its refund agreed, and the customer still be owed.
 * Marking one COMPLETED requires the reference the money went out with, checked
 * here and again by sales_refund_completed_has_reference — saying money moved
 * without saying how is the one claim this system cannot check.
 *
 * Deliberately built on the same bones as every other decision in Sales: one
 * transaction, the order row locked first, the business timestamp from
 * databaseNow, the capability resolved through the policy rather than a role
 * comparison, and the settlement pair written together.
 */

import { Prisma } from '@rs/database';
import {
  compareAmount,
  type CreateSalesRefundInput,
  type RejectSalesRefundInput,
  type SalesOrderDetail,
  type SettleSalesRefundInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { canRefundOrder } from '../../policies/sales-access.js';
import * as repo from './sales.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './sales.service.js';

const refundNotFound = (): AppError =>
  AppError.notFound('SALES_REFUND_NOT_FOUND', 'That refund could not be found.');

/**
 * What the order could still owe back, recomputed inside the lock.
 *
 *     refundable = paid − activeTotal − refunded − refundPending
 *
 * `activeTotal` is what the customer is still getting — the order's own
 * arithmetic over the remaining quantities, taken from the repository's money
 * view so there is exactly one definition of it. Refunds already agreed count
 * against the ceiling whether or not they have been sent, so two people cannot
 * each record a refund for the whole surplus.
 */
async function refundableNow(tx: Prisma.TransactionClient, orderId: string): Promise<string> {
  const money = await repo.moneyForOrder(tx, orderId);
  return money.refundable;
}

/**
 * Records that money is owed back. It moves none.
 *
 * The amount is stated rather than derived from the cancellation: a business
 * may return less than the cancelled value, or settle in instalments. What it
 * may not do is exceed what is actually refundable.
 */
export async function createRefund(
  actor: AuthenticatedUser,
  orderId: string,
  input: CreateSalesRefundInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    if (!canRefundOrder({ id: actor.id, role: actor.role }, order)) {
      // A closed order's money is settled; reopening it is not a move.
      throw AppError.conflict(
        'ORDER_CLOSED',
        'This order is closed, so no more money can be returned against it.',
      );
    }

    const ceiling = await refundableNow(tx, orderId);

    if (compareAmount(ceiling, '0.00') <= 0) {
      throw AppError.conflict(
        'NOTHING_REFUNDABLE',
        'Nothing is refundable on this order. Cancel the units first, or check the refunds already recorded.',
      );
    }

    if (compareAmount(input.amount, ceiling) > 0) {
      throw AppError.conflict(
        'REFUND_EXCEEDS_REFUNDABLE',
        `Only ${ceiling} is refundable on this order, counting the refunds already recorded.`,
      );
    }

    await tx.salesRefund.create({
      data: {
        orderId,
        amount: new Prisma.Decimal(input.amount),
        // PENDING by default and deliberately: recording a refund is agreeing
        // to it, not sending it.
        status: 'PENDING',
        reason: input.reason,
        note: input.note ?? null,
        requestedById: actor.id,
        requestedAt: at,
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

/** Loads a refund that belongs to this order and is still open. */
async function pendingRefund(
  tx: Prisma.TransactionClient,
  orderId: string,
  refundId: string,
): Promise<{ id: string; amount: Prisma.Decimal }> {
  const refund = await tx.salesRefund.findFirst({
    where: { id: refundId, orderId },
    select: { id: true, status: true, amount: true },
  });
  if (!refund) throw refundNotFound();

  if (refund.status !== 'PENDING') {
    throw AppError.conflict(
      'REFUND_ALREADY_SETTLED',
      'That refund has already been settled.',
    );
  }

  return { id: refund.id, amount: refund.amount };
}

/**
 * Marks a refund as actually sent.
 *
 * The reference is required. It is the only thing that makes the claim
 * checkable against a bank statement, and the database refuses a COMPLETED row
 * without one — so this cannot be worked around by writing the row directly.
 */
export async function settleRefund(
  actor: AuthenticatedUser,
  orderId: string,
  refundId: string,
  input: SettleSalesRefundInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    if (!canRefundOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const refund = await pendingRefund(tx, orderId, refundId);

    await tx.salesRefund.update({
      where: { id: refund.id },
      data: {
        status: 'COMPLETED',
        reference: input.reference,
        ...(input.note ? { note: input.note } : {}),
        // Written together, satisfying sales_refund_settled_recorded_together.
        settledById: actor.id,
        settledAt: at,
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

/**
 * Refuses a refund that was agreed and will not be paid.
 *
 * The amount goes back to being refundable, because nothing went anywhere — a
 * rejected refund is a decision reversed, not money moved.
 */
export async function rejectRefund(
  actor: AuthenticatedUser,
  orderId: string,
  refundId: string,
  input: RejectSalesRefundInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, orderId);

    const order = await repo.findForPolicy(orderId, tx);
    if (!order) throw notFound();
    if (!canRefundOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const refund = await pendingRefund(tx, orderId, refundId);

    await tx.salesRefund.update({
      where: { id: refund.id },
      data: {
        status: 'REJECTED',
        ...(input.note ? { note: input.note } : {}),
        settledById: actor.id,
        settledAt: at,
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(orderId, now);
}

