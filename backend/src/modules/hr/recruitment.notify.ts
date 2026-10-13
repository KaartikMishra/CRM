/**
 * Recruitment, onboarding and probation notifications, on the existing
 * infrastructure.
 *
 * No second notification system, no second WebSocket, no second retention policy.
 * `persist` writes the rows inside a transaction and `deliver` pushes them to
 * whoever is connected, exactly as `hr.notify.ts`, Post Sales and Dispatch already
 * do. This module only decides *when* a Phase 3 event is worth telling somebody.
 *
 * ### Why only five events
 *
 * Each has a named recipient with something to do. An interviewer is expected
 * somewhere at a time; a hiring manager is being asked to decide; an onboarding
 * task is owed by a date; a probation review falls due; a probation period is
 * ending and somebody must confirm, extend or terminate before it does.
 *
 * The larger half of the pipeline raises nothing, deliberately. Creating a
 * requisition, receiving an application, moving somebody from SCREENING to
 * SHORTLISTED, sending an offer — the recruiter doing it already knows, and the
 * board is where that state is read. A notification per stage change would put a
 * dozen notices behind every hire and teach everybody to ignore the bell, which
 * costs the five above their entire value. This CRM already carries roughly 35,590
 * SALES_ORDER_CREATED rows as a standing reminder of what that looks like.
 *
 * ### Nothing confidential crosses the wire
 *
 * No candidate name, no role title, no verification result, no probation outcome.
 * A notification row has a 30-day retention and no access control beyond the
 * recipient, and these notices concern people's prospects and employment. "An
 * interview has been scheduled" plus a link is the whole message; the page behind
 * the link says the rest, to whoever is entitled to read it.
 *
 * That is stricter than it looks. "Interview with Priya Sharma for Senior
 * Developer" in a notification row tells anybody glancing at a colleague's screen
 * that Priya is job-hunting — which is exactly the kind of disclosure a candidate
 * would never expect from a system they are not even a user of.
 *
 * ### Failures never fail the write
 *
 * Every function swallows its own errors. The interview, the task, the decision is
 * what matters; if the notice cannot be raised, the record still stands and the
 * person sees it on the page. Mirrors `hr.notify.ts` and the audit service.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

type Kind =
  | 'HR_INTERVIEW_SCHEDULED'
  | 'HR_APPLICATION_DECISION_REQUIRED'
  | 'HR_ONBOARDING_TASK_ASSIGNED'
  | 'HR_PROBATION_REVIEW_DUE'
  | 'HR_PROBATION_ENDING';

async function raise(
  recipientIds: readonly string[],
  type: Kind,
  entity: { entityType: string; entityId: string; href: string },
  title: string,
  body: string,
): Promise<void> {
  const unique = [...new Set(recipientIds)];
  if (unique.length === 0) return;

  try {
    await prisma.$transaction((tx) =>
      persist(tx, unique, {
        type,
        title,
        body,
        href: entity.href,
        entityType: entity.entityType,
        entityId: entity.entityId,
      }),
    );
    await deliver(unique, type, entity.entityId);
  } catch (error) {
    logger.error(
      { err: error, type, entityId: entity.entityId },
      'Failed to raise recruitment notification',
    );
  }
}

/**
 * An interview has been booked, or moved.
 *
 * To the lead and every participant, because being expected somewhere at a time is
 * the clearest case in this module of something somebody must act on and cannot
 * otherwise discover. Deliberately carries neither the candidate's name nor the
 * role — see the note at the top of this file.
 */
export async function notifyInterviewScheduled(
  recipientUserIds: readonly string[],
  interviewId: string,
  applicationId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_INTERVIEW_SCHEDULED',
    {
      entityType: 'Interview',
      entityId: interviewId,
      href: `/hr/recruitment/applications/${applicationId}`,
    },
    'Interview scheduled',
    'You are on the panel for an interview — open it for the time and details',
  );
}

/**
 * A hiring manager is being asked to decide.
 *
 * Raised when an application reaches a point where somebody other than the
 * recruiter has to act: the panel has finished and a selection decision is owed.
 * This is the one pipeline event that gets a notice, because it is the one where
 * the pipeline stops until a named person moves it.
 */
export async function notifyApplicationDecisionRequired(
  recipientUserIds: readonly string[],
  applicationId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_APPLICATION_DECISION_REQUIRED',
    {
      entityType: 'Application',
      entityId: applicationId,
      href: `/hr/recruitment/applications/${applicationId}`,
    },
    'A hiring decision is waiting',
    'An application is ready for your decision',
  );
}

/**
 * Somebody owes an onboarding task.
 *
 * To the assignee. An IT colleague who must prepare a laptop by Monday cannot find
 * that out by re-reading a checklist they have no reason to open, which is exactly
 * the test these five notices have to pass.
 */
export async function notifyOnboardingTaskAssigned(
  assigneeUserId: string,
  taskId: string,
  onboardingId: string,
): Promise<void> {
  await raise(
    [assigneeUserId],
    'HR_ONBOARDING_TASK_ASSIGNED',
    {
      entityType: 'OnboardingTask',
      entityId: taskId,
      href: `/hr/onboarding/${onboardingId}`,
    },
    'An onboarding task is assigned to you',
    'A task on a new joiner’s onboarding is waiting for you',
  );
}

/**
 * A probation review has fallen due.
 *
 * To the reviewing manager. A 30-day review nobody was reminded of is a review
 * that happens on day 50, and the point of a schedule is that the dates arrive
 * whether or not anybody is watching the calendar.
 */
export async function notifyProbationReviewDue(
  reviewerUserId: string,
  reviewId: string,
  probationId: string,
): Promise<void> {
  await raise(
    [reviewerUserId],
    'HR_PROBATION_REVIEW_DUE',
    {
      entityType: 'ProbationReview',
      entityId: reviewId,
      href: `/hr/probation/${probationId}`,
    },
    'A probation review is due',
    'A scheduled probation review is now due',
  );
}

/**
 * A probation period is ending.
 *
 * To the manager and to HR. This is the most consequential deadline in the module:
 * a probation that lapses undecided leaves somebody's employment in an undefined
 * state, which is unfair to them and a liability for the business. Raised to two
 * recipients for that reason — a single addressee on leave means nobody acts.
 */
export async function notifyProbationEnding(
  recipientUserIds: readonly string[],
  probationId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_PROBATION_ENDING',
    {
      entityType: 'ProbationRecord',
      entityId: probationId,
      href: `/hr/probation/${probationId}`,
    },
    'A probation period is ending',
    'A probation period ends soon and needs a decision',
  );
}
