/**
 * Who may change what in Purchase & Procurement.
 *
 * The module permission ("may this person touch procurement at all") is
 * settled by requirePermission on the route. This file answers the narrower
 * question the permission cannot: whether *this particular* record may be
 * changed, given what has already happened to it.
 */

import type { Role } from '@rs/shared';

export type Actor = { id: string; role: Role };

/**
 * The freeze rule.
 *
 * Once an order line's requirement is fully met, its allocations stop being
 * editable for a USER. The reason is practical rather than bureaucratic: a
 * fulfilled line has had stock physically committed to it, and quietly moving
 * that stock elsewhere leaves a picker holding goods the system says belong to
 * someone else.
 *
 * An administrator can still act, because genuine corrections exist — stock
 * assigned to the wrong order has to be movable by somebody.
 */
export function canModifyFulfilledAllocation(actor: Actor): boolean {
  return actor.role === 'ADMIN';
}

/**
 * Whether an allocation may be changed at all, given the state of the line it
 * fills. Unfulfilled lines are open to anyone with the module's EDIT
 * capability; fulfilled ones are administrator-only.
 */
export function canModifyAllocation(actor: Actor, lineIsFullyFulfilled: boolean): boolean {
  return lineIsFullyFulfilled ? canModifyFulfilledAllocation(actor) : true;
}
