/**
 * The arithmetic of the module, kept apart from the database.
 *
 * Standing and pending are the two numbers this module exists to get right,
 * and they are easy to conflate. Isolating them here means they can be
 * reasoned about — and tested — without a Neon round trip, and there is
 * exactly one definition of each.
 */

import type { FulfillmentStatus } from '@rs/shared';

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
