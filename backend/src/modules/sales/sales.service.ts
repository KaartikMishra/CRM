/**
 * Sales Order lifecycle: create, read, header edit, payments, dispatch and close.
 *
 * Product lines live in sales-item.service.ts; this file owns the order record.
 *
 * Every write runs in one transaction, takes its business timestamp from a
 * single Postgres `now()`, and locks the order row before reading state it is
 * about to act on. Node's clock is never consulted for business time, and no
 * money figure is ever trusted from the request — totals are recomputed from
 * the order's ACTIVE lines inside the lock.
 */

import { Prisma } from '@rs/database';
import {
  compareAmount,
  addAmount,
  subtractAmount,
  type CreateSalesOrderInput,
  type RecordPaymentInput,
  type SalesOrderDetail,
  type SalesOrderListQuery,
  type SalesOrderSummary,
  type UpdateSalesOrderInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import {
  canCloseOrder,
  canDispatchOrder,
  canEditOrder,
  canRecordPayment,
} from '../../policies/sales-access.js';
import { dispatchVerdict } from './sales-efficiency.js';
import { assertNotClosed, assertTransition } from './sales-status.js';
import * as repo from './sales.repository.js';

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------

export function notFound(): AppError {
  // The same answer whether the order is absent or simply not visible, so an id
  // cannot be probed for existence.
  return AppError.notFound('SALES_ORDER_NOT_FOUND', 'That sales order could not be found.');
}

export function forbidden(): AppError {
  return new AppError('FORBIDDEN_SALES_ACCESS', 403, 'You do not have access to this order.');
}

/**
 * Neon is a network hop away, so a transaction doing a handful of round trips
 * can outrun Prisma's 5-second default — especially when a row lock has other
 * requests queued behind it. Matches the Product Enquiry budget.
 */
export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * Reads the detail projection after the write transaction has committed.
 *
 * The read needs none of the transaction's guarantees, and running it inside
 * would hold the order's row lock for a query nobody is racing on.
 */
export async function detailAfterCommit(id: string, now: Date): Promise<SalesOrderDetail> {
  const detail = await repo.findDetail(id, now);
  if (!detail) throw notFound();
  return detail;
}

async function assertCustomerExists(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true },
  });

  if (!customer) {
    throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
  }
}

/**
 * A friendly message for a duplicate order id.
 *
 * The unique index is what actually guarantees uniqueness under concurrency —
 * this only spares the common case a raw DUPLICATE_RECORD, and a race still
 * lands on the index and is translated by the error handler.
 */
async function assertOrderIdAvailable(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  if (await repo.findByOrderId(orderId, tx)) {
    throw AppError.conflict(
      'DUPLICATE_ORDER_ID',
      `Order ${orderId} already exists. Order IDs must be unique.`,
    );
  }
}

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------

/**
 * One transaction: order, its lines, and the payment position it starts from.
 *
 * Lines created with the order are ACTIVE — they are the order, not a proposal
 * against it — and carry no approver, because no approval took place.
 */
export async function createSalesOrder(
  actor: AuthenticatedUser,
  input: CreateSalesOrderInput,
): Promise<SalesOrderDetail> {
  // Every catalogue link on the order has to resolve to a real, active product
  // before any of it is written. A dangling id would satisfy the foreign key
  // only by accident, and an inactive product must not be attachable to a new
  // line — procurement would then be asked to buy something withdrawn.
  const linkedIds = [
    ...new Set(input.items.map((i) => i.productId).filter((v): v is string => Boolean(v))),
  ];
  if (linkedIds.length > 0) {
    const found = await prisma.product.findMany({
      where: { id: { in: linkedIds }, isActive: true },
      select: { id: true },
    });
    if (found.length !== linkedIds.length) {
      throw AppError.badRequest(
        'PRODUCT_NOT_FOUND',
        'One of those catalogue products could not be found, or is no longer active.',
      );
    }
  }

  const { id, now } = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await assertOrderIdAvailable(tx, input.orderId);
    await assertCustomerExists(tx, input.customerId);

    const order = await tx.salesOrder.create({
      data: {
        orderId: input.orderId,
        customerId: input.customerId,
        paidAmount: new Prisma.Decimal(input.paidAmount),
        orderDate: input.orderDate,
        toBeDispatchedBy: input.toBeDispatchedBy,
        createdById: actor.id,
        items: {
          create: input.items.map((item, index) => ({
            lineNo: index + 1,
            productName: item.productName,
            productId: item.productId ?? null,
            productImageId: item.productImageAssetId ?? null,
            quantity: item.quantity,
            price: new Prisma.Decimal(item.price),
            status: 'ACTIVE' as const,
            proposedById: actor.id,
          })),
        },
        // status defaults to OPEN; efficiency stays null until dispatch.
      },
      select: { id: true },
    });

    return { id: order.id, now: at };
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Read
// ---------------------------------------------------------------------------

export async function listSalesOrders(
  query: SalesOrderListQuery,
): Promise<{ items: SalesOrderSummary[]; nextCursor: string | null; serverTime: string }> {
  const now = await databaseNow();
  const { items, nextCursor } = await repo.list(query, now);
  return { items, nextCursor, serverTime: now.toISOString() };
}

export async function getSalesOrder(
  id: string,
): Promise<{ order: SalesOrderDetail; serverTime: string }> {
  const now = await databaseNow();
  const order = await repo.findDetail(id, now);
  if (!order) throw notFound();
  return { order, serverTime: now.toISOString() };
}

// ---------------------------------------------------------------------------
//  Header edit
// ---------------------------------------------------------------------------

/**
 * Deliberately narrow: the two dates and nothing else. Product lines have their
 * own endpoints, and status, efficiency and the derived amounts are unreachable
 * here — they change through the explicit business actions below.
 */
export async function updateSalesOrder(
  actor: AuthenticatedUser,
  id: string,
  input: UpdateSalesOrderInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canEditOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const orderDate = input.orderDate ?? order.orderDate;
    const toBeDispatchedBy = input.toBeDispatchedBy ?? order.toBeDispatchedBy;

    // Mirrors sales_dispatch_not_before_order with a readable message.
    if (toBeDispatchedBy < orderDate) {
      throw AppError.validation('The dispatch deadline cannot fall before the order date.', [
        { path: 'toBeDispatchedBy', message: 'Must be on or after the order date' },
      ]);
    }

    await tx.salesOrder.update({
      where: { id },
      data: {
        ...(input.orderDate !== undefined ? { orderDate } : {}),
        ...(input.toBeDispatchedBy !== undefined ? { toBeDispatchedBy } : {}),
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Payments
// ---------------------------------------------------------------------------

/**
 * Records a partial payment.
 *
 * The amount accumulates onto paidAmount rather than replacing it, and the
 * ceiling is checked against the order's ACTIVE line total recomputed inside
 * the lock — so two simultaneous payments cannot both pass a check the pair of
 * them would break, and a line still awaiting approval cannot raise the ceiling.
 * The money guard trigger is the backstop if they somehow do.
 */
export async function recordPayment(
  actor: AuthenticatedUser,
  id: string,
  input: RecordPaymentInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canRecordPayment({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const total = await repo.activeTotal(tx, id);
    const alreadyPaid = order.paidAmount.toString();
    const pending = subtractAmount(total, alreadyPaid);

    if (compareAmount(pending, '0.00') <= 0) {
      throw AppError.conflict('ORDER_FULLY_PAID', 'This order is already paid in full.');
    }

    const nextPaid = addAmount(alreadyPaid, input.amount);

    if (compareAmount(nextPaid, total) > 0) {
      throw AppError.conflict(
        'PAYMENT_EXCEEDS_TOTAL',
        `That payment would take the paid amount past the order total. ${pending} is outstanding.`,
      );
    }

    await tx.salesOrder.update({
      where: { id },
      data: { paidAmount: new Prisma.Decimal(nextPaid) },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Dispatch — the one moment efficiency is decided
// ---------------------------------------------------------------------------

/**
 * Moves an order OPEN → DISPATCHED and freezes its verdict.
 *
 * `dispatchedAt` and `efficiency` are written together, satisfying
 * sales_efficiency_accompanies_dispatch. The transition guard refuses a second
 * dispatch, so the verdict is written exactly once and never recalculated — a
 * later edit to the deadline cannot retroactively rewrite history.
 */
export async function dispatchSalesOrder(
  actor: AuthenticatedUser,
  id: string,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    // Status first, so "already dispatched" beats a bare 403.
    assertTransition(order.status, 'DISPATCHED');
    if (!canDispatchOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    await tx.salesOrder.update({
      where: { id },
      data: {
        status: 'DISPATCHED',
        dispatchedAt: at,
        efficiency: dispatchVerdict(at, order.toBeDispatchedBy),
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Close
// ---------------------------------------------------------------------------

/**
 * Moves an order DISPATCHED → CLOSED. Final: there is no reopen.
 *
 * An order can only close once it is settled in full. The balance is recomputed
 * from the ACTIVE lines inside the lock rather than trusted from the request,
 * so a payment or an approval landing concurrently cannot let a part-paid order
 * slip through. The money guard trigger is the final backstop.
 */
export async function closeSalesOrder(
  actor: AuthenticatedUser,
  id: string,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    assertTransition(order.status, 'CLOSED');
    if (!canCloseOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const total = await repo.activeTotal(tx, id);
    const pending = subtractAmount(total, order.paidAmount.toString());
    if (compareAmount(pending, '0.00') !== 0) {
      throw AppError.conflict(
        'PAYMENT_OUTSTANDING',
        `This order cannot be closed while ${pending} is outstanding. Record the remaining payment first.`,
      );
    }

    await tx.salesOrder.update({
      where: { id },
      // closedAt and closedById are written together — sales_closed_has_closer.
      data: { status: 'CLOSED', closedAt: at, closedById: actor.id },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}
