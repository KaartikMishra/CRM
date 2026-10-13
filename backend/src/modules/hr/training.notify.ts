/**
 * Training notifications, on the existing infrastructure.
 *
 * No second notification system, no second WebSocket, no second retention policy.
 * `persist` writes the rows inside a transaction and `deliver` pushes them to
 * whoever is connected, exactly as `hr.notify.ts` and `recruitment.notify.ts` do.
 * This module only decides *when* a training event is worth telling somebody about.
 *
 * ### Why only five events
 *
 * Each has a named recipient who owes an action: a learner given mandatory work
 * with a deadline, a deadline that has passed, a reviewer owing a decision, a
 * mentor owing a sign-off, somebody cleared for live work.
 *
 * The bulk of the module raises nothing, deliberately. Completing a lesson, starting
 * an attempt, passing one test of thirteen — the learner did it and can see it on
 * their own page. A notice per module would put a dozen behind every induction and
 * teach everybody to ignore the bell, which costs these five their entire value.
 * This CRM already carries roughly 35,590 SALES_ORDER_CREATED rows as a standing
 * reminder of what that looks like.
 *
 * ### Failing a test raises nothing, and that is deliberate
 *
 * The learner already knows — they just saw the result. A notification row saying
 * "you failed the knowledge test" is a record of somebody's failure sitting in a
 * table a colleague might glance at over their shoulder, with a 30-day retention and
 * no access control beyond the recipient. The page says it privately instead.
 *
 * ### Nothing confidential crosses the wire
 *
 * No score, no percentage, no pass mark, no reviewer's comments. "Training has been
 * assigned to you" plus a link is the whole message; the page behind it says the
 * rest, to whoever is entitled to read it.
 *
 * ### Failures never fail the write
 *
 * Every function swallows its own errors. The enrollment, the review, the
 * qualification is what matters; if the notice cannot be raised the record still
 * stands and the person sees it on the page.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

type Kind =
  | 'HR_TRAINING_ASSIGNED'
  | 'HR_TRAINING_OVERDUE'
  | 'HR_TRAINING_PRACTICAL_REVIEW_DUE'
  | 'HR_TRAINING_SHADOWING_SIGNOFF_DUE'
  | 'HR_TRAINING_QUALIFIED';

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
      'Failed to raise training notification',
    );
  }
}

/**
 * Training has been assigned.
 *
 * To the learner, and only for **mandatory** work — the service decides that. An
 * optional course appearing on their page is enough; a notification for something
 * nobody has to do is the first step towards a bell nobody reads.
 */
export async function notifyTrainingAssigned(
  learnerUserId: string,
  enrollmentId: string,
  isMandatory: boolean,
): Promise<void> {
  await raise(
    [learnerUserId],
    'HR_TRAINING_ASSIGNED',
    {
      entityType: 'TrainingEnrollment',
      entityId: enrollmentId,
      href: `/hr/training/my-learning`,
    },
    isMandatory ? 'Required training assigned' : 'Training assigned',
    isMandatory
      ? 'Training has been assigned to you with a deadline — open My Learning to start'
      : 'Training has been assigned to you — open My Learning to start',
  );
}

/**
 * A deadline has passed.
 *
 * To the learner and, where they have one, their manager. Two recipients because a
 * learner who has already ignored the first notice is not the person most likely to
 * act on the second — and a manager cannot otherwise discover that their report is
 * behind on mandatory work.
 */
export async function notifyTrainingOverdue(
  recipientUserIds: readonly string[],
  enrollmentId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_TRAINING_OVERDUE',
    {
      entityType: 'TrainingEnrollment',
      entityId: enrollmentId,
      href: `/hr/training/my-learning`,
    },
    'Training is overdue',
    'Assigned training has passed its due date',
  );
}

/**
 * A practical submission is waiting for a decision.
 *
 * To the reviewer. They cannot discover this by re-reading a page they have no
 * reason to open, and a learner blocked on an unreviewed practical is blocked
 * indefinitely — this is the clearest "somebody else is waiting on you" in the
 * module.
 */
export async function notifyPracticalReviewDue(
  reviewerUserId: string,
  practicalId: string,
): Promise<void> {
  await raise(
    [reviewerUserId],
    'HR_TRAINING_PRACTICAL_REVIEW_DUE',
    {
      entityType: 'PracticalSubmission',
      entityId: practicalId,
      href: '/hr/training/practical',
    },
    'A practical exercise needs your review',
    'Somebody has submitted a practical exercise for you to review',
  );
}

/** A shadowing period is waiting on its mentor's sign-off. */
export async function notifyShadowingSignOffDue(
  mentorUserId: string,
  shadowingId: string,
): Promise<void> {
  await raise(
    [mentorUserId],
    'HR_TRAINING_SHADOWING_SIGNOFF_DUE',
    {
      entityType: 'ShadowingRecord',
      entityId: shadowingId,
      href: '/hr/training/shadowing',
    },
    'A shadowing period needs your sign-off',
    'A shadowing period you are mentoring is ready to be signed off',
  );
}

/**
 * Somebody has been cleared for live work.
 *
 * To the learner and their manager. This is the one piece of good news in the set,
 * and it is also operationally load-bearing: the manager needs to know their report
 * may now take live customer work, and nothing else would tell them.
 *
 * The score is deliberately absent from the body — "qualified" is the fact that
 * matters, and the number is on the page.
 */
export async function notifyQualified(
  recipientUserIds: readonly string[],
  qualificationId: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_TRAINING_QUALIFIED',
    {
      entityType: 'TrainingQualification',
      entityId: qualificationId,
      href: '/hr/training/qualification',
    },
    'Qualified for live work',
    'Training is complete and live work is now cleared',
  );
}
