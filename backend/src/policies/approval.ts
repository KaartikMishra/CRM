/**
 * Who has to wait for somebody else's approval, as a pure function.
 *
 * The CRM's approval workflows exist to put a second pair of eyes on a change:
 * a salesperson proposes an edit and someone with review rights decides it. An
 * administrator is already that second pair of eyes, so routing their own work
 * through the queue achieves nothing — it either stalls (nobody may review
 * their own request) or needs a second administrator fetched to rubber-stamp
 * a decision the first one was trusted to make.
 *
 * This is deliberately a **role** check and not a permission check, which is
 * the one subtlety worth stating plainly. `SALES:ASSIGN` and
 * `PROCUREMENT:ASSIGN` mean "may review other people's requests", and a USER
 * can hold either through a per-user override. Keying the bypass on a
 * permission would therefore hand it to exactly the people the workflow is
 * built to constrain — someone could be granted review rights and thereby stop
 * being reviewable. Role is the only thing that separates the two populations.
 *
 * It follows the precedent already set by procurement-access.ts and
 * enquiry-access.ts, both of which compare `actor.role` where the rule really
 * is about role. It does not contradict the "never `role === 'ADMIN'`"
 * convention noted elsewhere in the services: that rule is about *capability*
 * — whether somebody may act at all — which must stay resolvable through the
 * permission service so a per-user grant or revocation still applies. This
 * function decides something else entirely, and answers it after capability
 * has already been established.
 *
 * ### What this does not do
 *
 * Skipping the approval step is the whole of it. Every other guard still runs
 * for an administrator exactly as before: requireAuth, requirePermission, the
 * ownership and status rules in the access policies, stock and allocation
 * checks, financial validation, required fields and the database's own
 * constraints. An administrator who may not perform an action still may not
 * perform it; this only says that when they may, nobody else has to agree.
 */

import type { Actor } from './enquiry-access.js';

export type { Actor };

/**
 * Whether this actor's change has to be reviewed by somebody else.
 *
 * True for a USER, which is every existing workflow unchanged. False for an
 * ADMIN, whose action is applied directly.
 *
 * Callers use it to choose *how to write the record*, not whether to write one:
 * the history row is still created, in its decided state, with the acting
 * administrator recorded as the reviewer. Nothing is silently skipped, and a
 * bill, charge or delay reason an administrator entered is still answerable to
 * the same audit trail as one a salesperson entered.
 */
export function requiresApproval(actor: Actor): boolean {
  return actor.role !== 'ADMIN';
}

/**
 * The inverse, for the call sites that read better in the positive.
 *
 * `decidesOwnAction(actor)` at the point a request would be created says what
 * is actually happening: this person's decision is the decision.
 */
export function decidesOwnAction(actor: Actor): boolean {
  return !requiresApproval(actor);
}
