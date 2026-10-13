/**
 * Who may see and change what in recruitment, as pure functions.
 *
 * Capability — may this person reach the module at all — is decided by
 * `requirePermission` in the route table using the existing two-layer resolver.
 * What is left is *scope*, and recruitment's scope question is different in kind
 * from the two HR phases before it.
 *
 * ### Why recruitment's scope is not the employee scope
 *
 * Phases 1 and 2 scope by *whose record it is*: your own, your reports', or
 * everybody's. That model does not fit here, because a candidate is nobody's
 * report and has no employee record to be the subject of. What matters instead is
 * **whether you are working on this hire**: the recruiter running it, the hiring
 * manager who owns the vacancy, and the interviewers booked onto its conversations.
 *
 * So the populations are:
 *
 *   Recruiters / HR     hold HR_RECRUITMENT:VIEW. Every requisition, candidate and
 *                       application. Running recruitment means seeing the pipeline.
 *   Hiring managers     own a requisition, or are named on an application, without
 *                       holding the module. They see their own vacancies and the
 *                       people applying to them — and nothing about other roles.
 *   Interviewers        are booked onto an interview. They see the application they
 *                       are interviewing against, so they can prepare, and they
 *                       see it *narrowly* — see `interviewerVisibleFields` below.
 *   Everybody else      nothing, and gets the module's 403 from the route table
 *                       before reaching any of this.
 *
 * ### The confidentiality rule that actually matters
 *
 * An interviewer must not read the other interviewers' feedback before giving
 * their own, and must never read a background-check result or a salary figure.
 *
 * The first is not pedantry: it is the entire reason structured interviewing
 * exists. An interviewer who reads "the last two said no" has been told the
 * answer, and the panel has become one opinion wearing four hats. So feedback is
 * filtered by author until the interview is complete, and the filter lives here as
 * a pure function rather than as a `select` buried in a repository, because it is
 * a rule somebody should be able to read and test.
 *
 * The second is a straightforward confidentiality boundary. A verification result
 * — "this employment claim could not be confirmed" — is exactly the sort of fact
 * that ends somebody's prospects, and only the people accountable for the decision
 * should hold it.
 *
 * Pure functions with no database access, following `hr-access.ts` and
 * `attendance-access.ts`. The facts these need from the database (does this person
 * own that requisition, are they on that interview) are resolved once per request
 * by the service and passed in — a policy that queries cannot be unit-tested, and
 * these are the rules most worth testing.
 */

import type { HrActor } from './hr-access.js';

/**
 * What a person may reach in recruitment.
 *
 *   all          every requisition, candidate and application
 *   involved     only the hires they are working on, identified by the
 *                requisition and application ids resolved for this request
 *   none         nothing
 *
 * A union rather than booleans, so an exhaustive switch breaks at compile time
 * when a variant is added — the same reasoning as HrScope and HrRecordScope.
 */
export type RecruitmentScope =
  | { kind: 'all' }
  | {
      kind: 'involved';
      /** This person's own Employee id — they are involved *as* an employee. */
      employeeId: string;
      /** Requisitions they own as hiring manager or run as recruiter. */
      jobRequisitionIds: readonly string[];
      /** Applications they are named on, or booked to interview. */
      applicationIds: readonly string[];
    }
  | { kind: 'none' };

/**
 * The involvement facts, resolved per request.
 *
 * Passed in rather than derived, because every field is a database question and
 * this file is pure.
 */
export type RecruitmentInvolvement = {
  jobRequisitionIds: readonly string[];
  applicationIds: readonly string[];
};

export function recruitmentScope(
  actor: HrActor,
  involvement: RecruitmentInvolvement,
): RecruitmentScope {
  // The module permission, never the role. An administrator holds HR_RECRUITMENT
  // by role default, and a per-user override that revokes it must actually
  // revoke it — the same reasoning the other two access files apply.
  if (actor.can('HR_RECRUITMENT', 'VIEW')) return { kind: 'all' };

  if (
    actor.employeeId &&
    (involvement.jobRequisitionIds.length > 0 || involvement.applicationIds.length > 0)
  ) {
    return {
      kind: 'involved',
      employeeId: actor.employeeId,
      jobRequisitionIds: involvement.jobRequisitionIds,
      applicationIds: involvement.applicationIds,
    };
  }

  return { kind: 'none' };
}

/**
 * The scope as a Prisma filter on JobRequisition, to be ANDed with the query.
 *
 * `none` returns a filter matching nothing rather than throwing, so a
 * permitted-but-uninvolved reader sees an empty board instead of an error. The
 * impossible-id form is deliberate and is copied from `visibleEmployeeFilter` for
 * the same reason: there is no Prisma equivalent of `false`, and `{}` would match
 * everything — the exact mistake this guards against.
 */
export function visibleJobFilter(scope: RecruitmentScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'involved':
      return { id: { in: [...scope.jobRequisitionIds] } };
    case 'none':
      return { id: '__no_job_matches_this__' };
  }
}

/**
 * The scope as a Prisma filter on Application.
 *
 * An involved person reaches an application two ways: it is on a requisition they
 * own, or they are personally named on it. Both are ORed because either is
 * sufficient — a hiring manager sees everybody applying to their vacancy, and an
 * interviewer sees the one application they were booked against even on a role
 * they do not own.
 */
export function visibleApplicationFilter(scope: RecruitmentScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'involved':
      return {
        OR: [
          { id: { in: [...scope.applicationIds] } },
          { jobRequisitionId: { in: [...scope.jobRequisitionIds] } },
        ],
      };
    case 'none':
      return { id: '__no_application_matches_this__' };
  }
}

/**
 * The scope as a Prisma filter on Candidate.
 *
 * A candidate is reachable through the applications in reach, never directly: the
 * candidate *directory* is a recruiter's tool, and an interviewer who may read one
 * application has no business browsing everybody the business has ever
 * considered. So an involved person gets a relation filter and not an id list.
 */
export function visibleCandidateFilter(scope: RecruitmentScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'involved':
      return { applications: { some: visibleApplicationFilter(scope) } };
    case 'none':
      return { id: '__no_candidate_matches_this__' };
  }
}

export function mayViewRecruitment(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'VIEW');
}

/** Creating requisitions, candidates and applications. */
export function mayCreateRecruitment(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'CREATE');
}

/** Amending them, and moving an application through the assessment stages. */
export function mayEditRecruitment(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'EDIT');
}

/**
 * The decisions that commit the business, or end somebody's prospects.
 *
 * Selecting a candidate, issuing or withdrawing an offer, recording a
 * verification result, deciding a probation. APPROVE rather than EDIT because
 * these are different in kind from amending a job description: each one is a
 * commitment somebody is accountable for, and the person who writes the
 * requisition is not automatically the person who may make an offer against it.
 */
export function mayDecideRecruitment(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'APPROVE');
}

/**
 * Whether this person may read background-check results.
 *
 * Stricter than reading the application, and deliberately not granted by
 * involvement. An interviewer and even a hiring manager may be working on a hire
 * without being entitled to "this employment claim could not be confirmed" — that
 * is a fact about somebody's history which only the people accountable for the
 * hiring decision should hold. The practical effect is that an interviewer sees
 * who they are meeting and not what a verification agency said about them.
 */
export function mayViewBackgroundChecks(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'VIEW');
}

/**
 * Whether this person may read the figures on a requisition or an offer.
 *
 * Informational though they are, an advertised range and a communicated package
 * are not an interviewer's business. Gated on VIEW — holding the module — rather
 * than on involvement, so a hiring manager without the module sees the role they
 * own without seeing what it pays.
 */
export function mayViewCompensation(actor: HrActor): boolean {
  return actor.can('HR_RECRUITMENT', 'VIEW');
}

/**
 * Which interview feedback this person may read.
 *
 * The rule that protects the integrity of a panel:
 *
 *   - A recruiter or HR reader (`all`) sees everything. Somebody has to be able to
 *     compare the panel's views; that is what the decision is made from.
 *   - Anybody else sees **their own feedback always**, and other people's **only
 *     once they have submitted their own**. Not "once the interview is complete":
 *     the contaminating moment is forming the opinion, so the gate is having
 *     committed to one.
 *
 * Returning the predicate rather than the filtered list keeps this pure and lets
 * the caller apply it to whatever shape it holds.
 */
export function feedbackVisibility(
  scope: RecruitmentScope,
  context: {
    /** The reading employee's own id, where they have one. */
    viewerEmployeeId: string | null;
    /** Whether the viewer has already submitted feedback on this interview. */
    viewerHasSubmitted: boolean;
  },
): (feedback: { employeeId: string }) => boolean {
  if (scope.kind === 'all') return () => true;

  const { viewerEmployeeId, viewerHasSubmitted } = context;
  if (viewerEmployeeId === null) return () => false;

  return (feedback) =>
    feedback.employeeId === viewerEmployeeId || viewerHasSubmitted;
}

/**
 * Whether somebody may give feedback on an interview.
 *
 * Only the people actually on it — the lead or a participant. Not the recruiter,
 * however senior: feedback is a first-hand account of a conversation, and a row
 * saying otherwise would make the panel's record untrue.
 */
export function mayGiveInterviewFeedback(
  actor: HrActor,
  interview: { interviewerId: string | null; participantEmployeeIds: readonly string[] },
): boolean {
  if (actor.employeeId === null) return false;
  return (
    interview.interviewerId === actor.employeeId ||
    interview.participantEmployeeIds.includes(actor.employeeId)
  );
}

/**
 * Whether somebody may decide this probation.
 *
 * The reporting manager or an HR_RECRUITMENT approver — and never the employee
 * themselves, whatever else they hold. Confirming your own probation is the
 * clearest possible case of deciding your own action, and the same principle
 * `decidesOwnAction` encodes for approvals applies here.
 */
export function mayDecideProbation(
  actor: HrActor,
  probation: { employeeId: string; managerId: string | null },
): boolean {
  if (actor.employeeId !== null && actor.employeeId === probation.employeeId) return false;
  if (mayDecideRecruitment(actor)) return true;
  return actor.employeeId !== null && probation.managerId === actor.employeeId;
}

/**
 * Whether somebody may act on an onboarding task.
 *
 * The assignee, or anybody who may edit recruitment. A task with no assignee is
 * HR's by default — an unassigned laptop request still has to be closeable, and
 * leaving it actionable by nobody would mean a checklist that cannot finish.
 */
export function mayCompleteOnboardingTask(
  actor: HrActor,
  task: { assigneeId: string | null },
): boolean {
  if (mayEditRecruitment(actor)) return true;
  if (task.assigneeId === null) return false;
  return actor.employeeId !== null && task.assigneeId === actor.employeeId;
}
