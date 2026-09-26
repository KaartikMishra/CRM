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
  DEFAULT_COUNTRY,
  compareAmount,
  addAmount,
  subtractAmount,
  type CreateSalesOrderInput,
  type CancelSalesItemsInput,
  type CancelSalesOrderInput,
  type RecordPaymentInput,
  type SalesOrderDetail,
  type SalesOrderListQuery,
  type SalesOrderSummary,
  type SetSalesChargesInput,
  type UpdateSalesOrderInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import * as notification from '../notification/notification.service.js';
import * as chargeChanges from './sales-charge-change.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import {
  canCloseOrder,
  canDispatchOrder,
  canEditOrder,
  canRecordPayment,
  canCancelOrder,
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
  await loadCustomerForTax(tx, customerId);
}

/**
 * The customer, read for the one thing the order's tax depends on.
 *
 * Doubles as the existence check, so a create never reads the same row twice
 * and the two can never disagree about whether it is there.
 */
async function loadCustomerForTax(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<{ state: string | null; country: string | null }> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true, state: true, country: true },
  });

  if (!customer) {
    throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
  }

  return { state: customer.state, country: customer.country };
}

/**
 * Indian GST belongs to an Indian supply, and the server is what decides that.
 *
 * The form disables the slabs for a customer abroad, but a request is not
 * obliged to come from the form. Without this, an order for a customer in
 * Lesotho could be posted with 18% on every line, and the money guard would
 * happily enforce a payable carrying tax that is not owed to anybody.
 *
 * A customer with no country recorded is left alone: every row predating the
 * field has none, and reading those as exports would strip the tax off orders
 * that have always carried it. 'NONE' and '0' are both accepted, because
 * neither charges anything.
 */
function assertGstMatchesCustomer(
  customer: { country: string | null },
  items: readonly { gstRate?: string | null }[],
): void {
  if (!customer.country) return;
  if (customer.country.trim().toLowerCase() === DEFAULT_COUNTRY.toLowerCase()) return;

  const taxed = items.some(
    (item) => item.gstRate && item.gstRate !== 'NONE' && item.gstRate !== '0',
  );

  if (taxed) {
    throw AppError.badRequest(
      'GST_NOT_APPLICABLE',
      `Indian GST does not apply to a customer in ${customer.country}. Set those lines to No GST.`,
    );
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
  // Every product named on the order has to resolve to a real, live RS Product
  // before any of it is written. A dangling id would satisfy the foreign key
  // only by accident, and an archived product must not be attachable to a new
  // line — procurement would then be asked to buy something withdrawn.
  //
  // A ShopifyVariant id is a well-formed cuid that names no RsProduct, so it is
  // refused here: mapping is product level and no variant identity can be
  // stored even by a hand-crafted request.
  const linkedIds = [
    ...new Set(input.items.map((i) => i.rsProductId).filter((v): v is string => Boolean(v))),
  ];
  if (linkedIds.length > 0) {
    const found = await prisma.rsProduct.findMany({
      where: { id: { in: linkedIds }, status: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    if (found.length !== linkedIds.length) {
      throw AppError.badRequest(
        'RS_PRODUCT_NOT_FOUND',
        'One of those RS Products could not be found, or is no longer available.',
      );
    }
  }

  // Resolved before the transaction so the permission queries are not holding
  // it open. The list is a snapshot of who can act on procurement right now;
  // a permission changed mid-request is a race nobody can observe.
  const recipients = await notification.procurementRecipients();

  // What the order is for, in one line. The first product plus a count of the
  // rest — enough to recognise the order without opening it, and short enough
  // for a dropdown row.
  const first = input.items[0];
  const summary = first
    ? `${first.productName} × ${first.quantity}${input.items.length > 1 ? ` +${input.items.length - 1} more` : ''}`
    : 'no lines';

  const { id, now } = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await assertOrderIdAvailable(tx, input.orderId);
    const customer = await loadCustomerForTax(tx, input.customerId);
    assertGstMatchesCustomer(customer, input.items);

    const order = await tx.salesOrder.create({
      data: {
        orderId: input.orderId,
        customerId: input.customerId,

        paidAmount: new Prisma.Decimal(input.paidAmount),
        // Stated only where money was actually taken. The shared schema
        // requires one in exactly that case, and this records what it got.
        paymentMethod: input.paymentMethod ?? null,
        ...(input.charges.length > 0
          ? {
              charges: {
                create: input.charges.map((charge) => ({
                  type: charge.type,
                  label: charge.label ?? null,
                  amount: new Prisma.Decimal(charge.amount),
                })),
              },
            }
          : {}),
        orderDate: input.orderDate,
        toBeDispatchedBy: input.toBeDispatchedBy,
        createdById: actor.id,
        items: {
          create: input.items.map((item, index) => ({
            lineNo: index + 1,
            productName: item.productName,
            rsProductId: item.rsProductId ?? null,
            productImageId: item.productImageAssetId ?? null,
            quantity: item.quantity,
            price: new Prisma.Decimal(item.price),
            // An omitted field stays null rather than acquiring a default:
            // "not recorded" is a different statement from an explicit
            // 'NONE'. The line total is still quantity × price; the rate is
            // what the order's GST is worked out from, one slab at a time.
            hsnCode: item.hsnCode ?? null,
            // How THIS line's price is read, independent of every other line:
            // one order may carry 5% exclusive beside 18% inclusive.
            gstMode: item.gstMode,
            gstRate: item.gstRate ?? null,
            status: 'ACTIVE' as const,
            proposedById: actor.id,
          })),
        },
        // status defaults to OPEN; efficiency stays null until dispatch.
      },
      select: { id: true },
    });

    // Persisted with the order itself: if the order rolls back — including at
    // COMMIT, where sales_order_money_guard fires — these rows go with it.
    await notification.persist(
      tx,
      recipients,
      notification.salesOrderCreatedDraft(input.orderId, summary, order.id),
    );

    return { id: order.id, now: at };
  }, TX_OPTIONS);

  // Only now. The money guard is DEFERRABLE INITIALLY DEFERRED, so a
  // transaction can look successful inside the callback and still throw at
  // commit — emitting there could announce an order that never existed.
  await notification.deliver(recipients, 'SALES_ORDER_CREATED', id);

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
//  Charges and adjustments
// ---------------------------------------------------------------------------

/**
 * Replaces the whole set of order-level charges.
 *
 * Sent as a set rather than added one at a time, which is how the editor
 * works: the form holds the list and saves it. A discount that would take the
 * payable below what the customer has already paid is refused here with a
 * readable message, and refused again by the money guard if it somehow got
 * past — the same belt-and-braces the payment path uses.
 */
export async function setSalesCharges(
  actor: AuthenticatedUser,
  id: string,
  input: SetSalesChargesInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canEditOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    /*
      Creating a financial record is ordinary work. Editing one is not.

      An order with no charges yet is having its first set entered, which is an
      initial entry and applies straight away — the same as entering charges
      with the order itself. An order that already has charges is having money
      somebody has already been told about changed, so the new set is proposed
      rather than applied and somebody holding SALES ASSIGN decides it.

      Counted inside the lock, so two people cannot both read "no charges" and
      both apply directly.
    */
    const existing = await tx.salesOrderCharge.count({ where: { orderId: id } });

    if (existing > 0) {
      await chargeChanges.requestChargeChange(tx, actor, id, input, at);
      // Returns with the charges untouched: a proposal moves no money, so the
      // payable and the payment ceiling built on it are exactly as they were.
      return at;
    }

    await repo.replaceCharges(tx, id, input.charges);

    // Recomputed after the write, so it reflects the set just stored.
    const payable = await repo.activeTotal(tx, id);
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

    /*
      The instalment itself, beside the running total.

      Both are written here, in one transaction, and they are not two versions
      of the same fact: `paidAmount` is what sales_order_money_guard enforces
      against, and these rows are what that figure is made of. Their sum equals
      it — for history too, which the migration backfilled.

      This is also the only place a payment reference can live. An order paid in
      three instalments has three of them, so a column on the order could hold
      at most one and would overwrite the other two.
    */
    await tx.salesPayment.create({
      data: {
        orderId: id,
        amount: new Prisma.Decimal(input.amount),
        method: input.method ?? null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        recordedById: actor.id,
        recordedAt: at,
      },
    });

    await tx.salesOrder.update({
      where: { id },
      data: {
        paidAmount: new Prisma.Decimal(nextPaid),
        /*
          The latest stated method becomes the order's, and silence changes
          nothing.

          An order collected partly now and partly on delivery is PARTIAL_COD,
          and that is what the person recording the second payment says it is,
          so overwriting is right where a method is given: this field describes
          the arrangement rather than any one instalment. Where none is given
          the arrangement is simply unchanged — which is what keeps every
          existing caller working exactly as it did.
        */
        ...(input.method ? { paymentMethod: input.method } : {}),
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Cancellation
// ---------------------------------------------------------------------------

/**
 * Refuses to cancel units that purchased stock has already been committed to.
 *
 * An order line with PurchaseAllocation rows has goods standing against it:
 * Procurement took them out of free CRM stock when it allocated them, and
 * `PurchaseBillItem.stockedQty` records exactly how much this line consumed.
 * Cancelling the units here would leave that commitment pointing at a
 * requirement that no longer exists, and nothing in Sales may put it right —
 * releasing an allocation is Procurement's own operation, and its reconcile is
 * the single writer of crmStockQty.
 *
 * So Sales refuses and names the step. This is the same guard, with the same
 * error code, that already protects a line from being re-mapped or removed
 * through a change request; cancellation is a third way to reach the same
 * unsafe state, and it gets the same answer rather than a second mechanism.
 */
async function assertNoAllocations(
  tx: Prisma.TransactionClient,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;

  const allocated = await tx.purchaseAllocation.findFirst({
    where: { salesOrderItemId: { in: itemIds } },
    select: { salesOrderItem: { select: { productName: true } } },
  });
  if (!allocated) return;

  throw AppError.conflict(
    'ORDER_LINE_HAS_ALLOCATIONS',
    `Purchased stock is allocated to ${allocated.salesOrderItem.productName}. Release those allocations in Procurement before cancelling it.`,
  );
}

/**
 * Calls off a whole order.
 *
 * Nothing is deleted. The order, its lines, its payments, its charges and its
 * customer all stay exactly as they were, and the status is what distinguishes
 * a cancelled order from a live one. Every remaining unit is marked cancelled
 * through the SAME `cancelledQty` partial cancellation uses, so there is one
 * representation of "called off" rather than two that could disagree.
 *
 * It moves no money and refunds nothing. What was paid stays paid; the order
 * reports it as refundable, and a SalesRefund is what answers that — see
 * sales-refund.service.ts. Pretending a cancellation refunded the customer is
 * the one thing this must not do.
 *
 * The payable the money guard computes does not move either: `quantity` is left
 * alone, so `paid > payable` cannot become true and no part-paid order can be
 * refused at COMMIT for being cancelled.
 */
export async function cancelSalesOrder(
  actor: AuthenticatedUser,
  id: string,
  input: CancelSalesOrderInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    // Status first, so "already cancelled" beats a bare 403.
    assertTransition(order.status, 'CANCELLED');
    if (!canCancelOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const items = await tx.salesOrderItem.findMany({
      where: { orderId: id, status: 'ACTIVE' },
      select: { id: true, quantity: true, cancelledQty: true },
    });

    const standing = items.filter((item) => item.cancelledQty < item.quantity);
    await assertNoAllocations(tx, standing.map((item) => item.id));

    for (const item of standing) {
      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: { cancelledQty: item.quantity },
      });
    }

    await tx.salesOrder.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: at,
        cancelledById: actor.id,
        // Required by sales_cancellation_recorded_together: a cancellation
        // with no stated reason is unauditable.
        cancellationReason: input.reason,
      },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

/**
 * Calls off some units of some lines, leaving the rest of the order live.
 *
 * `quantity` is never touched — it keeps meaning what was ORDERED, which is the
 * only record of what was agreed and the figure the money guard prices. The
 * cancellation accumulates into `cancelledQty` beside it, so the line reads:
 *
 *     ordered 3, cancelled 1, remaining 2
 *
 * Several cancellations add up and can never pass the ordered quantity, checked
 * here for a readable message and guaranteed by
 * sales_item_cancelled_within_quantity.
 */
export async function cancelSalesItems(
  actor: AuthenticatedUser,
  id: string,
  input: CancelSalesItemsInput,
): Promise<SalesOrderDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockOrder(tx, id);

    const order = await repo.findForPolicy(id, tx);
    if (!order) throw notFound();
    assertNotClosed(order.status);
    if (!canCancelOrder({ id: actor.id, role: actor.role }, order)) throw forbidden();

    const items = await tx.salesOrderItem.findMany({
      where: { orderId: id, id: { in: input.lines.map((line) => line.itemId) } },
      select: { id: true, productName: true, quantity: true, cancelledQty: true, status: true },
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    // Every named line must belong to THIS order. Looking them up by id alone
    // would let a caller cancel units of somebody else's order.
    for (const line of input.lines) {
      if (!byId.has(line.itemId)) {
        throw AppError.notFound('SALES_ITEM_NOT_FOUND', 'That product line could not be found.');
      }
    }

    await assertNoAllocations(tx, input.lines.map((line) => line.itemId));

    for (const line of input.lines) {
      const item = byId.get(line.itemId)!;

      if (item.status !== 'ACTIVE') {
        throw AppError.conflict(
          'SALES_ITEM_NOT_ACTIVE',
          `${item.productName} is still awaiting approval, so its units cannot be cancelled.`,
        );
      }

      const nextCancelled = item.cancelledQty + line.quantity;
      if (nextCancelled > item.quantity) {
        const remaining = item.quantity - item.cancelledQty;
        throw AppError.conflict(
          'CANCEL_EXCEEDS_REMAINING',
          `${item.productName} has only ${remaining} unit(s) left to cancel.`,
        );
      }

      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: { cancelledQty: nextCancelled },
      });
    }

    /*
      Cancelling every remaining unit of every line IS cancelling the order, and
      leaving it OPEN afterwards would let it sit on the dispatch board with
      nothing to send. The reason travels with it, so the order records why.
    */
    const remainingAfter = await tx.salesOrderItem.count({
      where: { orderId: id, status: 'ACTIVE', cancelledQty: { lt: prisma.salesOrderItem.fields.quantity } },
    });

    if (remainingAfter === 0) {
      await tx.salesOrder.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: at,
          cancelledById: actor.id,
          cancellationReason: input.reason,
        },
      });
    }

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
