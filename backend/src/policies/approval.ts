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

// ---------------------------------------------------------------------------
//  The generic approval foundation
// ---------------------------------------------------------------------------
//
// Everything above is unchanged and stays unchanged. It is called from Sales,
// Procurement, the Procurement Clock and Dispatch — including files with
// uncommitted work in progress — and it answers a narrow question those modules
// need: may this actor's own change skip the queue.
//
// What it cannot answer is who may decide somebody *else's* request, for a kind
// of record it has never heard of. `actor.role !== 'ADMIN'` makes every approval
// in the system an administrator's job, which is wrong the moment a reporting
// manager must approve their own team's leave without becoming a CRM
// administrator. That is what the APPROVE action and the functions below are
// for.
//
// The two coexist deliberately rather than one replacing the other. Rewriting
// the five shipped approval chains onto the generic table is a migration of
// live workflow data, and this phase is explicitly not that.

/**
 * An actor as the approval foundation needs to see them.
 *
 * Wider than `Actor` above, because deciding is a permission question and
 * permissions are resolved per module and action rather than read off the role.
 * The resolver is async and hits the override table, so callers pass the answer
 * in rather than this policy reaching for a database — policies in this codebase
 * are pure, and a policy that queries cannot be unit-tested without one.
 */
export type ApprovalActor = Actor & {
  /** Whether this person holds `module` + APPROVE, already resolved. */
  mayApprove: boolean;
};

/**
 * Whether this person may decide this request.
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. They must hold APPROVE on the module that governs the request.
 *   2. They must not be the person who raised it.
 *
 * Self-approval is refused for everybody, administrators included, and that is a
 * deliberate departure from `requiresApproval` above. The distinction is worth
 * being precise about, because the two look contradictory and are not:
 *
 *   - `requiresApproval` says an administrator's own change needs no second pair
 *     of eyes, so **no request is created at all** — the change is applied and
 *     recorded as decided by them. Nothing is skipped, because nothing was ever
 *     queued.
 *   - This function governs a request that **already exists**, which means
 *     somebody deliberately asked for a decision. Letting the requester supply
 *     it would make the record a lie: the trail would show a request raised and
 *     approved, with one name on both lines and no second pair of eyes anywhere.
 *
 * An administrator who wants their own change applied without review takes the
 * first path and never creates the request. One who creates a request has, by
 * that act, asked somebody else.
 */
export function mayDecideApproval(
  actor: ApprovalActor,
  request: { requestedById: string; status: string },
): boolean {
  if (!actor.mayApprove) return false;
  if (actor.id === request.requestedById) return false;
  return request.status === 'PENDING';
}

/**
 * Whether this person may withdraw this request.
 *
 * The requester, and nobody else — not even an administrator. Withdrawing is
 * recorded as the requester's own act, so allowing another person to do it would
 * put somebody's name on a decision they did not make. An administrator who
 * wants a request gone rejects it, which is honest about who ended it and leaves
 * a note saying why.
 */
export function mayCancelApproval(
  actor: Actor,
  request: { requestedById: string; status: string },
): boolean {
  return actor.id === request.requestedById && request.status === 'PENDING';
}

/**
 * Whether a request is still open.
 *
 * Single source for the question, so "pending" is not re-spelled at each call
 * site as `!== 'APPROVED' && !== 'REJECTED'` — a form that silently treats
 * CANCELLED as open.
 */
export function isApprovalOpen(request: { status: string }): boolean {
  return request.status === 'PENDING';
}
