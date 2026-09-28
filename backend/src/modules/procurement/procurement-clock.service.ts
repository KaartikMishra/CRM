/**
 * Procurement Clock — every sales order against its T+2 procurement deadline.
 *
 * WHAT THIS OWNS. A deadline, a completion result, and two delay-reason
 * workflows. That is all. It stores no order, no product, no quantity and no
 * stock figure: `requiredQty`, `allocatedQty` and `outstandingQty` are computed
 * on every read from the order's own lines, their `alreadyFulfilled` and their
 * `PurchaseAllocation` rows, through the same `pendingQty` the shortage board
 * uses. A second copy of any of those is how two screens start disagreeing about
 * what a customer bought.
 *
 * WHAT IT NEVER WRITES. `crmStockQty` (reconcileLineStock is the single writer),
 * `alreadyFulfilled`, any allocation, and anything at all on a sales order. The
 * clock reads that ledger and records only its own verdict on it.
 *
 * TWO DIFFERENT LIFETIMES, and the distinction is the whole design:
 *
 *   `deadline`              written once, never recomputed. Immutable.
 *   `completedAt`/`verdict` the factual result *while the order is covered*.
 *                           `reconcileClock` writes them when coverage reaches
 *                           zero and CLEARS them if coverage is later lost —
 *                           an allocation released, an active line added. They
 *                           are not a permanent seal and are never called frozen:
 *                           an order that is no longer covered must not keep
 *                           claiming it was fulfilled.
 *
 * Unlike dispatch, which is a one-off physical act, coverage is a running total.
 */

import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type {
  ClockItemView,
  DelayReasonView,
  ProcurementClockDetail,
  ProcurementClockQuery,
  ProcurementClockSummary,
  ProcurementVerdict,
  ReviewDelayReasonInput,
  SubmitDelayReasonInput,
} from '@rs/shared';
import { prisma } from '../../config/database.js';
import { databaseNow } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { resolvePermission } from '../../services/permission.service.js';
import {
  allocatedQty,
  clockState,
  fulfillmentStatus,
  pendingQty,
  procurementDeadline,
  procurementVerdict,
  totalFulfilled,
} from './procurement.calc.js';
import * as repo from './procurement-clock.repository.js';

/** Neon is a network hop away; the same budget the rest of the module uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

const clockNotFound = (): AppError =>
  AppError.notFound(
    'PROCUREMENT_CLOCK_NOT_FOUND',
    'That order has no procurement clock. Only orders recorded in the CRM appear here.',
  );

/**
 * The resolved PROCUREMENT ASSIGN capability for this person.
 *
 * Deciding a purchase person's delay reason is ASSIGN, mirroring how this module
 * already gates deciding a product change and approving a bill, and resolved
 * through the same permission service every other capability goes through —
 * never `role === 'ADMIN'`, so a per-user grant or revocation applies here too.
 */
const mayReview = (actor: AuthenticatedUser): Promise<boolean> =>
  resolvePermission(actor.id, actor.role, 'PROCUREMENT', 'ASSIGN');

// ---------------------------------------------------------------------------
//  Creation — inside the transaction that creates the order
// ---------------------------------------------------------------------------

/**
 * Starts the clock for a newly created order.
 *
 * Called from `createSalesOrder`'s own transaction, so a rolled-back order takes
 * its clock with it — including at COMMIT, where the deferred money guard fires.
 * An order that never existed must not leave a deadline behind.
 *
 * The deadline is computed here, once, from the order's own `orderDate`. Nothing
 * recomputes it afterwards: editing the order must not move the bar procurement
 * was measured against.
 */
export async function createClock(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderDate: Date,
): Promise<void> {
  await tx.procurementClock.create({
    data: { orderId, deadline: procurementDeadline(orderDate) },
  });
}

// ---------------------------------------------------------------------------
//  Reconcile — the single writer of completedAt and verdict
// ---------------------------------------------------------------------------

/**
 * Recomputes one order's completion result from the ledger.
 *
 * THE SINGLE COMPLETION POINT, modelled on `reconcileLineStock`: every event that
 * could change what an order is still owed ends by calling this, and nothing else
 * writes `completedAt` or `verdict` at all. Idempotent — it computes a target
 * from the rows and writes only when the target differs, so calling it twice is
 * the same as calling it once.
 *
 * Called from: allocation created, allocation edited or released, fulfilment
 * recorded by hand, an order or part of one cancelled.
 *
 * Takes the clock's row lock itself, so no caller carries that obligation. Safe
 * against deadlock because this lock is always the LAST one acquired: Sales holds
 * the order, Procurement holds the bill item and the order line, and both reach
 * the clock afterwards — so the wait graph has no cycle.
 *
 * A CANCELLED order is the case worth reading twice. Once every line is called
 * off, the remaining requirement is zero and naive arithmetic would report the
 * order as covered — so a cancelled order would be announced as a procurement
 * success when nothing was ever procured. It is explicitly cleared instead: a
 * cancelled order's clock has stopped, and it neither completes nor keeps
 * accruing delay.
 */
export async function reconcileClock(
  tx: Prisma.TransactionClient,
  orderId: string,
  at: Date,
): Promise<void> {
  await repo.lockClock(tx, orderId);

  const clock = await repo.findClockForReconcile(tx, orderId);
  if (!clock) return;

  const cancelled = clock.order.status === 'CANCELLED';

  const outstanding = clock.order.items.reduce((sum, item) => {
    const allocated = allocatedQty(item.allocations);
    const required = item.quantity - item.cancelledQty;
    return sum + pendingQty(required, item.alreadyFulfilled, allocated);
  }, 0);

  /*
    An order with no active lines is not "covered" — there is nothing to cover.
    Reporting it as fulfilled would announce a result for an order that never
    asked for anything.
  */
  const covered = !cancelled && clock.order.items.length > 0 && outstanding === 0;

  if (!covered) {
    // Already clear: nothing to write, so no pointless row version.
    if (clock.completedAt === null) return;
    await tx.procurementClock.update({
      where: { id: clock.id },
      data: { completedAt: null, verdict: null, completionEstimated: false },
    });
    return;
  }

  // Covered, and already recorded as such. The result stands; re-deciding it
  // against the same deadline would only rewrite the same answer.
  if (clock.completedAt !== null) return;

  await tx.procurementClock.update({
    where: { id: clock.id },
    data: {
      completedAt: at,
      verdict: procurementVerdict(at, clock.deadline),
      // A real instant, so any earlier estimate on this row is superseded.
      completionEstimated: false,
    },
  });
}

/**
 * The same, addressed by a line rather than an order.
 *
 * The allocation and fulfilment paths hold an order LINE, and the clock is per
 * order. This resolves the one to the other so those call sites do not each
 * repeat the lookup — and so they cannot disagree about which order a line is on.
 *
 * Takes its own instant rather than being handed one, because those transactions
 * have no business timestamp of their own. Postgres `now()` is the transaction's
 * start time, so asking twice inside one transaction returns the same value and
 * two reconciles cannot stamp two different completions.
 */
export async function reconcileClockForItem(
  tx: Prisma.TransactionClient,
  salesOrderItemId: string,
): Promise<void> {
  const line = await repo.findOrderIdForItem(tx, salesOrderItemId);
  if (!line) return;
  await reconcileClock(tx, line.orderId, await databaseNow(tx));
}

// ---------------------------------------------------------------------------
//  Read model
// ---------------------------------------------------------------------------

const toDelayReasonView = (row: repo.DelayReasonRow): DelayReasonView => ({
  id: row.id,
  reason: row.reason,
  status: row.status,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt.toISOString(),
  reviewedBy: row.reviewedBy,
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
  reviewNote: row.reviewNote,
});

/**
 * One line's four quantities.
 *
 * `requiredQty` is what is left to supply after a cancellation, which is the
 * figure procurement acts on — and the one place the clock deliberately differs
 * from the older shortage queries, which still read `quantity` alone.
 */
function toClockItemView(item: repo.ClockRow['order']['items'][number]): ClockItemView {
  const allocated = allocatedQty(item.allocations);
  const required = item.quantity - item.cancelledQty;
  const outstanding = pendingQty(required, item.alreadyFulfilled, allocated);
  const reasons = item.purchaseDelayReasons.map(toDelayReasonView);

  return {
    salesOrderItemId: item.id,
    lineNo: item.lineNo,
    productName: item.productName,
    rsProductId: item.rsProductId,
    linked: item.rsProductId !== null,
    orderedQty: item.quantity,
    cancelledQty: item.cancelledQty,
    requiredQty: required,
    alreadyFulfilled: item.alreadyFulfilled,
    allocatedQty: allocated,
    totalFulfilled: totalFulfilled(item.alreadyFulfilled, allocated),
    outstandingQty: outstanding,
    status: fulfillmentStatus(required, outstanding),
    pendingDelayReason: reasons.find((reason) => reason.status === 'PENDING') ?? null,
    delayReasons: reasons,
  };
}

function toSummary(row: repo.ClockRow, now: Date, items: ClockItemView[]): ProcurementClockSummary {
  const cancelled = row.order.status === 'CANCELLED';
  const outstandingQty = items.reduce((sum, item) => sum + item.outstandingQty, 0);
  const verdict = row.verdict as ProcurementVerdict | null;
  const reasons = row.delayReasons.map(toDelayReasonView);

  return {
    orderId: row.order.id,
    orderNumber: row.order.orderId,
    customerName: row.order.customer.name,
    orderDate: row.order.orderDate.toISOString(),
    orderStatus: row.order.status,
    deadline: row.deadline.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    verdict,
    completionEstimated: row.completionEstimated,
    state: clockState(now, row.deadline, row.completedAt, verdict, cancelled),
    itemCount: items.length,
    outstandingQty,
    outstandingLines: items.filter((item) => item.outstandingQty > 0).length,
    /*
      The one signal a future Packing & Dispatch reads. Derived, stored nowhere,
      and committing to no packing rule: it says only that procurement owes this
      order nothing and the order is still live.
    */
    readyForDispatch: row.completedAt !== null && !cancelled && row.order.status !== 'CLOSED',
    pendingPurchaseDelays: items.filter((item) => item.pendingDelayReason !== null).length,
    procurementDelay: reasons.find((reason) => reason.status === 'PENDING') ?? null,
    /*
      Reporting only. A missing reason never changes completedAt or verdict —
      required means "the board says this is outstanding", not "the result is
      provisional". A rejected reason leaves it required: somebody still has to
      explain the delay.
    */
    procurementDelayRequired:
      verdict === 'DELAYED' && !reasons.some((reason) => reason.status === 'APPROVED'),
  };
}

function toDetail(row: repo.ClockRow, now: Date): ProcurementClockDetail {
  const items = row.order.items.map(toClockItemView);
  return {
    ...toSummary(row, now, items),
    items,
    procurementDelays: row.delayReasons.map(toDelayReasonView),
  };
}

/**
 * The board.
 *
 * `state` is filtered in the application rather than in SQL because it is not a
 * column — two of its four values are a comparison against the clock right now.
 * Filtering here keeps one definition of the state instead of a WHERE clause that
 * would have to restate it.
 */
export async function listClock(
  query: ProcurementClockQuery = {},
): Promise<ProcurementClockSummary[]> {
  const [rows, now] = await Promise.all([repo.findClocks(), databaseNow()]);

  let summaries = rows.map((row) => toSummary(row, now, row.order.items.map(toClockItemView)));

  if (query.state) summaries = summaries.filter((row) => row.state === query.state);

  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    summaries = summaries.filter(
      (row) =>
        row.orderNumber.toLowerCase().includes(needle) ||
        row.customerName.toLowerCase().includes(needle),
    );
  }

  return summaries;
}

export async function getClockDetail(orderId: string): Promise<ProcurementClockDetail> {
  const [row, now] = await Promise.all([repo.findClock(orderId), databaseNow()]);
  if (!row) throw clockNotFound();
  return toDetail(row, now);
}

export async function listPendingPurchaseDelays(): Promise<
  (DelayReasonView & {
    salesOrderItemId: string;
    productName: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
  })[]
> {
  const rows = await repo.findPendingPurchaseDelays();
  return rows.map((row) => ({
    ...toDelayReasonView(row),
    salesOrderItemId: row.salesOrderItem.id,
    productName: row.salesOrderItem.productName,
    orderId: row.salesOrderItem.order.id,
    orderNumber: row.salesOrderItem.order.orderId,
    customerName: row.salesOrderItem.order.customer.name,
  }));
}

export async function listPendingProcurementDelays(): Promise<
  (DelayReasonView & { orderId: string; orderNumber: string; customerName: string })[]
> {
  const rows = await repo.findPendingProcurementDelays();
  return rows.map((row) => ({
    ...toDelayReasonView(row),
    orderId: row.clock.orderId,
    orderNumber: row.clock.order.orderId,
    customerName: row.clock.order.customer.name,
  }));
}

// ---------------------------------------------------------------------------
//  Chain 1 — the purchase person's reason, decided by PROCUREMENT ASSIGN
// ---------------------------------------------------------------------------

/**
 * Records why one line could not be covered.
 *
 * Per LINE, because the person is late on specific goods and an order-level
 * reason could not say which. Permitted while the line still owes something,
 * including before the deadline: a purchase person who already knows the goods
 * will be late should be able to say so rather than wait to be overdue. A covered
 * line is refused — there is nothing left to explain.
 *
 * Writes only the reason. It moves no quantity and touches neither the clock's
 * completion nor its deadline.
 */
export async function submitPurchaseDelay(
  req: Request,
  actor: AuthenticatedUser,
  salesOrderItemId: string,
  input: SubmitDelayReasonInput,
): Promise<ProcurementClockDetail> {
  const orderId = await prisma.$transaction(async (tx) => {
    const line = await repo.findItemForDelay(tx, salesOrderItemId);
    if (!line) {
      throw AppError.notFound('SALES_ITEM_NOT_FOUND', 'That product line could not be found.');
    }

    await repo.lockClock(tx, line.orderId);

    if (line.order.status === 'CANCELLED') {
      throw AppError.conflict(
        'ORDER_CANCELLED',
        'That order was cancelled, so its lines no longer need procuring.',
      );
    }
    if (line.status !== 'ACTIVE') {
      throw AppError.conflict(
        'SALES_ITEM_NOT_ACTIVE',
        `${line.productName} is still awaiting approval, so it has nothing to procure yet.`,
      );
    }

    const outstanding = pendingQty(
      line.quantity - line.cancelledQty,
      line.alreadyFulfilled,
      allocatedQty(line.allocations),
    );
    if (outstanding === 0) {
      throw AppError.conflict(
        'CLOCK_LINE_COVERED',
        `${line.productName} is fully covered, so there is no delay to explain.`,
      );
    }

    /*
      Checked for a readable message; `purchase_delay_one_pending_per_item` is
      what actually guarantees it when two people race the same line.
    */
    const open = await tx.purchaseDelayReason.count({
      where: { salesOrderItemId, status: 'PENDING' },
    });
    if (open > 0) {
      throw AppError.conflict(
        'PURCHASE_DELAY_ALREADY_PENDING',
        'This line already has a delay reason waiting for approval.',
      );
    }

    await tx.purchaseDelayReason.create({
      data: { salesOrderItemId, reason: input.reason, requestedById: actor.id },
    });

    return line.orderId;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.purchaseDelay.submitted',
    entityType: 'SalesOrderItem',
    entityId: salesOrderItemId,
    actorId: actor.id,
    newValue: { reason: input.reason },
  });

  return getClockDetail(orderId);
}

/**
 * Deciding one. PROCUREMENT ASSIGN, and never an administrator.
 *
 * Checked here as well as at the route, so a call that somehow reached the
 * service without passing the middleware cannot decide a reason either. Neither
 * layer is sufficient alone and both are cheap.
 */
async function reviewPurchaseDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  const orderId = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    if (!(await mayReview(actor))) {
      throw AppError.forbidden('Deciding a delay reason needs approval rights.');
    }

    const reason = await repo.findPurchaseDelay(tx, id);
    if (!reason) {
      throw AppError.notFound(
        'PURCHASE_DELAY_NOT_FOUND',
        'That delay reason could not be found.',
      );
    }

    if (reason.requestedById === actor.id) {
      throw new AppError(
        'SELF_REVIEW_NOT_ALLOWED',
        403,
        'You cannot decide a delay reason you submitted yourself. Someone else has to.',
      );
    }
    if (reason.status !== 'PENDING') {
      throw AppError.conflict(
        'PURCHASE_DELAY_NOT_PENDING',
        'That delay reason has already been decided.',
      );
    }

    await tx.purchaseDelayReason.update({
      where: { id },
      data: {
        status: decision,
        reviewedById: actor.id,
        reviewedAt: at,
        reviewNote: input.note ?? null,
      },
    });

    /*
      Deliberately nothing else. A decision on an explanation is an audit record
      beside the clock: it cannot move completedAt, cannot move the deadline, and
      cannot turn DELAYED into ON_TIME. No reconcile is called, because nothing
      about coverage changed.
    */
    return reason.salesOrderItem.orderId;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action:
      decision === 'APPROVED'
        ? 'procurement.purchaseDelay.approved'
        : 'procurement.purchaseDelay.rejected',
    entityType: 'PurchaseDelayReason',
    entityId: id,
    actorId: actor.id,
    newValue: { decision, note: input.note ?? null },
  });

  return getClockDetail(orderId);
}

export function approvePurchaseDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  return reviewPurchaseDelay(req, actor, id, 'APPROVED', input);
}

export function rejectPurchaseDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  return reviewPurchaseDelay(req, actor, id, 'REJECTED', input);
}

// ---------------------------------------------------------------------------
//  Chain 2 — procurement's own reason, decided by an administrator
// ---------------------------------------------------------------------------

/**
 * Records why an order was covered late.
 *
 * Per ORDER, because the thing being explained is the order's outcome. Admissible
 * only once that outcome is `DELAYED` — an order still awaiting goods has nothing
 * to account for yet, and its delay is explained line by line through the
 * purchase chain instead. That is the rule that keeps UNFULFILLED_WITH_DELAY out
 * of this workflow entirely.
 *
 * Submitting needs PROCUREMENT ASSIGN: it is procurement accounting for its own
 * result, not a purchase person reporting upward.
 */
export async function submitProcurementDelay(
  req: Request,
  actor: AuthenticatedUser,
  orderId: string,
  input: SubmitDelayReasonInput,
): Promise<ProcurementClockDetail> {
  await prisma.$transaction(async (tx) => {
    await repo.lockClock(tx, orderId);

    if (!(await mayReview(actor))) {
      throw AppError.forbidden('Recording procurement’s own delay reason needs approval rights.');
    }

    const clock = await tx.procurementClock.findUnique({
      where: { orderId },
      select: { id: true, verdict: true },
    });
    if (!clock) throw clockNotFound();

    if (clock.verdict !== 'DELAYED') {
      throw AppError.conflict(
        'PROCUREMENT_DELAY_NOT_APPLICABLE',
        'This order was not covered late, so there is no procurement delay to explain. A line still waiting for goods is explained on the line itself.',
      );
    }

    const open = await tx.procurementDelayReason.count({
      where: { clockId: clock.id, status: 'PENDING' },
    });
    if (open > 0) {
      throw AppError.conflict(
        'PROCUREMENT_DELAY_ALREADY_PENDING',
        'This order already has a procurement delay reason waiting for approval.',
      );
    }

    await tx.procurementDelayReason.create({
      data: { clockId: clock.id, reason: input.reason, requestedById: actor.id },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'procurement.procurementDelay.submitted',
    entityType: 'SalesOrder',
    entityId: orderId,
    actorId: actor.id,
    newValue: { reason: input.reason },
  });

  return getClockDetail(orderId);
}

/**
 * Deciding one. ADMIN, deliberately.
 *
 * This is the one chain that goes above procurement: procurement is accounting
 * for its own delay, so the same capability that caused it cannot clear it. The
 * route carries `requireAdmin` and this re-checks, because neither layer is
 * trusted alone.
 *
 * It writes the decision and nothing else. An approval does not make a late order
 * on time, and there is no field in the input through which it could.
 */
async function reviewProcurementDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  const orderId = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    if (actor.role !== 'ADMIN') {
      throw AppError.forbidden('Only an administrator can decide a procurement delay reason.');
    }

    const reason = await repo.findProcurementDelay(tx, id);
    if (!reason) {
      throw AppError.notFound(
        'PROCUREMENT_DELAY_NOT_FOUND',
        'That delay reason could not be found.',
      );
    }

    if (reason.requestedById === actor.id) {
      throw new AppError(
        'SELF_REVIEW_NOT_ALLOWED',
        403,
        'You cannot decide a delay reason you submitted yourself. Someone else has to.',
      );
    }
    if (reason.status !== 'PENDING') {
      throw AppError.conflict(
        'PROCUREMENT_DELAY_NOT_PENDING',
        'That delay reason has already been decided.',
      );
    }

    await tx.procurementDelayReason.update({
      where: { id },
      data: {
        status: decision,
        reviewedById: actor.id,
        reviewedAt: at,
        reviewNote: input.note ?? null,
      },
    });

    return reason.clock.orderId;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action:
      decision === 'APPROVED'
        ? 'procurement.procurementDelay.approved'
        : 'procurement.procurementDelay.rejected',
    entityType: 'ProcurementDelayReason',
    entityId: id,
    actorId: actor.id,
    newValue: { decision, note: input.note ?? null },
  });

  return getClockDetail(orderId);
}

export function approveProcurementDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  return reviewProcurementDelay(req, actor, id, 'APPROVED', input);
}

export function rejectProcurementDelay(
  req: Request,
  actor: AuthenticatedUser,
  id: string,
  input: ReviewDelayReasonInput,
): Promise<ProcurementClockDetail> {
  return reviewProcurementDelay(req, actor, id, 'REJECTED', input);
}
