/**
 * The arithmetic of the module, kept apart from the database.
 *
 * Standing and pending are the two numbers this module exists to get right,
 * and they are easy to conflate. Isolating them here means they can be
 * reasoned about — and tested — without a Neon round trip, and there is
 * exactly one definition of each.
 */

import type {
  FulfillmentStatus,
  ProcurementClockState,
  ProcurementVerdict,
} from '@rs/shared';

/**
 * Received stock on a bill line that nobody has claimed yet.
 *
 *   standing = received − Σ allocated
 *
 * Ordered quantity deliberately plays no part: goods that have not arrived
 * cannot be handed to a customer, so allocating against them would promise
 * stock that does not exist.
 */
export function standingQty(receivedQty: number, allocations: { quantity: number }[]): number {
  const allocated = allocations.reduce((sum, a) => sum + a.quantity, 0);
  return Math.max(0, receivedQty - allocated);
}

export function allocatedQty(allocations: { quantity: number }[]): number {
  return allocations.reduce((sum, a) => sum + a.quantity, 0);
}

/**
 * What an order line still needs.
 *
 *   unfulfilled = quantity − alreadyFulfilled − allocated
 *
 * The two fulfilment terms are deliberately different in kind and are never
 * merged into one stored total:
 *
 *   alreadyFulfilled  units supplied outside procurement, recorded by hand
 *   allocated         the sum of this line's PurchaseAllocation rows
 *
 * Warehouse stock is not a term here, and that is the point. `onHand` is
 * shared across every order for a product, so subtracting it per line would
 * let ten units on a shelf appear to satisfy three separate customers who each
 * want ten. Inventory stays informational; only what was actually given to
 * *this* customer counts against *this* requirement.
 *
 * Floored at zero: over-supplying a line is a data problem to surface
 * elsewhere, not a negative requirement that would subtract from the shortage
 * board and hide a real gap on another product.
 */
export function pendingQty(
  requiredQty: number,
  alreadyFulfilled: number,
  allocated: number,
): number {
  return Math.max(0, requiredQty - alreadyFulfilled - allocated);
}

/** Everything supplied so far, however it got there. */
export function totalFulfilled(alreadyFulfilled: number, allocated: number): number {
  return alreadyFulfilled + allocated;
}

/** Derived, never stored — a stored copy could disagree with the rows. */
export function fulfillmentStatus(requiredQty: number, pending: number): FulfillmentStatus {
  if (pending <= 0) return 'FULFILLED';
  if (pending >= requiredQty) return 'UNFULFILLED';
  return 'PARTIAL';
}

/**
 * A line is frozen for USER once nothing is pending. Expressed as its own
 * function so the rule has one definition shared by the read projections and
 * the write guards.
 */
export function isFrozen(pending: number): boolean {
  return pending <= 0;
}

/**
 * Asia/Kolkata, fixed at UTC+5:30.
 *
 * India observes no daylight saving, so a constant offset is exact rather than
 * an approximation — the same assumption `sales-efficiency.ts` and
 * `frontend/lib/format.ts` already make.
 */
const IST_OFFSET_MS = 330 * 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The IST calendar day an instant falls on, as YYYY-MM-DD.
 *
 * Shifts into IST wall-clock time before truncating, so an allocation made at
 * 18:54 UTC belongs to the *next* IST day — which is the day the person who
 * made it would name.
 */
export function istDay(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The half-open instant range covering one IST calendar day.
 *
 * Half-open so an event at exactly midnight belongs to one day only, with no
 * millisecond falling in both or neither.
 */
export function istDayRange(day: string): { start: Date; end: Date } {
  const startMs = Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + MS_PER_DAY) };
}

/**
 * The procurement deadline for an order: T+2, where T is its own `orderDate`.
 *
 * The last millisecond of the IST day two days after the order date, so an order
 * dated the 10th is due by 23:59:59.999 IST on the 12th. A *date* rather than an
 * instant is being extended, and comparing against that day's midnight would
 * call an order covered at 2pm on its own deadline day late — which is not what
 * anyone means by "within two days".
 *
 * The same end-of-IST-day rule `sales-efficiency.ts` applies to
 * `toBeDispatchedBy`, written here against this module's own IST constant rather
 * than imported across a module boundary — exactly as `istDay` above declares its
 * own. The SQL in the procurement_clock migration computes the identical figure,
 * so a backfilled deadline and a new one agree to the millisecond.
 *
 * Called once, when the clock row is created, and never again: the deadline is
 * the one part of the clock that never moves.
 */
export function procurementDeadline(orderDate: Date): Date {
  const istWallClock = orderDate.getTime() + 2 * MS_PER_DAY + IST_OFFSET_MS;
  const istDayStart = Math.floor(istWallClock / MS_PER_DAY) * MS_PER_DAY;
  return new Date(istDayStart + MS_PER_DAY - 1 - IST_OFFSET_MS);
}

/**
 * The factual verdict on a completed order, against its immutable deadline.
 *
 * Deliberately not called "freezing" anything: `reconcileClock` writes this the
 * moment coverage reaches zero and clears it again if coverage is later lost, so
 * the result states what is true now rather than sealing a claim for ever. The
 * deadline it is measured against is what never changes.
 */
export function procurementVerdict(completedAt: Date, deadline: Date): ProcurementVerdict {
  return completedAt <= deadline ? 'ON_TIME' : 'DELAYED';
}

/**
 * Where an order stands on the clock, for a reader.
 *
 * Derived on every read, which is why no column holds it: two of the four are a
 * comparison against `now`, and a stored value would need a sweep to flip
 * UNFULFILLED into UNFULFILLED_WITH_DELAY as a deadline passes. The same shape as
 * `isOverdue()` in the Sales module, which derives "overdue" beside the stored
 * verdict rather than storing a second one.
 *
 * Null for a cancelled order: its clock has stopped, so it is neither fulfilled
 * nor accruing delay. Cancellation is the order's own status and is reported
 * beside this, never folded into it as a fifth value.
 */
export function clockState(
  now: Date,
  deadline: Date,
  completedAt: Date | null,
  verdict: ProcurementVerdict | null,
  orderCancelled: boolean,
): ProcurementClockState | null {
  if (orderCancelled) return null;
  if (completedAt === null || verdict === null) {
    return now > deadline ? 'UNFULFILLED_WITH_DELAY' : 'UNFULFILLED';
  }
  return verdict === 'ON_TIME' ? 'FULFILLED_ON_TIME' : 'FULFILLED_DELAYED';
}
