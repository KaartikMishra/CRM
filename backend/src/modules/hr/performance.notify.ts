/**
 * Performance notifications, on the existing infrastructure.
 *
 * No second notification system, no second WebSocket, no second retention policy.
 * `persist` writes the rows inside a transaction and `deliver` pushes them to
 * whoever is connected, exactly as `hr.notify.ts`, `recruitment.notify.ts` and
 * `training.notify.ts` do. This module only decides *when* a performance event is
 * worth telling somebody about.
 *
 * ### Why only five events
 *
 * Each has a named recipient who owes an action, or is being told something about
 * themselves they could not otherwise know:
 *
 *   a cycle opened        everybody in scope now owes a self-assessment with a
 *                         deadline they did not know was coming
 *   self-assessment due   a deadline the employee owns
 *   manager review due    a deadline a manager owns on somebody else's behalf,
 *                         which is the one most easily forgotten
 *   review finalised      the employee's appraisal is locked
 *   improvement plan      a formal plan now exists about them
 *
 * ### What raises nothing, and why
 *
 * Saving a draft assessment, submitting one, rating a competency, recording KPI
 * progress, closing a goal. Each is an author acting on their own work: the person
 * already knows, and a notice per action would put a dozen behind every appraisal
 * and teach everybody to ignore the bell — which costs these five their entire
 * value. This CRM already carries roughly 35,590 `SALES_ORDER_CREATED` rows as a
 * standing reminder of what that looks like.
 *
 * ### Finalisation notifies the employee, and that is the point
 *
 * The one case where somebody is told about a decision rather than asked for an
 * action. An appraisal that has been locked is a decision made about somebody that
 * they can no longer influence, and learning about it by chance — or not at all —
 * is worse than being told plainly. So this one fires even though nothing is owed.
 *
 * ### Nothing confidential crosses the wire
 *
 * No rating, no score, no attainment figure, no comment text, no promotion
 * recommendation. "Your review has been finalised" plus a link is the whole
 * message; the page behind it says the rest, to whoever is entitled to read it.
 *
 * A notification row has a 30-day retention and no access control beyond the
 * recipient. Putting a rating in the body would mean somebody's appraisal score
 * sitting in a table a colleague might glance at over their shoulder.
 *
 * ### Failures never fail the write
 *
 * Every function swallows its own errors. The cycle, the review, the plan is what
 * matters; if the notice cannot be raised the record still stands and the person
 * sees it on the page.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

type Kind =
  | 'HR_REVIEW_CYCLE_OPENED'
  | 'HR_SELF_ASSESSMENT_DUE'
  | 'HR_MANAGER_REVIEW_DUE'
  | 'HR_REVIEW_FINALIZED'
  | 'HR_IMPROVEMENT_PLAN_OPENED';

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
      'Failed to raise performance notification',
    );
  }
}

/**
 * A review cycle has opened.
 *
 * To everybody with a review in it who has a login. One notification each rather
 * than one per review stage, because the rest of the cycle is visible on their own
 * page and the opening is the only moment they could not have anticipated.
 *
 * The deadline is not in the body: it is on the cycle, it may be amended, and a
 * notification is a durable row that would then be wrong.
 */
export async function notifyCycleOpened(
  recipientUserIds: readonly string[],
  cycleId: string,
  cycleName: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_REVIEW_CYCLE_OPENED',
    { entityType: 'ReviewCycle', entityId: cycleId, href: '/hr/performance/my-review' },
    'Performance review opened',
    `${cycleName} is now open — open My Review to write your self-assessment`,
  );
}

/** A self-assessment deadline. To the employee. */
export async function notifySelfAssessmentDue(
  employeeUserId: string,
  reviewId: string,
): Promise<void> {
  await raise(
    [employeeUserId],
    'HR_SELF_ASSESSMENT_DUE',
    { entityType: 'PerformanceReview', entityId: reviewId, href: '/hr/performance/my-review' },
    'Self-assessment due',
    'Your self-assessment is due — open My Review to complete it',
  );
}

/**
 * A manager review is owed.
 *
 * To the reviewer. Raised when the employee submits their half, because that is the
 * moment the manager's work becomes possible — and it is the deadline most easily
 * forgotten, since it is owed on somebody else's behalf.
 *
 * The employee is not named in the body. A reviewer with several reports would
 * benefit, but the row is readable only by the recipient and naming somebody makes
 * the notification itself a record of who is being appraised when. The link goes to
 * the queue, which names them to the person entitled to see it.
 */
export async function notifyManagerReviewDue(
  reviewerUserId: string,
  reviewId: string,
): Promise<void> {
  await raise(
    [reviewerUserId],
    'HR_MANAGER_REVIEW_DUE',
    { entityType: 'PerformanceReview', entityId: reviewId, href: '/hr/performance/reviews' },
    'Review waiting on you',
    'A team member has submitted their self-assessment — their review is waiting on you',
  );
}

/**
 * A review has been finalised.
 *
 * To the employee. The one notification here that reports a decision rather than
 * requesting an action, and it fires precisely because the employee can no longer
 * influence the outcome — being told plainly is better than finding out later.
 *
 * **No rating in the body.** The figure is on the page, behind authentication and
 * the access policy.
 */
export async function notifyReviewFinalized(
  employeeUserId: string,
  reviewId: string,
): Promise<void> {
  await raise(
    [employeeUserId],
    'HR_REVIEW_FINALIZED',
    { entityType: 'PerformanceReview', entityId: reviewId, href: '/hr/performance/my-review' },
    'Your review has been finalised',
    'Your performance review has been completed and finalised — open My Review to read it',
  );
}

/**
 * A formal improvement plan has been opened.
 *
 * To the employee. GROWTH plans raise nothing: they are usually agreed in the
 * conversation that created them, and a notification would make a development
 * opportunity feel like a disciplinary step.
 *
 * An IMPROVEMENT plan is different — it is a formal process with consequences and a
 * review date, and the person it concerns must know it exists rather than discover
 * it. The body says nothing about *why*; that is on the plan, which they can read.
 */
export async function notifyImprovementPlanOpened(
  employeeUserId: string,
  planId: string,
): Promise<void> {
  await raise(
    [employeeUserId],
    'HR_IMPROVEMENT_PLAN_OPENED',
    { entityType: 'DevelopmentPlan', entityId: planId, href: '/hr/performance/plans' },
    'Development plan created',
    'A development plan has been created with you — open Plans to read it',
  );
}
