/**
 * Ownership rules for Sales Orders, as pure functions.
 *
 * Holding the SALES EDIT permission says a person may edit sales orders in
 * general; these functions say whether they may edit *this* one. Both checks are
 * required and neither lives in a controller.
 *
 * Kept free of Prisma and Express on purpose: they are decision logic, they are
 * unit-testable in isolation, and the services call them rather than
 * reimplementing the rules.
 *
 * A sales order has no "Towards" assignee. Operational work on one — its dates,
 * its payments, dispatching it, closing it — is the SALES EDIT capability and
 * nothing narrower: an order belongs to the business, not to whoever happened to
 * type it in, and the person collecting a payment or sending the goods is
 * routinely not that person. Restricting these to the creator meant a second
 * salesperson could only watch, and in practice made them Admin-only work.
 *
 * Who created the order is still recorded, still shown, and still the answer to
 * "whose order is this" — it is simply not an authorisation. VIEW-only access
 * remains unable to do any of this: every one of these actions sits behind
 * requirePermission('SALES', 'EDIT') on its route, which is the capability these
 * functions assume has already been resolved.
 *
 * Every rule also refuses a CLOSED order, which is what makes closing an order
 * actually final.
 */

import type { SalesOrderStatus } from '@rs/shared';
import type { Actor } from './enquiry-access.js';

export type { Actor };

/** The parts of a sales order that access decisions depend on. */
export type SalesOrderOwnership = {
  createdById: string;
  status: SalesOrderStatus;
};

/** Terminal states. Neither is editable, and neither can be returned from. */
const isSettled = (order: SalesOrderOwnership): boolean =>
  order.status === 'CLOSED' || order.status === 'CANCELLED';

/** Who typed the order in. Recorded and displayed; never an authorisation. */
export const isOrderCreator = (actor: Actor, order: SalesOrderOwnership): boolean =>
  order.createdById === actor.id;

/** Everyone who may view sales orders may view every one of them. */
export function canViewOrder(): boolean {
  return true;
}

/**
 * Anybody holding SALES EDIT may edit any open order. Nobody may touch a closed
 * one — reopening is not a sanctioned move.
 */
export function canEditOrder(_actor: Actor, order: SalesOrderOwnership): boolean {
  return !isSettled(order);
}

/** Recording money follows the same rule as editing. */
export function canRecordPayment(actor: Actor, order: SalesOrderOwnership): boolean {
  return canEditOrder(actor, order);
}

/**
 * Dispatch is only meaningful from OPEN. The status guard enforces the
 * transition itself; this answers whether *this person* may make it.
 */
export function canDispatchOrder(_actor: Actor, order: SalesOrderOwnership): boolean {
  return order.status === 'OPEN';
}

/** Closing is only meaningful from DISPATCHED. */
export function canCloseOrder(_actor: Actor, order: SalesOrderOwnership): boolean {
  return order.status === 'DISPATCHED';
}

/**
 * Who may call an order off, in whole or in part.
 *
 * The same SALES EDIT capability as every other operational action — cancelling
 * is ordinary sales work, not an administrative override. The status is what
 * narrows it: a settled order is history, and an order that never left OPEN is
 * as cancellable as one already on its way.
 */
export function canCancelOrder(_actor: Actor, order: SalesOrderOwnership): boolean {
  return !isSettled(order);
}

/**
 * Who may record money going back to the customer.
 *
 * Deliberately permitted on a CANCELLED order, and only there does it differ
 * from the rule above: a refund is settled *after* the goods are called off, so
 * refusing it on a cancelled order would make the workflow impossible to
 * finish. A CLOSED order is still refused — that money is settled.
 */
export function canRefundOrder(_actor: Actor, order: SalesOrderOwnership): boolean {
  return order.status !== 'CLOSED';
}

// ---------------------------------------------------------------------------
//  Product change requests
// ---------------------------------------------------------------------------

/**
 * Who may propose a change to an order's products.
 *
 * Deliberately *not* the edit rule. Filing a request changes nothing: it creates
 * no line, moves no money, and cannot be applied by the person who filed it. So
 * anyone holding SALES EDIT may raise one against any open order, which is what
 * lets a colleague flag a wrong quantity on an order they did not create.
 *
 * The capability itself is checked by requirePermission on the route; this adds
 * the only other condition, that the order is still open. Ownership stays
 * required for everything that *does* change an order directly — dates,
 * payments, dispatch and close all still go through canEditOrder above.
 */
export function canRequestItemChange(_actor: Actor, order: SalesOrderOwnership): boolean {
  return !isSettled(order);
}

/**
 * Who may decide a request.
 *
 * `mayApprove` is the resolved SALES ASSIGN capability, passed in rather than
 * looked up here so this file stays free of Prisma. A closed order is refused
 * like every other change.
 *
 * This deliberately says nothing about *which* request — see canReviewOwn below,
 * which is a separate question and a separate answer.
 */
export function canReviewChange(mayApprove: boolean, order: SalesOrderOwnership): boolean {
  if (isSettled(order)) return false;
  return mayApprove;
}

/**
 * Nobody signs off their own request, whatever they hold.
 *
 * Holding SALES ASSIGN means being trusted to review other people's proposals,
 * not to wave through your own — that would make the whole workflow a formality
 * for exactly the people it most needs to constrain.
 */
export function canReviewOwnRequest(): boolean {
  return false;
}

export function isSelfReview(actor: Actor, requestedById: string): boolean {
  return actor.id === requestedById;
}
