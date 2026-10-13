/**
 * The ATS pipeline's legal moves.
 *
 * One module, shared by the service that enforces transitions and the UI that
 * offers them, for the reason the leave-day calculator is shared: a browser
 * offering a button the API refuses is worse than no button, and two copies of
 * "what can happen next" drift apart the first time somebody adds a stage.
 *
 * ### Why a map rather than "the next one in the list"
 *
 * Because real hiring is not a queue. Three things happen constantly that a
 * strict successor rule would forbid:
 *
 *   - **Skipping a stage.** Not every role has an assessment, and a senior hire
 *     may go straight from shortlisting to a final conversation. Forcing a
 *     recruiter to walk a candidate through ASSESSMENT to get past it would make
 *     the history say something untrue.
 *   - **Going back.** A final interview that raises a doubt sends somebody back
 *     to a department round. This is a legitimate, common decision, and a
 *     forward-only pipeline would make the recruiter reject and re-apply.
 *   - **Ending anywhere.** Rejection and withdrawal happen at every stage, and
 *     are recorded as a *status* change rather than a stage change precisely so
 *     the stage keeps saying how far somebody got.
 *
 * ### What is deliberately NOT legal
 *
 * Forward jumps over a decision point. Nothing reaches OFFER without passing
 * SELECTED, nothing reaches ONBOARDING without OFFER_ACCEPTED, and nothing
 * reaches JOINED except from ONBOARDING. Those three are not ceremony: they are
 * the points where a human commits the business to something, and a pipeline that
 * let a misclick skip one would let an offer exist that nobody decided to make.
 *
 * Backward moves past those same points are also refused. Once an offer is
 * accepted, "go back to screening" is not a correction — it is a different
 * decision, and the honest record of it is a rejection with a reason.
 */

import { APPLICATION_STAGES, type ApplicationStage } from '../enums.js';

/** Where a stage sits in the pipeline. Used for ordering, never for permission. */
export function stageIndex(stage: ApplicationStage): number {
  return APPLICATION_STAGES.indexOf(stage);
}

/** True when `to` is later in the pipeline than `from`. */
export function isForwardStage(from: ApplicationStage, to: ApplicationStage): boolean {
  return stageIndex(to) > stageIndex(from);
}

/**
 * The commit points.
 *
 * Reaching one of these is a decision somebody is accountable for, so it cannot
 * be skipped forward over and cannot be reversed past. Everything else in the
 * pipeline is a step in assessing somebody, and those are freely reorderable.
 */
const COMMIT_STAGES = ['SELECTED', 'OFFER_ACCEPTED', 'JOINED'] as const satisfies
  readonly ApplicationStage[];

/**
 * Which stages each stage may move to.
 *
 * Written out in full rather than derived, because the exceptions *are* the
 * business rule and a clever generator would hide them. Read it as: "from here,
 * these are the honest next records."
 */
const TRANSITIONS: Record<ApplicationStage, readonly ApplicationStage[]> = {
  // Screening is the only way out of a fresh application. An application nobody
  // has looked at cannot be shortlisted.
  APPLICATION: ['SCREENING'],

  // After screening, any assessment stage is reachable — which rounds a role uses
  // is the hiring manager's call, not this map's.
  SCREENING: ['SHORTLISTED'],

  SHORTLISTED: ['HR_INTERVIEW', 'DEPARTMENT_INTERVIEW', 'ASSESSMENT', 'FINAL_INTERVIEW'],

  // The assessment stages interconnect freely in both directions. A doubt raised
  // late sends somebody back a round, and that is a normal hiring decision rather
  // than an error to be worked around.
  HR_INTERVIEW: ['DEPARTMENT_INTERVIEW', 'ASSESSMENT', 'FINAL_INTERVIEW', 'SELECTED'],
  DEPARTMENT_INTERVIEW: ['HR_INTERVIEW', 'ASSESSMENT', 'FINAL_INTERVIEW', 'SELECTED'],
  ASSESSMENT: ['HR_INTERVIEW', 'DEPARTMENT_INTERVIEW', 'FINAL_INTERVIEW', 'SELECTED'],
  FINAL_INTERVIEW: ['HR_INTERVIEW', 'DEPARTMENT_INTERVIEW', 'ASSESSMENT', 'SELECTED'],

  // Past the first commit point. Selection can still be walked back to a further
  // round — a reference check that worries somebody is a reason to talk again —
  // but an offer cannot be skipped.
  SELECTED: ['OFFER', 'FINAL_INTERVIEW'],

  // An offer not yet answered may be revised, which means going back to SELECTED
  // and issuing another. OFFER_ACCEPTED is the acceptance itself.
  OFFER: ['OFFER_ACCEPTED', 'SELECTED'],

  // Past the second commit point: no route back. Verification may be skipped
  // where the business waives it, which is recorded as a WAIVED check rather than
  // as an absent stage.
  OFFER_ACCEPTED: ['BACKGROUND_VERIFICATION', 'ONBOARDING'],

  BACKGROUND_VERIFICATION: ['ONBOARDING'],

  // Joining is reachable only from onboarding, and only once the employment
  // record exists — the service checks that, because this map knows nothing about
  // employees.
  ONBOARDING: ['JOINED'],

  // Terminal. Somebody who has joined is an employee now; their employment
  // changes through EmployeeHistory, not through the ATS.
  JOINED: [],
};

/** The stages an application at `from` may legally move to. */
export function nextStages(from: ApplicationStage): readonly ApplicationStage[] {
  return TRANSITIONS[from];
}

/** Whether one stage move is legal. */
export function canMoveStage(from: ApplicationStage, to: ApplicationStage): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Whether reaching this stage is a decision somebody is accountable for. */
export function isCommitStage(stage: ApplicationStage): boolean {
  return (COMMIT_STAGES as readonly ApplicationStage[]).includes(stage);
}
