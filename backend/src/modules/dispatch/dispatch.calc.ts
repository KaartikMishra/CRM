/**
 * Whether an order can be sent, as pure arithmetic.
 *
 * Nothing here is stored. Readiness is recomputed on every read from the order's
 * own lines and their allocations, through the *same* `pendingQty` and
 * `fulfillmentStatus` that Procurement's shortage board uses — so the dispatch
 * board and the shortage board cannot disagree about what a customer is still
 * owed. A stored readiness column would be a second copy of a figure that
 * already has one source, and the two would drift the first time an allocation
 * was released.
 *
 * Kept free of Prisma and Express on purpose, like procurement.calc.ts: this is
 * decision logic, it is unit-testable in isolation, and the service calls it
 * rather than reimplementing it.
 *
 * ### What is deliberately not here
 *
 * Any stock figure. `ShopifyVariant.crmStockQty` has exactly one writer —
 * reconcileLineStock in Procurement — and dispatch is not it. Allocation
 * already removed these goods from free stock when they were committed to the
 * order; counting them again here would report the same units twice.
 */

import { fulfillmentStatus, pendingQty, totalFulfilled } from '../procurement/procurement.calc.js';
import type { FulfillmentStatus } from '@rs/shared';

/** The parts of an order line a readiness decision depends on. */
export type ReadinessInput = {
  quantity: number;
  cancelledQty: number;
  alreadyFulfilled: number;
  allocations: { quantity: number }[];
  /** Units already gone out on earlier shipments of this order. */
  dispatchedQty: number;
};

export type LineReadiness = {
  /** What is actually owed: ordered less anything the customer called off. */
  requiredQty: number;
  /** Supplied by hand plus allocated from purchases. */
  readyQty: number;
  /** Still to come. */
  pendingQty: number;
  dispatchedQty: number;
  /** What could go in a shipment right now: ready, less what already went. */
  dispatchableQty: number;
  status: FulfillmentStatus;
};

/**
 * One line's readiness.
 *
 * `requiredQty` subtracts `cancelledQty` deliberately. A line for five of which
 * two were called off needs three, and treating the original five as the
 * requirement would hold the order back forever waiting for goods nobody wants.
 *
 * `readyQty` is capped at the requirement: over-allocation is possible in the
 * data and is a Procurement concern, but a line cannot be *more* than ready, and
 * letting it read as such would make a whole order look dispatchable on the
 * strength of one over-supplied product.
 */
export function lineReadiness(line: ReadinessInput): LineReadiness {
  const requiredQty = Math.max(0, line.quantity - line.cancelledQty);
  const allocated = line.allocations.reduce((sum, a) => sum + a.quantity, 0);

  const pending = pendingQty(requiredQty, line.alreadyFulfilled, allocated);
  const readyQty = Math.min(requiredQty, totalFulfilled(line.alreadyFulfilled, allocated));

  return {
    requiredQty,
    readyQty,
    pendingQty: pending,
    dispatchedQty: line.dispatchedQty,
    // Never negative: a line dispatched beyond its ready quantity is a data
    // problem to report, not a negative amount to offer for packing.
    dispatchableQty: Math.max(0, readyQty - line.dispatchedQty),
    status: fulfillmentStatus(requiredQty, pending),
  };
}

/**
 * Whether the whole order is ready.
 *
 * A line requiring nothing — every unit cancelled — does not hold the order
 * back, which is why the test is on `pendingQty` rather than on status: a
 * fully-cancelled line reports FULFILLED with a requirement of zero, and
 * counting it as unready would strand the order.
 *
 * An order with no lines at all is not "ready"; there is nothing to send.
 */
export function orderFullyReady(lines: LineReadiness[]): boolean {
  if (lines.length === 0) return false;
  return lines.every((line) => line.pendingQty === 0);
}

/**
 * Whether some — but not all — of the order can go.
 *
 * This is the state that offers "Initiate Partial Dispatch": at least one line
 * has goods waiting to be packed, and at least one line is still short.
 */
export function orderPartiallyReady(lines: LineReadiness[]): boolean {
  if (lines.length === 0) return false;
  if (orderFullyReady(lines)) return false;
  return lines.some((line) => line.dispatchableQty > 0);
}

/** Nothing can be packed yet: every line is still waiting on goods. */
export function orderNothingReady(lines: LineReadiness[]): boolean {
  return lines.every((line) => line.dispatchableQty === 0);
}

/**
 * Whether everything owed has now been sent.
 *
 * The condition for an order reaching DISPATCHED: every line has had its whole
 * requirement shipped. Distinct from `orderFullyReady`, which only says the
 * goods are on hand.
 */
export function orderFullyDispatched(lines: LineReadiness[]): boolean {
  if (lines.length === 0) return false;
  return lines.every((line) => line.dispatchedQty >= line.requiredQty);
}

// ---------------------------------------------------------------------------
//  What stops a shipment leaving
// ---------------------------------------------------------------------------

/** The customer fields a parcel cannot be sent without. */
export type CustomerForDispatch = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
};

export type DispatchChecks = {
  /** Hard refusals: the goods do not leave until these are fixed. */
  blockers: string[];
  /** Worth saying, but never a refusal. */
  warnings: string[];
};

/**
 * What is missing before goods can go.
 *
 * Name, address and phone are blockers because a parcel cannot be addressed or
 * a courier redirected without them. Email is a warning only, deliberately: a
 * customer who never gave one is common, and refusing to ship for want of a
 * notification address would stop real business for no physical reason.
 *
 * Returned as two lists rather than a boolean so the UI can show both kinds at
 * once without implying the second stops anything.
 */
export function customerDispatchChecks(customer: CustomerForDispatch): DispatchChecks {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!customer.name.trim()) blockers.push('The customer has no name recorded.');
  if (!customer.address?.trim()) {
    blockers.push('The customer has no delivery address. Add one before dispatching.');
  }
  if (!customer.phone?.trim()) {
    blockers.push('The customer has no phone number. A courier needs one to deliver.');
  }
  if (!customer.email?.trim()) {
    warnings.push('The customer has no email address, so no dispatch email can be sent.');
  }

  return { blockers, warnings };
}
