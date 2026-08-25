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
