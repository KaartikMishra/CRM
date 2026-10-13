/**
 * Who may see and change what in training, as pure functions.
 *
 * Capability — may this person reach the module at all — is decided by
 * `requirePermission` in the route table using the existing two-layer resolver.
 * What is left is *scope*, and training's scope question has a shape neither of the
 * earlier HR phases had.
 *
 * ### The four populations
 *
 *   Training administrators  hold HR_TRAINING:VIEW. The whole catalogue and every
 *                            learner. Running a training function means knowing who
 *                            has done what.
 *   Reviewers and mentors    hold no training permission, but appear as a practical
 *                            reviewer or a shadowing mentor. They reach the
 *                            submissions and records assigned to them — a fact about
 *                            rows, not a permission, so it cannot live in the route
 *                            table.
 *   Managers                 hold no training permission but are somebody's manager.
 *                            They see their reports' progress and results.
 *   Learners                 reach their **own** enrollments, papers and results
 *                            with no training grant at all. That is the population
 *                            Phases 1 and 3 did not have to serve at this scale:
 *                            every employee is a learner, so requiring a grant would
 *                            mean granting the module to the entire company and the
 *                            grant would stop meaning anything.
 *
 * ### The rule this file exists to protect
 *
 * **An employee must not read another employee's answers or results.** Not their
 * selected options, not their score, not their per-question correctness. A learner's
 * assessment performance is as personal as their attendance, and the only people
 * entitled to it are the learner, their manager, and whoever runs training.
 *
 * ### And the one it exists to prevent
 *
 * **Nobody signs off their own practical or shadowing.** An independent review is
 * the entire value of those two gates — a learner who can approve their own has not
 * been reviewed, they have been asked to self-certify. Enforced here *and* in the
 * service, because it is the check that stands between somebody and live customer
 * work.
 *
 * Pure functions with no database access, following `hr-access.ts`,
 * `attendance-access.ts` and `recruitment-access.ts`. The facts these need (is this
 * person a manager, do they review this submission) are resolved once per request by
 * the service and passed in — a policy that queries cannot be unit-tested, and these
 * are the rules most worth testing.
 */

import type { HrActor } from './hr-access.js';

/**
 * Whose training records are in reach.
 *
 *   all        every learner
 *   reports    themselves plus their direct reports
 *   selfOnly   themselves
 *   none       nothing
 *
 * A union rather than booleans, so an exhaustive switch breaks at compile time when
 * a variant is added — the same reasoning `HrScope` and `HrRecordScope` apply.
 */
export type TrainingScope =
  | { kind: 'all' }
  | { kind: 'reports'; employeeId: string }
  | { kind: 'selfOnly'; employeeId: string }
  | { kind: 'none' };

/**
 * The scope for reading training records.
 *
 * `hasReports` is passed in rather than derived here, because answering "is this
 * person a manager" is a database question and this file is pure.
 */
export function trainingScope(
  actor: HrActor,
  context: { hasReports: boolean },
): TrainingScope {
  /*
    The module permission, never the role. An administrator holds HR_TRAINING by
    role default, and a per-user override that revokes it must actually revoke it —
    which only works if `role` is not a back door. The same reasoning every other
    access file in this codebase applies.
  */
  if (actor.can('HR_TRAINING', 'VIEW')) return { kind: 'all' };

  if (actor.employeeId) {
    return context.hasReports
      ? { kind: 'reports', employeeId: actor.employeeId }
      : { kind: 'selfOnly', employeeId: actor.employeeId };
  }

  return { kind: 'none' };
}

/**
 * The scope as a Prisma filter on `employeeId`, to be ANDed with the query.
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
export function visibleLearnerFilter(scope: TrainingScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'reports':
      // Themselves plus their direct reports. Not the whole subtree: a skip-level
      // view is a decision nobody has asked for, and a recursive walk per list
      // request would be a cost nobody has asked for either.
      return {
        employee: {
          OR: [{ id: scope.employeeId }, { managerId: scope.employeeId }],
        },
      };
    case 'selfOnly':
      return { employeeId: scope.employeeId };
    case 'none':
      return { employeeId: '__no_learner_matches_this__' };
  }
}

/** Whether this person may read one particular learner's records. */
export function mayViewLearner(
  scope: TrainingScope,
  learner: { employeeId: string; managerId: string | null },
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'reports':
      return (
        learner.employeeId === scope.employeeId || learner.managerId === scope.employeeId
      );
    case 'selfOnly':
      return learner.employeeId === scope.employeeId;
    case 'none':
      return false;
  }
}

// ---------------------------------------------------------------------------
//  Catalogue capabilities
// ---------------------------------------------------------------------------

/**
 * Reading the catalogue.
 *
 * Deliberately broad — any signed-in employee may browse what training exists, the
 * way they can browse the employee directory. Knowing a "Customer psychology"
 * course exists discloses nothing, and hiding the catalogue from learners would
 * mean they could not see what they are being asked to do.
 *
 * What it does *not* grant is anybody's progress or results; those go through
 * `trainingScope`.
 */
export function mayViewCatalogue(): boolean {
  return true;
}

export function mayCreatePrograms(actor: HrActor): boolean {
  return actor.can('HR_TRAINING', 'CREATE');
}

/** Amending a program, its modules and its assessments. */
export function mayEditPrograms(actor: HrActor): boolean {
  return actor.can('HR_TRAINING', 'EDIT');
}

/**
 * Assigning training to other people.
 *
 * ASSIGN rather than CREATE, following the precedent Lead and Post Sales set:
 * deciding *who owns what work* is a different privilege from doing the work. Here
 * it is sharper still — a bulk department assignment can put several hundred people
 * into a course with a deadline, which is a scheduling decision about other
 * people's time.
 */
export function mayAssignTraining(actor: HrActor): boolean {
  return actor.can('HR_TRAINING', 'ASSIGN');
}

/**
 * Publishing a program, archiving one, and granting qualification.
 *
 * APPROVE, because each commits something. Publishing makes a program assignable to
 * real people; granting qualification clears somebody to do live customer work. The
 * person who writes a course is not automatically the person who may declare
 * somebody ready to use it.
 */
export function mayApproveTraining(actor: HrActor): boolean {
  return actor.can('HR_TRAINING', 'APPROVE');
}

/** Excusing somebody from mandatory training. A decision with a recorded reason. */
export function mayExemptTraining(actor: HrActor): boolean {
  return actor.can('HR_TRAINING', 'APPROVE');
}

// ---------------------------------------------------------------------------
//  The learner's own work
// ---------------------------------------------------------------------------

/**
 * Whether this person may act *as* the learner on an enrollment — start a module,
 * sit an assessment, submit a practical.
 *
 * Only the learner themselves, and that is the whole rule. Not their manager, not
 * an HR administrator, not anybody holding every grant in the system: somebody else
 * sitting a test on your behalf makes the result a fiction, and the record would
 * then say you passed something you never took.
 *
 * So there is deliberately no override here. An HR user who needs a result changed
 * has the exemption endpoint, which records who excused whom and why.
 */
export function mayActAsLearner(
  actor: HrActor,
  enrollment: { employeeId: string },
): boolean {
  return actor.employeeId !== null && actor.employeeId === enrollment.employeeId;
}

/**
 * Whether this person may read an attempt's answers and per-question correctness.
 *
 * The learner, their manager, or a training reader. An ordinary colleague cannot,
 * whatever else they hold — a wrong answer is personal, and a list of somebody's
 * mistakes is not organisational information.
 */
export function mayViewAttemptDetail(
  scope: TrainingScope,
  attempt: { employeeId: string; managerId: string | null },
): boolean {
  return mayViewLearner(scope, {
    employeeId: attempt.employeeId,
    managerId: attempt.managerId,
  });
}

// ---------------------------------------------------------------------------
//  Independent review
// ---------------------------------------------------------------------------

/**
 * Whether this person may review a practical submission.
 *
 * **Never the learner, whatever else they hold.** That check comes first and has no
 * exception: an independent review is the entire value of the gate, and a
 * self-approval is not a review at all. It is the same principle
 * `decidesOwnAction` encodes for approvals and `mayDecideProbation` for probations.
 *
 * Beyond that: the assigned reviewer, or anybody who may edit training. The second
 * is needed because a reviewer may leave, go on leave, or never have been assigned —
 * and a submission nobody can review is a learner stuck indefinitely.
 */
export function mayReviewPractical(
  actor: HrActor,
  submission: { learnerEmployeeId: string; reviewerId: string | null },
): boolean {
  // First, and without exception.
  if (actor.employeeId !== null && actor.employeeId === submission.learnerEmployeeId) {
    return false;
  }

  if (mayEditPrograms(actor)) return true;

  return actor.employeeId !== null && submission.reviewerId === actor.employeeId;
}

/**
 * Whether this person may sign off a shadowing period.
 *
 * The same shape and the same first rule: never the learner. Then the assigned
 * mentor, or a training editor — because an unassigned or departed mentor must not
 * leave somebody permanently unable to finish.
 */
export function maySignOffShadowing(
  actor: HrActor,
  record: { learnerEmployeeId: string; mentorId: string | null },
): boolean {
  if (actor.employeeId !== null && actor.employeeId === record.learnerEmployeeId) {
    return false;
  }

  if (mayEditPrograms(actor)) return true;

  return actor.employeeId !== null && record.mentorId === actor.employeeId;
}

/**
 * Whether this person may grant live-work qualification to a learner.
 *
 * APPROVE, and never to themselves. Declaring yourself ready for live customer work
 * is the clearest possible case of deciding your own action, and the gate exists
 * precisely so that somebody other than the learner looks at the evidence.
 */
export function mayGrantQualification(
  actor: HrActor,
  enrollment: { employeeId: string },
): boolean {
  if (actor.employeeId !== null && actor.employeeId === enrollment.employeeId) {
    return false;
  }
  return mayApproveTraining(actor);
}

/**
 * Whether this person may revoke a qualification.
 *
 * As consequential as granting it — it withdraws somebody's clearance to do the job
 * — so it carries the same requirement, including the self-exclusion.
 */
export function mayRevokeQualification(
  actor: HrActor,
  enrollment: { employeeId: string },
): boolean {
  return mayGrantQualification(actor, enrollment);
}
