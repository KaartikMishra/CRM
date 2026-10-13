/**
 * Who may see and change what in performance management, as pure functions.
 *
 * Capability — may this person reach the module at all — is decided by
 * `requirePermission` in the route table using the existing two-layer resolver.
 * What is left is *scope* and *separation of duties*, and this phase has the
 * sharpest version of the second that the system has needed so far.
 *
 * ### The four populations
 *
 *   HR / performance admins  hold HR_PERFORMANCE:VIEW. Every cycle, every review,
 *                            every goal. Running an appraisal process means knowing
 *                            where all of it stands.
 *   Managers                 hold no performance permission but are somebody's
 *                            manager. They write their reports' reviews and read
 *                            their reports' goals — a fact about employee rows, not
 *                            a permission, so it cannot live in the route table.
 *   Employees                reach their **own** review, their own self-assessment
 *                            and their own goals with no performance grant at all.
 *                            That is the population a grant-based gate cannot
 *                            serve: everybody is appraised, so requiring a grant
 *                            would mean granting the module to the whole company
 *                            and the grant would stop meaning anything.
 *   Everybody else           nothing.
 *
 * ### The three rules this file exists to enforce
 *
 * **1. An employee must not read their manager's assessment before it is shared.**
 * A manager's draft is a private working document. Showing it early means an
 * employee reading half-formed criticism, and managers who know that will stop
 * drafting honestly — so the thing the appraisal is for is lost. `mayReadManagerAssessment`
 * answers this, and it is the Phase 5 equivalent of Phase 4's answer-key rule.
 *
 * **2. Nobody writes their own manager review.** Not with EDIT, not with APPROVE,
 * not as an administrator. A review somebody wrote about themselves and filed as
 * their manager's is not a review. `mayWriteManagerAssessment` refuses the subject
 * **first**, before any permission check, so no grant can reach past it.
 *
 * **3. Nobody finalises their own review.** Finalisation sets the figure of record
 * and ends the employee's ability to respond to it. `mayFinalizeReview` refuses the
 * subject first, for the same reason and in the same shape.
 *
 * ### And the rule about finalized records
 *
 * **A finalized review is editable by nobody.** Not the employee, not the manager,
 * not HR, not an administrator. It is the record of a conversation that happened,
 * and the performance history is built from it — editing one afterwards changes a
 * trend line retroactively. `mayEditReview` returns false for any settled status
 * before it looks at who is asking.
 *
 * Pure functions with no database access, following `hr-access.ts`,
 * `attendance-access.ts`, `recruitment-access.ts` and `training-access.ts`. The
 * facts these need — is this person a manager, is this review's reviewer them —
 * are resolved once per request by the service and passed in. A policy that queries
 * cannot be unit-tested, and these are the rules most worth testing.
 */

import {
  SETTLED_REVIEW_STATUSES,
  type PerformanceReviewStatus,
} from '@rs/shared';
import type { HrActor } from './hr-access.js';

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

/**
 * Whose performance records are in reach.
 *
 *   all        every employee
 *   reports    themselves plus their direct reports
 *   selfOnly   themselves
 *   none       nothing
 *
 * A union rather than booleans, so an exhaustive switch breaks at compile time when
 * a variant is added — the same reasoning `HrScope`, `HrRecordScope` and
 * `TrainingScope` apply.
 */
export type PerformanceScope =
  | { kind: 'all' }
  | { kind: 'reports'; employeeId: string }
  | { kind: 'selfOnly'; employeeId: string }
  | { kind: 'none' };

/**
 * The scope for reading performance records.
 *
 * `hasReports` is passed in rather than derived here, because answering "is this
 * person a manager" is a database question and this file is pure.
 */
export function performanceScope(
  actor: HrActor,
  context: { hasReports: boolean },
): PerformanceScope {
  /*
    The module permission, never the role. An administrator holds HR_PERFORMANCE by
    role default, and a per-user override that revokes it must actually revoke it —
    which only works if `role` is not a back door. The same reasoning every other
    access file in this codebase applies.
  */
  if (actor.can('HR_PERFORMANCE', 'VIEW')) return { kind: 'all' };

  if (actor.employeeId) {
    return context.hasReports
      ? { kind: 'reports', employeeId: actor.employeeId }
      : { kind: 'selfOnly', employeeId: actor.employeeId };
  }

  return { kind: 'none' };
}

/**
 * The scope as a Prisma filter on a review's employee, to be ANDed with the query.
 *
 * Returning a filter rather than post-filtering a page is the difference between
 * correct and nearly-correct: filtering after the query would make a page of 25
 * arrive with 3 rows and the cursor skip the rest, so a manager's team would
 * silently appear to end early.
 *
 * `none` returns a filter matching nothing rather than `{}`. There is no Prisma
 * equivalent of `false`, and `{}` would match *everything* — the exact mistake this
 * guards against, and the one `visibleEmployeeFilter` was written to avoid.
 */
export function visibleReviewFilter(scope: PerformanceScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'reports':
      /*
        Themselves, their direct reports, and anything they are the named reviewer
        of. The third clause matters: a manager who changed teams mid-cycle still
        owes the reviews they were assigned, and a filter on the hierarchy alone
        would hide work they are accountable for.

        Not the whole subtree — a skip-level view is a decision nobody has asked
        for, and a recursive walk per list request is a cost nobody has asked for
        either.
      */
      return {
        OR: [
          { employeeId: scope.employeeId },
          { employee: { managerId: scope.employeeId } },
          { reviewerId: scope.employeeId },
        ],
      };
    case 'selfOnly':
      return { employeeId: scope.employeeId };
    case 'none':
      return { employeeId: '__no_employee_matches_this__' };
  }
}

/** The same shape for goals, which are owned by an employee *or* a department. */
export function visibleGoalFilter(scope: PerformanceScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'reports':
      /*
        Their own goals, their reports' goals, and their department's.

        The department clause is why this is not simply the review filter: a
        department goal has no employee at all, and a manager who could not see the
        goals of the unit they work in would be unable to align their team's to
        them — which is the entire point of having department goals.
      */
      return {
        OR: [
          { employeeId: scope.employeeId },
          { employee: { managerId: scope.employeeId } },
          { department: { employees: { some: { id: scope.employeeId } } } },
        ],
      };
    case 'selfOnly':
      // Their own, plus their department's: an employee is entitled to know what
      // the unit they work in is working towards.
      return {
        OR: [
          { employeeId: scope.employeeId },
          { department: { employees: { some: { id: scope.employeeId } } } },
        ],
      };
    case 'none':
      return { employeeId: '__no_employee_matches_this__' };
  }
}

/** Whether this person may read one particular employee's performance records. */
export function mayViewEmployeePerformance(
  scope: PerformanceScope,
  subject: { employeeId: string; managerId: string | null },
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'reports':
      return (
        subject.employeeId === scope.employeeId || subject.managerId === scope.employeeId
      );
    case 'selfOnly':
      return subject.employeeId === scope.employeeId;
    case 'none':
      return false;
  }
}

// ---------------------------------------------------------------------------
//  Cycle and catalogue capabilities
// ---------------------------------------------------------------------------

/**
 * Configuring the appraisal process — creating cycles, writing competency sheets.
 *
 * CREATE rather than EDIT, because designing a cycle is setting the terms everybody
 * will be judged against. A manager who writes reviews has no business redefining
 * what the business rates.
 */
export function mayManageCycles(actor: HrActor): boolean {
  return actor.can('HR_PERFORMANCE', 'CREATE');
}

/**
 * Opening and closing a cycle, and generating its reviews.
 *
 * APPROVE, not CREATE. Opening a cycle makes every employee in scope owe a
 * self-assessment with a deadline; closing one stops submissions. Both commit the
 * organisation, which is the line APPROVE marks everywhere else in HR — publishing
 * a requisition, issuing an offer, clearing somebody for live work.
 */
export function mayOperateCycle(actor: HrActor): boolean {
  return actor.can('HR_PERFORMANCE', 'APPROVE');
}

/**
 * Setting goals for other people.
 *
 * ASSIGN, which is the same grant Phase 4 uses for putting somebody into a course:
 * both place an obligation with a deadline on a colleague. A manager without it can
 * still record progress on goals already set — see `mayRecordProgress`.
 */
export function mayAssignGoals(actor: HrActor): boolean {
  return actor.can('HR_PERFORMANCE', 'ASSIGN');
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

/**
 * Whether this person may edit a goal.
 *
 * A settled goal is closed to editing: its outcome has been judged and recorded,
 * and amending the target afterwards would change what somebody was measured
 * against. Reopening is deliberately not offered — a goal that needs different
 * terms is a new goal, which keeps the original judgement readable.
 */
export function mayEditGoal(
  actor: HrActor,
  goal: {
    status: string;
    employeeId: string | null;
    ownerManagerId: string | null;
  },
): boolean {
  if (goal.status === 'ACHIEVED' || goal.status === 'PARTIALLY_MET' ||
      goal.status === 'MISSED' || goal.status === 'CANCELLED') {
    return false;
  }

  if (actor.can('HR_PERFORMANCE', 'EDIT')) return true;

  // The owner's manager may amend a goal they set. The employee may not amend
  // their own target: a goal somebody can rewrite is not a target, and the whole
  // value of agreeing one is that neither side changes it unilaterally.
  return (
    actor.employeeId !== null &&
    goal.ownerManagerId !== null &&
    goal.ownerManagerId === actor.employeeId
  );
}

/**
 * Whether this person may record progress against a KPI.
 *
 * Wider than editing, deliberately. An employee records their own progress — they
 * are the one who knows the number, and making them ask their manager to type it
 * would mean the figures are always stale. They cannot change the *target*, which
 * is the part that matters: `mayEditGoal` refuses them, so progress is recorded
 * against terms they did not set.
 *
 * Progress on a settled goal is refused: the outcome is already judged, and a
 * number arriving afterwards would make the recorded attainment disagree with the
 * recorded outcome.
 */
export function mayRecordProgress(
  actor: HrActor,
  goal: {
    status: string;
    employeeId: string | null;
    ownerManagerId: string | null;
  },
): boolean {
  if (goal.status !== 'ACTIVE') return false;

  if (actor.can('HR_PERFORMANCE', 'EDIT')) return true;
  if (actor.employeeId === null) return false;

  // The owner themselves, or their manager.
  return goal.employeeId === actor.employeeId || goal.ownerManagerId === actor.employeeId;
}

/**
 * Whether this person may close a goal and state its outcome.
 *
 * Never the employee whose goal it is, whatever grants they hold. Declaring your
 * own target achieved is the same act as approving your own review, and it is
 * refused here **first** so no permission can reach past it.
 */
export function mayCloseGoal(
  actor: HrActor,
  goal: {
    status: string;
    employeeId: string | null;
    ownerManagerId: string | null;
  },
): boolean {
  if (goal.status !== 'ACTIVE' && goal.status !== 'DRAFT') return false;

  // The subject first, before any permission check.
  if (
    goal.employeeId !== null &&
    actor.employeeId !== null &&
    goal.employeeId === actor.employeeId
  ) {
    return false;
  }

  if (actor.can('HR_PERFORMANCE', 'APPROVE')) return true;

  return (
    actor.employeeId !== null &&
    goal.ownerManagerId !== null &&
    goal.ownerManagerId === actor.employeeId
  );
}

// ---------------------------------------------------------------------------
//  Reviews — the separation-of-duties rules
// ---------------------------------------------------------------------------

/** A review nobody may change. The predicate every write check starts with. */
export function isReviewSettled(status: PerformanceReviewStatus): boolean {
  return (SETTLED_REVIEW_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether this person may write the **self**-assessment on a review.
 *
 * Only the subject. Not their manager, not HR, not an administrator holding every
 * grant — a self-assessment written by somebody else is not a self-assessment, and
 * there is no business case for one. This is the mirror image of
 * `mayWriteManagerAssessment` and is deliberately the stricter of the two.
 *
 * Refused once submitted: the manager has read it and may already have written
 * against it, so revising it afterwards changes the input to a judgement already
 * made. Reopening is an HR act, not an edit.
 */
export function mayWriteSelfAssessment(
  actor: HrActor,
  review: {
    status: PerformanceReviewStatus;
    employeeId: string;
    selfSubmittedAt: Date | string | null;
  },
): boolean {
  if (isReviewSettled(review.status)) return false;
  if (review.selfSubmittedAt !== null) return false;

  return actor.employeeId !== null && actor.employeeId === review.employeeId;
}

/**
 * Whether this person may write the **manager** assessment on a review.
 *
 * ### The subject is refused first
 *
 * Before any permission is consulted. An employee who also holds
 * HR_PERFORMANCE:EDIT — an HR colleague being appraised, which is an ordinary
 * situation — must not be able to write their own manager review, and ordering the
 * checks the other way round would let them.
 *
 * After that: the named reviewer, or somebody with EDIT. HR writing it is
 * legitimate and necessary — an employee whose manager has left still needs a
 * review — and `ManagerAssessment.submittedById` records who actually wrote it so
 * the record does not imply the stored reviewer did.
 *
 * Refused once submitted, and once finalized. A submitted manager review has been
 * shared with the employee; editing it afterwards changes what they were shown.
 */
export function mayWriteManagerAssessment(
  actor: HrActor,
  review: {
    status: PerformanceReviewStatus;
    employeeId: string;
    reviewerId: string | null;
    selfSubmittedAt: Date | string | null;
    managerSubmittedAt: Date | string | null;
  },
): boolean {
  // RULE 2. The subject, first and unconditionally.
  if (actor.employeeId !== null && actor.employeeId === review.employeeId) return false;

  if (isReviewSettled(review.status)) return false;
  if (review.managerSubmittedAt !== null) return false;

  if (actor.can('HR_PERFORMANCE', 'EDIT')) return true;

  return (
    actor.employeeId !== null &&
    review.reviewerId !== null &&
    actor.employeeId === review.reviewerId
  );
}

/**
 * Whether this person may read the manager's assessment.
 *
 * ### RULE 1 — the Phase 5 equivalent of the answer key
 *
 * The employee reads it only once it is submitted. Before that it is the manager's
 * private working document, and showing it early means an employee reading
 * half-formed criticism — after which managers stop drafting honestly, and the
 * appraisal loses the thing it was for.
 *
 * Everybody else who can reach the review at all — the reviewer, HR — reads it
 * whenever. They are the people writing it.
 *
 * The *service* applies this by nulling `managerAssessment` on the view rather than
 * refusing the request, because the employee is entitled to the rest of their own
 * review. A 403 on the whole page would be the wrong answer to "may I see my
 * review" when the honest answer is "yes, and your manager has not finished theirs".
 */
export function mayReadManagerAssessment(
  actor: HrActor,
  review: {
    employeeId: string;
    managerSubmittedAt: Date | string | null;
  },
): boolean {
  const isSubject = actor.employeeId !== null && actor.employeeId === review.employeeId;
  if (!isSubject) return true;

  return review.managerSubmittedAt !== null;
}

/**
 * Whether this person may read the self-assessment.
 *
 * The subject always — it is theirs. Everybody else once submitted, for the mirror
 * reason: an employee still drafting their own account of the year is thinking, and
 * a manager reading the half-written version would be reading something nobody
 * meant to say yet.
 */
export function mayReadSelfAssessment(
  actor: HrActor,
  review: {
    employeeId: string;
    selfSubmittedAt: Date | string | null;
  },
): boolean {
  const isSubject = actor.employeeId !== null && actor.employeeId === review.employeeId;
  if (isSubject) return true;

  return review.selfSubmittedAt !== null;
}

/**
 * Whether this person may finalise a review.
 *
 * ### RULE 3 — nobody closes their own appraisal
 *
 * The subject is refused first, before the permission check, for exactly the reason
 * `mayWriteManagerAssessment` does it: an HR colleague being appraised holds
 * APPROVE, and checking the grant first would let them lock their own rating and
 * end their own right to respond to it.
 *
 * Then: HR_PERFORMANCE:APPROVE, and nothing less. A manager who wrote the review
 * does not thereby get to close it — that is the second pair of eyes the
 * requirement asks for, and collapsing the two grants would remove it.
 *
 * The review must actually be awaiting approval. Finalising something still in
 * self-assessment would lock a record before either side had spoken.
 */
export function mayFinalizeReview(
  actor: HrActor,
  review: {
    status: PerformanceReviewStatus;
    employeeId: string;
  },
): boolean {
  // RULE 3. The subject, first and unconditionally.
  if (actor.employeeId !== null && actor.employeeId === review.employeeId) return false;

  if (review.status !== 'PENDING_APPROVAL') return false;

  return actor.can('HR_PERFORMANCE', 'APPROVE');
}

/**
 * Whether this person may cancel a review.
 *
 * APPROVE, and never the subject. Cancelling somebody's own appraisal to avoid an
 * unflattering one is the obvious abuse, and it is refused in the same shape as the
 * other two rules. A finalized review cannot be cancelled either: it is the record
 * of a conversation that happened, and withdrawing it afterwards would erase it.
 */
export function mayCancelReview(
  actor: HrActor,
  review: {
    status: PerformanceReviewStatus;
    employeeId: string;
  },
): boolean {
  if (actor.employeeId !== null && actor.employeeId === review.employeeId) return false;
  if (isReviewSettled(review.status)) return false;

  return actor.can('HR_PERFORMANCE', 'APPROVE');
}

/**
 * Whether this person may record an HR-sourced competency rating.
 *
 * EDIT, and never the subject — the same rule as the manager assessment. SELF and
 * MANAGER sources are refused through this route by the service: those belong to
 * the people whose assessments they are, written through their own endpoints, and
 * a general rating endpoint accepting `source: 'SELF'` would be the obvious way
 * around `mayWriteSelfAssessment`.
 */
export function mayRateAsHr(
  actor: HrActor,
  review: { status: PerformanceReviewStatus; employeeId: string },
): boolean {
  if (actor.employeeId !== null && actor.employeeId === review.employeeId) return false;
  if (isReviewSettled(review.status)) return false;

  return actor.can('HR_PERFORMANCE', 'EDIT');
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

/**
 * Whether this person may create or edit a development plan.
 *
 * An IMPROVEMENT plan is a formal step with consequences, so it needs EDIT or the
 * employee's own manager. The employee themselves may not write one about
 * themselves — not because self-development is suspect, but because an
 * "improvement plan" is a document the business is accountable for, and one the
 * subject authored would be neither a commitment by the business nor a record of
 * one.
 *
 * `supportOffered` exists on the model for the same reason: a plan listing only
 * what the employee must change is a warning, not a plan.
 */
export function mayManageDevelopmentPlan(
  actor: HrActor,
  plan: { employeeId: string; subjectManagerId: string | null; status: string },
): boolean {
  if (plan.status !== 'OPEN') return false;
  if (actor.employeeId !== null && actor.employeeId === plan.employeeId) return false;

  if (actor.can('HR_PERFORMANCE', 'EDIT')) return true;

  return (
    actor.employeeId !== null &&
    plan.subjectManagerId !== null &&
    plan.subjectManagerId === actor.employeeId
  );
}

/**
 * Whether this person may tick off an action on a plan.
 *
 * Wider than managing the plan, and the employee **is** included here — doing the
 * things a development plan asks for is their work, and requiring a manager to
 * record each one would make the plan a tracking burden rather than a support.
 * They cannot add, remove or reword actions: `mayManageDevelopmentPlan` refuses
 * them, so what they tick off is what was actually agreed.
 */
export function mayCompleteDevelopmentAction(
  actor: HrActor,
  plan: { employeeId: string; subjectManagerId: string | null; status: string },
): boolean {
  if (plan.status !== 'OPEN') return false;
  if (actor.employeeId === null) return actor.can('HR_PERFORMANCE', 'EDIT');

  return (
    actor.employeeId === plan.employeeId ||
    actor.employeeId === plan.subjectManagerId ||
    actor.can('HR_PERFORMANCE', 'EDIT')
  );
}
