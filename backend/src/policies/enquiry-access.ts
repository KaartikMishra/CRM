/**
 * §23 — ownership rules for Product Enquiry, as pure functions.
 *
 * Holding the PRODUCT_ENQUIRY EDIT permission says a person may edit enquiries
 * in general; these functions say whether they may edit *this* one. Both checks
 * are required, and neither lives in a controller.
 *
 * Kept free of Prisma and Express on purpose: they are decision logic, they are
 * unit-testable in isolation, and Phase 3H will call them from the enquiry
 * services rather than reimplementing the rules.
 */

import type { EnquiryStatus, Role } from '@rs/shared';

export type Actor = {
  id: string;
  role: Role;
};

/** The parts of an enquiry that access decisions depend on. */
export type EnquiryOwnership = {
  createdById: string;
  assignedToId: string;
  status: EnquiryStatus;
};

const isAdmin = (actor: Actor): boolean => actor.role === 'ADMIN';

export const isCreator = (actor: Actor, e: EnquiryOwnership): boolean =>
  e.createdById === actor.id;

/** "Towards" — the person whose SLA clock is running on this enquiry. */
export const isTowards = (actor: Actor, e: EnquiryOwnership): boolean =>
  e.assignedToId === actor.id;

/** §22 — everyone may read every enquiry; only editing is narrowed. */
export function canViewEnquiry(): boolean {
  return true;
}

/**
 * Whether this person may see WHO the customer is.
 *
 * Three fields and no others follow this: name, phone, email. They move
 * together — a phone number identifies a person as surely as a name does — and
 * they follow the CREATE capability:
 *
 *   Raiser  holds PRODUCT_ENQUIRY CREATE. They took the enquiry, so they are
 *           the one who has to ring the customer back.
 *
 * Address, state, GST number and customer type are NOT governed by this. An
 * Answerer is sourcing and pricing goods: where the goods are going and how the
 * sale is taxed is part of that job, and none of it says who the buyer is.
 *
 * So identity follows the right to raise, not the right to read — everybody
 * granted the module still sees every enquiry, and everything about it except
 * those three fields.
 *
 * Takes the already-resolved capability rather than an Actor, matching
 * `canReviewChange` in sales-access: resolving a permission needs the database,
 * and these functions stay pure so they can be reasoned about on their own. It
 * also means a per-user override behaves here exactly as it does on the routes —
 * revoke CREATE from one person and the identity goes with it, with no second
 * switch to remember.
 *
 * Deliberately NOT a role check. `Role` is ADMIN | USER and neither names these
 * two jobs; inventing a third role would have duplicated a permission system
 * that already expresses this.
 */
export function canViewCustomerContact(mayRaiseEnquiry: boolean): boolean {
  return mayRaiseEnquiry;
}

/**
 * §22/§24 — a USER may edit an enquiry they created or are Towards on, and
 * never once it is CLOSED. An ADMIN may edit any open enquiry; reopening a
 * closed one is a separate, audited action rather than an ordinary edit.
 */
export function canEditEnquiry(actor: Actor, e: EnquiryOwnership): boolean {
  if (e.status === 'CLOSED') return false;
  if (isAdmin(actor)) return true;
  return isCreator(actor, e) || isTowards(actor, e);
}

/**
 * §12/§23 — adding a line follows the same rule as editing: the creator or the
 * person it is Towards, and never on a closed enquiry.
 */
export function canAddProduct(actor: Actor, e: EnquiryOwnership): boolean {
  return canEditEnquiry(actor, e);
}

/** §22 — vendor responses belong to whoever is Towards. Admin may act on any. */
export function canAddVendorResponse(actor: Actor, e: EnquiryOwnership): boolean {
  if (e.status === 'CLOSED') return false;
  return isAdmin(actor) || isTowards(actor, e);
}

/** §22 — Partial and Full Submit are Towards-only, plus admin. */
export function canSubmitEnquiry(actor: Actor, e: EnquiryOwnership): boolean {
  if (e.status === 'CLOSED') return false;
  return isAdmin(actor) || isTowards(actor, e);
}

/** §22 — reassigning Towards is an ADMIN action. */
export function canReassignEnquiry(actor: Actor): boolean {
  return isAdmin(actor);
}

/** §24 — a controlled, audited reopen. ADMIN only, and only from CLOSED. */
export function canReopenEnquiry(actor: Actor, e: EnquiryOwnership): boolean {
  return isAdmin(actor) && e.status === 'CLOSED';
}
