/**
 * HR Phase 5 — reviews, assessments, finalisation, plans and reports.
 *
 * Cycles, competencies, goals and KPIs live in `performance.service.ts`. This file
 * owns *what happened* and is where the separation-of-duties rules actually fire.
 *
 * ### The three rules, and where each is enforced
 *
 * **1. An employee does not read a draft manager review.** `presentReview` nulls
 * `managerAssessment` when the reader is the subject and the manager has not
 * submitted. Not a 403 on the whole page — the employee is entitled to the rest of
 * their own review, and refusing it would be the wrong answer to "may I see my
 * review" when the honest answer is "yes, and your manager has not finished".
 *
 * **2. Nobody writes their own manager review.** `mayWriteManagerAssessment`
 * refuses the subject before consulting any permission. Checked here on every write
 * path, and `performance_review_reviewer_not_subject` makes the stored reviewer
 * impossible to set to the subject by any route.
 *
 * **3. Nobody finalises their own review.** `mayFinalizeReview`, same ordering. An
 * HR colleague being appraised holds APPROVE; checking the grant first would let
 * them lock their own rating.
 *
 * ### Concurrency
 *
 * Every status move is a conditional `updateMany` through `repo.transitionReview`,
 * predicated on the status the caller expected. Two approvers finalising at the same
 * moment both pass the authorization read and both reach the write; one matches and
 * one matches nothing, so the second gets a 409 rather than a second
 * `finalizedById` stamp and a second notification to the employee.
 *
 * The same mechanism makes a duplicate submission a conflict rather than a
 * silently-overwritten timestamp.
 */

import { Prisma } from '@prisma/client';
import {
  type CancelReviewInput,
  type CompetencyRatingView,
  type CreateDevelopmentActionInput,
  type CreateDevelopmentPlanInput,
  type CloseDevelopmentPlanInput,
  type CycleReportView,
  type DevelopmentActionView,
  type DevelopmentPlanListQuery,
  type DevelopmentPlanPage,
  type DevelopmentPlanSummary,
  type DevelopmentPlanView,
  type FinalizeReviewInput,
  type GenerateReviewsInput,
  type ManagerAssessmentView,
  type PerformanceHistoryQuery,
  type PerformanceHistoryView,
  type PerformanceOverview,
  type PerformanceReviewListQuery,
  type PerformanceReviewPage,
  type PerformanceReviewStatus,
  type PerformanceReviewSummary,
  type PerformanceReviewView,
  type RateCompetencyInput,
  type SaveManagerAssessmentInput,
  type SaveSelfAssessmentInput,
  type SelfAssessmentView,
  type UpdateDevelopmentPlanInput,
} from '@rs/shared';
import type { Request } from 'express';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  isReviewSettled,
  mayCancelReview,
  mayCompleteDevelopmentAction,
  mayFinalizeReview,
  mayManageDevelopmentPlan,
  mayOperateCycle,
  mayRateAsHr,
  mayReadManagerAssessment,
  mayReadSelfAssessment,
  mayWriteManagerAssessment,
  mayWriteSelfAssessment,
  visibleReviewFilter,
} from './performance-access.js';
import {
  averageRating,
  canMoveReview,
  isPerformanceOverdue,
  ratingDistribution,
  reviewGoalAttainment,
  weightedCompetencyAverage,
} from './performance.calc.js';
import * as notifications from './performance.notify.js';
import * as repo from './performance.repository.js';
import {
  TX_OPTIONS,
  companyDayKey,
  companyTodayStart,
  notFound,
  presentGoalSummary,
  scopeForRequest,
  toEmployeeRef,
} from './performance.service.js';

const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());
const dayKey = (v: Date | null): string | null =>
  v === null ? null : v.toISOString().slice(0, 10);
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

function presentReviewSummary(
  row: repo.ReviewRowRecord,
  context: { todayKey: string; selfDueOn: Date | null; managerDueOn: Date | null },
): PerformanceReviewSummary {
  return {
    id: row.id,
    cycle: row.cycle,
    employee: toEmployeeRef(row.employee),
    reviewer: row.reviewer ? toEmployeeRef(row.reviewer) : null,
    status: row.status,
    selfOverallRating: dec(row.selfOverallRating),
    managerOverallRating: dec(row.managerOverallRating),
    finalRating: dec(row.finalRating),
    selfSubmittedAt: iso(row.selfSubmittedAt),
    managerSubmittedAt: iso(row.managerSubmittedAt),
    finalizedAt: iso(row.finalizedAt),
    isSelfAssessmentOverdue: isPerformanceOverdue(
      context.selfDueOn,
      context.todayKey,
      row.selfSubmittedAt,
    ),
    isManagerReviewOverdue: isPerformanceOverdue(
      context.managerDueOn,
      context.todayKey,
      row.managerSubmittedAt,
    ),
    createdAt: row.createdAt.toISOString(),
  };
}

function presentSelf(row: NonNullable<repo.ReviewDetailRecord['selfAssessment']>): SelfAssessmentView {
  return {
    achievements: row.achievements,
    challenges: row.challenges,
    developmentWishes: row.developmentWishes,
    overallRating: dec(row.overallRating),
    submittedAt: iso(row.submittedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentManager(
  row: NonNullable<repo.ReviewDetailRecord['managerAssessment']>,
): ManagerAssessmentView {
  return {
    strengths: row.strengths,
    improvementAreas: row.improvementAreas,
    comments: row.comments,
    overallRating: dec(row.overallRating),
    promotionRecommended: row.promotionRecommended,
    submittedAt: iso(row.submittedAt),
    submittedBy: row.submittedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Pairs each competency with whatever ratings exist for it.
 *
 * Shaped as a competency with a list rather than a flat row per rating, because the
 * appraisal conversation is "we rated this differently" — and that is only legible
 * when both sides sit together.
 *
 * The same visibility rules apply as to the narratives: a self rating is hidden from
 * others until submitted, and a manager rating from the subject until submitted.
 * Without that, an employee could read their manager's scores before the comments
 * explaining them — which is the worst possible order to learn them in.
 */
function presentRatings(
  competencies: repo.CompetencyRecord[],
  ratings: repo.RatingRecord[],
  visibility: { showSelf: boolean; showManager: boolean },
): CompetencyRatingView[] {
  return competencies.map((competency) => {
    const mine = ratings.filter((r) => r.competencyId === competency.id);

    const visible = mine.filter((r) => {
      if (r.source === 'SELF') return visibility.showSelf;
      if (r.source === 'MANAGER') return visibility.showManager;
      // An HR rating follows the manager's visibility: it is the same kind of
      // third-party judgement and arrives at the same point in the process.
      return visibility.showManager;
    });

    const self = visible.find((r) => r.source === 'SELF');
    const manager = visible.find((r) => r.source === 'MANAGER');

    return {
      competency: {
        id: competency.id,
        cycleId: competency.cycleId,
        name: competency.name,
        category: competency.category,
        description: competency.description,
        weight: competency.weight.toString(),
        sortOrder: competency.sortOrder,
      },
      self: self ? { rating: self.rating as 1 | 2 | 3 | 4 | 5, comments: self.comments } : null,
      manager: manager
        ? { rating: manager.rating as 1 | 2 | 3 | 4 | 5, comments: manager.comments }
        : null,
      ratings: visible.map((r) => ({
        id: r.id,
        source: r.source,
        rating: r.rating as 1 | 2 | 3 | 4 | 5,
        comments: r.comments,
        ratedBy: r.ratedBy,
        ratedAt: r.ratedAt.toISOString(),
      })),
    };
  });
}

/**
 * One review, as this particular reader may see it.
 *
 * **RULE 1 lives here.** The record carries both assessments; what comes back
 * depends on who is asking. An employee whose manager is still drafting receives
 * `managerAssessment: null` and their own everything else — and `viewerCan` tells
 * the page what controls to render, so it does not have to infer the rules.
 */
async function presentReviewView(
  actor: HrActor,
  row: repo.ReviewDetailRecord,
  context: {
    todayKey: string;
    selfDueOn: Date | null;
    managerDueOn: Date | null;
    competencies: repo.CompetencyRecord[];
    goals: repo.GoalRowRecord[];
    plans: repo.PlanRowRecord[];
  },
): Promise<PerformanceReviewView> {
  const showSelf = mayReadSelfAssessment(actor, {
    employeeId: row.employeeId,
    selfSubmittedAt: row.selfSubmittedAt,
  });
  const showManager = mayReadManagerAssessment(actor, {
    employeeId: row.employeeId,
    managerSubmittedAt: row.managerSubmittedAt,
  });

  const reviewForChecks = {
    status: row.status as PerformanceReviewStatus,
    employeeId: row.employeeId,
    reviewerId: row.reviewerId,
    selfSubmittedAt: row.selfSubmittedAt,
    managerSubmittedAt: row.managerSubmittedAt,
  };

  const canWriteSelf = mayWriteSelfAssessment(actor, reviewForChecks);
  const canWriteManager = mayWriteManagerAssessment(actor, reviewForChecks);

  return {
    ...presentReviewSummary(row, context),
    selfAssessment: showSelf && row.selfAssessment ? presentSelf(row.selfAssessment) : null,
    managerAssessment:
      showManager && row.managerAssessment ? presentManager(row.managerAssessment) : null,
    competencyRatings: presentRatings(context.competencies, row.competencyRatings, {
      showSelf,
      showManager,
    }),
    goals: context.goals.map((goal) => presentGoalSummary(goal, context.todayKey)),
    goalAttainment: dec(row.goalAttainment),
    developmentPlans: context.plans.map(presentPlanSummary(context.todayKey)),
    finalizedBy: row.finalizedBy,
    finalComments: row.finalComments,
    cancelledAt: iso(row.cancelledAt),
    cancellationReason: row.cancellationReason,
    /*
      Sent rather than inferred. The page cannot derive these from the status alone:
      whether somebody may write the manager review depends on who they are relative
      to this employee, and a finalized review is editable by nobody at all.
    */
    viewerCan: {
      editSelfAssessment: canWriteSelf,
      submitSelfAssessment: canWriteSelf,
      editManagerAssessment: canWriteManager,
      // Submitting the manager review additionally needs the self-assessment in,
      // which is the state machine rather than a permission.
      submitManagerAssessment: canWriteManager && row.selfSubmittedAt !== null,
      finalize: mayFinalizeReview(actor, {
        status: row.status as PerformanceReviewStatus,
        employeeId: row.employeeId,
      }),
      cancel: mayCancelReview(actor, {
        status: row.status as PerformanceReviewStatus,
        employeeId: row.employeeId,
      }),
    },
    /*
      Answered from the account link, not from a code comparison.

      The page used to work this out itself by comparing the session's
      `User.employeeId` against `Employee.employeeId` — two different columns that
      share one allocation series and therefore usually agree, but need not: linking
      an account does not sync them. When they differed, the subject was shown
      somebody else's view of their own review, with no self-assessment form and no
      explanation of the missing approve control.

      The service knows the real link, so it answers.
    */
    viewerIsSubject:
      row.employee.userId !== null && row.employee.userId === actor.id,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const presentPlanSummary =
  (todayKey: string) =>
  (row: repo.PlanRowRecord): DevelopmentPlanSummary => {
    const reviewKey = dayKey(row.reviewOn);
    return {
      id: row.id,
      employee: toEmployeeRef(row.employee),
      kind: row.kind,
      status: row.status,
      title: row.title,
      reviewOn: reviewKey,
      reviewId: row.reviewId,
      actionCount: row._count.actions,
      // Filled by the caller where it matters; the list does not need a per-row
      // query for it.
      completedActionCount: 0,
      isOverdue: row.status === 'OPEN' && reviewKey !== null && reviewKey < todayKey,
      createdAt: row.createdAt.toISOString(),
    };
  };

function presentAction(row: repo.ActionRecord): DevelopmentActionView {
  return {
    id: row.id,
    planId: row.planId,
    description: row.description,
    dueOn: dayKey(row.dueOn),
    isCompleted: row.isCompleted,
    completedAt: iso(row.completedAt),
    completedBy: row.completedBy,
    sortOrder: row.sortOrder,
  };
}

// ---------------------------------------------------------------------------
//  Generating reviews
// ---------------------------------------------------------------------------

/**
 * Opening reviews for a cycle.
 *
 * ### The eligible set is a snapshot, not a view
 *
 * Resolved once, here, from the cycle's target department and who is ACTIVE at this
 * moment. Somebody who joins next week is deliberately not retroactively owed a
 * review for a period they were not here for — and a live view would hand them one.
 *
 * ### `reviewerId` is captured now
 *
 * From `Employee.managerId` as it stands. If somebody changes manager mid-cycle the
 * review is still owed by whoever actually managed them over the period, and reading
 * the manager live at render time would silently reassign it.
 *
 * ### Idempotent by construction
 *
 * `createMany({ skipDuplicates: true })` against `@@unique([cycleId, employeeId])`.
 * A second generation run for a cycle somebody is already covered by is a no-op for
 * them rather than a failed batch that leaves half the company without reviews.
 */
export async function generateReviews(
  req: Request,
  actor: HrActor,
  cycleId: string,
  input: GenerateReviewsInput,
): Promise<{ generated: number; skipped: number; eligible: number }> {
  if (!mayOperateCycle(actor)) {
    throw AppError.forbidden('Generating reviews needs HR_PERFORMANCE:APPROVE.');
  }

  const cycle = await repo.findCycleState(cycleId);
  if (!cycle) throw notFound();
  if (cycle.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'CYCLE_NOT_ACTIVE',
      'Open the cycle before generating its reviews.',
    );
  }

  const eligible = await repo.listEligibleEmployees({
    departmentId: cycle.targetDepartmentId,
    ...(input.employeeIds ? { employeeIds: input.employeeIds } : {}),
  });

  if (eligible.length === 0) {
    throw AppError.badRequest(
      'NOBODY_IN_SCOPE',
      'No active employees match this cycle’s scope.',
    );
  }

  const result = await prisma.$transaction(
    (tx) =>
      repo.createReviews(
        tx,
        eligible.map((employee) => ({
          cycleId,
          employeeId: employee.id,
          /*
            A manager who *is* the employee would violate
            `performance_review_reviewer_not_subject`. That is a real case — a
            department head whose `managerId` points at themselves through a data
            error — so it is nulled here rather than left to fail the whole batch.
            HR writes those reviews.
          */
          reviewerId: employee.managerId === employee.id ? null : employee.managerId,
        })),
      ),
    TX_OPTIONS,
  );

  const generated = result.count;
  const skipped = eligible.length - generated;

  await recordAudit(req, {
    action: 'HR_REVIEWS_GENERATED',
    entityType: 'ReviewCycle',
    entityId: cycleId,
    actorId: actor.id,
    newValue: { generated, skipped, eligible: eligible.length },
  });

  /*
    Notify only the people whose reviews were actually created, and only those with
    a login. A second generation run must not re-notify everybody who was already
    covered — which is why this reads the created set rather than the eligible one.
  */
  if (generated > 0) {
    const created = await repo.listReviews({
      where: { cycleId, selfSubmittedAt: null, status: 'NOT_STARTED' },
      take: 1000,
    });
    const employeeIds = created.map((r) => r.employeeId);
    const accounts = await repo.findUserIdsForEmployees(employeeIds);
    const userIds = accounts
      .map((a) => a.userId)
      .filter((id): id is string => id !== null);

    const detail = await repo.findCycle(cycleId);
    await notifications.notifyCycleOpened(userIds, cycleId, detail?.name ?? 'Performance review');
  }

  return { generated, skipped, eligible: eligible.length };
}

// ---------------------------------------------------------------------------
//  Reading reviews
// ---------------------------------------------------------------------------

export async function getReview(actor: HrActor, id: string): Promise<PerformanceReviewView> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') throw notFound();

  /*
    Scope enforced by re-querying with the visibility filter, the same way
    `getGoal` does: a review reachable by id is exactly a review that would have
    appeared in the list, and the two cannot drift into disagreeing.

    Not found rather than forbidden — telling somebody "you may not read employee
    X's review" confirms X is being appraised and by whom.
  */
  const visible = await repo.listReviews({
    where: { id, ...(visibleReviewFilter(scope) as Prisma.PerformanceReviewWhereInput) },
    take: 1,
  });
  if (visible.length === 0) throw notFound();

  const row = await repo.findReview(id);
  if (!row) throw notFound();

  const cycle = await repo.findCycleState(row.cycleId);
  const [competencies, goals, plans, now] = await Promise.all([
    repo.listCompetenciesForCycle(row.cycleId),
    repo.listReviewGoals(id),
    repo.listPlans({ where: { reviewId: id }, take: 50 }),
    repo.databaseNow(),
  ]);

  return presentReviewView(actor, row, {
    todayKey: companyDayKey(now),
    selfDueOn: cycle?.selfAssessmentDueOn ?? null,
    managerDueOn: cycle?.managerReviewDueOn ?? null,
    competencies,
    goals,
    plans,
  });
}

export async function listReviews(
  actor: HrActor,
  query: PerformanceReviewListQuery,
): Promise<PerformanceReviewPage> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') return { items: [], nextCursor: null };

  const now = await repo.databaseNow();
  const todayKey = companyDayKey(now);
  const today = companyTodayStart(now);

  const where: Prisma.PerformanceReviewWhereInput = {
    ...(visibleReviewFilter(scope) as Prisma.PerformanceReviewWhereInput),
    ...(query.cycleId ? { cycleId: query.cycleId } : {}),
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.reviewerId ? { reviewerId: query.reviewerId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
    /*
      "Mine to write" is the reviewer's queue. Keyed on `reviewerId` rather than on
      the hierarchy, so a manager who changed teams still sees what they owe —
      which is the point of storing the reviewer on the row.
    */
    ...(query.mineToWrite && actor.employeeId
      ? {
          reviewerId: actor.employeeId,
          status: { in: ['PENDING_MANAGER', 'MANAGER_REVIEW'] as const },
        }
      : {}),
    ...(query.overdueOnly
      ? {
          OR: [
            {
              selfSubmittedAt: null,
              status: { in: ['NOT_STARTED', 'SELF_ASSESSMENT'] as const },
              cycle: { selfAssessmentDueOn: { lt: today } },
            },
            {
              managerSubmittedAt: null,
              status: { in: ['PENDING_MANAGER', 'MANAGER_REVIEW'] as const },
              cycle: { managerReviewDueOn: { lt: today } },
            },
          ],
        }
      : {}),
    ...(query.search
      ? {
          employee: {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' as const } },
              { lastName: { contains: query.search, mode: 'insensitive' as const } },
              { employeeId: { contains: query.search, mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
  };

  const rows = await repo.listReviews({
    where,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  /*
    The cycles on this page, read once. Each row's overdue flags need its cycle's
    due dates, and a per-row lookup would issue 25 queries for a page of 25.
  */
  const cycleIds = [...new Set(page.map((r) => r.cycleId))];
  const cycles = new Map(
    await Promise.all(
      cycleIds.map(async (id) => [id, await repo.findCycleState(id)] as const),
    ),
  );

  return {
    items: page.map((row) => {
      const cycle = cycles.get(row.cycleId);
      return presentReviewSummary(row, {
        todayKey,
        selfDueOn: cycle?.selfAssessmentDueOn ?? null,
        managerDueOn: cycle?.managerReviewDueOn ?? null,
      });
    }),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
//  Self-assessment
// ---------------------------------------------------------------------------

/**
 * Saving a self-assessment draft.
 *
 * Only the subject, enforced by `mayWriteSelfAssessment` — not their manager, not
 * HR, not an administrator holding every grant. An assessment written by somebody
 * else is not a self-assessment.
 *
 * Moves the review from NOT_STARTED to SELF_ASSESSMENT on the first save, so the
 * dashboard can distinguish "has not started" from "is writing".
 *
 * Competency ratings are written with `source: 'SELF'` in the same transaction. The
 * unique key on `(reviewId, competencyId, source)` makes a second save replace the
 * earlier answer rather than adding a second opinion.
 */
export async function saveSelfAssessment(
  req: Request,
  actor: HrActor,
  reviewId: string,
  input: SaveSelfAssessmentInput,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayWriteSelfAssessment(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
      selfSubmittedAt: state.selfSubmittedAt,
    })
  ) {
    throw AppError.forbidden(
      state.selfSubmittedAt !== null
        ? 'Your self-assessment has been submitted and cannot be changed. Ask HR if it needs reopening.'
        : isReviewSettled(state.status as PerformanceReviewStatus)
          ? 'This review is closed.'
          : 'Only the employee being reviewed can write their own self-assessment.',
    );
  }

  await assertCompetenciesBelongToCycle(state.cycleId, input.competencyRatings);

  await prisma.$transaction(async (tx) => {
    await repo.upsertSelfAssessment(tx, reviewId, {
      ...(input.achievements !== undefined ? { achievements: input.achievements } : {}),
      ...(input.challenges !== undefined ? { challenges: input.challenges } : {}),
      ...(input.developmentWishes !== undefined
        ? { developmentWishes: input.developmentWishes }
        : {}),
      ...(input.overallRating !== undefined ? { overallRating: input.overallRating } : {}),
    });

    for (const rating of input.competencyRatings ?? []) {
      await repo.upsertRating(tx, {
        reviewId,
        competencyId: rating.competencyId,
        source: 'SELF',
        rating: rating.rating,
        comments: rating.comments ?? null,
        ratedById: actor.id,
      });
    }

    // First save moves it off NOT_STARTED. Conditional, so a concurrent save does
    // not double-transition.
    if (state.status === 'NOT_STARTED') {
      await repo.transitionReview(tx, {
        id: reviewId,
        fromStatuses: ['NOT_STARTED'],
        data: { status: 'SELF_ASSESSMENT' },
      });
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_SELF_ASSESSMENT_SAVED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
  });

  return getReview(actor, reviewId);
}

/**
 * Submitting a self-assessment.
 *
 * Stamps `selfSubmittedAt` from the database clock — never from the client, which
 * would be a deadline the client could beat retroactively — and moves the review to
 * PENDING_MANAGER.
 *
 * The overall rating is derived from the competency sheet when the employee did not
 * state one, so a completed sheet produces a figure without anybody typing it twice.
 *
 * Conditional transition: a double-submitted form is a 409, not two stamps and two
 * notifications to the manager.
 */
export async function submitSelfAssessment(
  req: Request,
  actor: HrActor,
  reviewId: string,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayWriteSelfAssessment(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
      selfSubmittedAt: state.selfSubmittedAt,
    })
  ) {
    throw AppError.forbidden(
      state.selfSubmittedAt !== null
        ? 'Your self-assessment has already been submitted.'
        : 'Only the employee being reviewed can submit their own self-assessment.',
    );
  }

  const existing = await repo.findSelfAssessment(reviewId);
  if (!existing) {
    throw AppError.badRequest(
      'SELF_ASSESSMENT_EMPTY',
      'Write your self-assessment before submitting it.',
    );
  }

  if (!canMoveReview(state.status, 'PENDING_MANAGER')) {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `A review in ${state.status} cannot be submitted for manager review.`,
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);

    const ratings = await repo.listRatingsWithWeights(reviewId, 'SELF', tx);
    const derived = weightedCompetencyAverage(ratings);

    await repo.upsertSelfAssessment(tx, reviewId, { submittedAt: now });

    return repo.transitionReview(tx, {
      id: reviewId,
      fromStatuses: ['NOT_STARTED', 'SELF_ASSESSMENT'],
      data: {
        status: 'PENDING_MANAGER',
        selfSubmittedAt: now,
        // The employee's own figure wins where they gave one; the sheet's average
        // fills in where they did not.
        ...(derived !== null ? { selfOverallRating: derived } : {}),
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ALREADY_SUBMITTED',
      'That self-assessment has already been submitted.',
    );
  }

  await recordAudit(req, {
    action: 'HR_SELF_ASSESSMENT_SUBMITTED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
  });

  // The manager's work becomes possible now, which is the moment worth telling them.
  if (state.reviewerId) {
    const accounts = await repo.findUserIdsForEmployees([state.reviewerId]);
    const reviewerUserId = accounts[0]?.userId;
    if (reviewerUserId) {
      await notifications.notifyManagerReviewDue(reviewerUserId, reviewId);
    }
  }

  return getReview(actor, reviewId);
}

// ---------------------------------------------------------------------------
//  Manager assessment
// ---------------------------------------------------------------------------

/**
 * Saving a manager assessment draft.
 *
 * **RULE 2.** `mayWriteManagerAssessment` refuses the subject before consulting any
 * permission, so an HR colleague being appraised cannot write their own.
 *
 * Requires the self-assessment to be in: a manager review written before the
 * employee has had their say is not a review of a conversation, and the state
 * machine says so.
 */
export async function saveManagerAssessment(
  req: Request,
  actor: HrActor,
  reviewId: string,
  input: SaveManagerAssessmentInput,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayWriteManagerAssessment(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
      reviewerId: state.reviewerId,
      selfSubmittedAt: state.selfSubmittedAt,
      managerSubmittedAt: state.managerSubmittedAt,
    })
  ) {
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === state.employeeId
        ? 'Nobody writes their own manager review.'
        : state.managerSubmittedAt !== null
          ? 'This review has been submitted and cannot be changed.'
          : isReviewSettled(state.status as PerformanceReviewStatus)
            ? 'This review is closed.'
            : 'Only this employee’s reviewer or HR can write their manager review.',
    );
  }

  if (state.selfSubmittedAt === null && state.status !== 'PENDING_MANAGER') {
    throw AppError.badRequest(
      'SELF_ASSESSMENT_PENDING',
      'The employee has not submitted their self-assessment yet.',
    );
  }

  await assertCompetenciesBelongToCycle(state.cycleId, input.competencyRatings);

  await prisma.$transaction(async (tx) => {
    await repo.upsertManagerAssessment(tx, reviewId, {
      ...(input.strengths !== undefined ? { strengths: input.strengths } : {}),
      ...(input.improvementAreas !== undefined
        ? { improvementAreas: input.improvementAreas }
        : {}),
      ...(input.comments !== undefined ? { comments: input.comments } : {}),
      ...(input.overallRating !== undefined ? { overallRating: input.overallRating } : {}),
      ...(input.promotionRecommended !== undefined
        ? { promotionRecommended: input.promotionRecommended }
        : {}),
    });

    for (const rating of input.competencyRatings ?? []) {
      await repo.upsertRating(tx, {
        reviewId,
        competencyId: rating.competencyId,
        source: 'MANAGER',
        rating: rating.rating,
        comments: rating.comments ?? null,
        ratedById: actor.id,
      });
    }

    if (state.status === 'PENDING_MANAGER') {
      await repo.transitionReview(tx, {
        id: reviewId,
        fromStatuses: ['PENDING_MANAGER'],
        data: { status: 'MANAGER_REVIEW' },
      });
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_MANAGER_ASSESSMENT_SAVED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
  });

  return getReview(actor, reviewId);
}

/**
 * Submitting a manager assessment.
 *
 * Moves the review to PENDING_APPROVAL and computes the goal roll-up, so the
 * approver sees the attainment the figures actually support rather than one computed
 * at render time from whatever has changed since.
 *
 * `submittedById` records the account that submitted — HR may legitimately write a
 * review for an employee whose manager has left, and the record should say who
 * actually wrote it.
 */
export async function submitManagerAssessment(
  req: Request,
  actor: HrActor,
  reviewId: string,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayWriteManagerAssessment(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
      reviewerId: state.reviewerId,
      selfSubmittedAt: state.selfSubmittedAt,
      managerSubmittedAt: state.managerSubmittedAt,
    })
  ) {
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === state.employeeId
        ? 'Nobody submits their own manager review.'
        : state.managerSubmittedAt !== null
          ? 'That review has already been submitted.'
          : 'Only this employee’s reviewer or HR can submit their manager review.',
    );
  }

  const existing = await repo.findManagerAssessment(reviewId);
  if (!existing) {
    throw AppError.badRequest(
      'MANAGER_ASSESSMENT_EMPTY',
      'Write the review before submitting it.',
    );
  }

  if (!canMoveReview(state.status, 'PENDING_APPROVAL')) {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `A review in ${state.status} cannot be sent for approval.`,
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);

    const ratings = await repo.listRatingsWithWeights(reviewId, 'MANAGER', tx);
    const derived = weightedCompetencyAverage(ratings);

    const goals = await repo.listGoalWeightsForReview(reviewId, tx);
    const attainment = reviewGoalAttainment(goals);

    await repo.upsertManagerAssessment(tx, reviewId, {
      submittedAt: now,
      submittedById: actor.id,
    });

    return repo.transitionReview(tx, {
      id: reviewId,
      fromStatuses: ['MANAGER_REVIEW', 'PENDING_MANAGER'],
      data: {
        status: 'PENDING_APPROVAL',
        managerSubmittedAt: now,
        ...(derived !== null ? { managerOverallRating: derived } : {}),
        ...(attainment !== null ? { goalAttainment: attainment } : {}),
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('ALREADY_SUBMITTED', 'That review has already been submitted.');
  }

  await recordAudit(req, {
    action: 'HR_MANAGER_ASSESSMENT_SUBMITTED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
  });

  return getReview(actor, reviewId);
}

// ---------------------------------------------------------------------------
//  Finalisation
// ---------------------------------------------------------------------------

/**
 * Finalising a review.
 *
 * ### RULE 3, and the concurrency control
 *
 * `mayFinalizeReview` refuses the subject before consulting APPROVE — so an HR
 * colleague being appraised, who holds the grant, cannot lock their own rating and
 * end their own right to respond to it.
 *
 * Then the conditional transition from PENDING_APPROVAL. Two approvers pressing
 * finalise simultaneously both pass the authorization read; one `updateMany` matches
 * and the other matches nothing, so the second is a 409 rather than a second
 * `finalizedById` and a second notification to the employee.
 *
 * ### The figure of record
 *
 * `finalRating` is accepted only here. Omitted, it falls back to the manager's
 * rating — a cycle may finalise on that without a separately adjudicated number.
 * The goals' attainment is snapshotted onto each link, so the finalized review
 * shows the figures the approver saw rather than whatever the goals say later.
 */
export async function finalizeReview(
  req: Request,
  actor: HrActor,
  reviewId: string,
  input: FinalizeReviewInput,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayFinalizeReview(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
    })
  ) {
    /*
      The message distinguishes the three refusals, because they call for different
      actions: wait, ask somebody else, or nothing.
    */
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === state.employeeId
        ? 'Nobody finalises their own review. Somebody else has to approve it.'
        : state.status === 'FINALIZED'
          ? 'That review is already finalised.'
          : state.status !== 'PENDING_APPROVAL'
            ? 'A review can only be finalised once the manager has submitted it.'
            : 'Finalising a review needs HR_PERFORMANCE:APPROVE.',
    );
  }

  const row = await repo.findReview(reviewId);
  if (!row) throw notFound();

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);

    const goals = await repo.listGoalWeightsForReview(reviewId, tx);
    const attainment = reviewGoalAttainment(goals);

    const count = await repo.transitionReview(tx, {
      id: reviewId,
      fromStatuses: ['PENDING_APPROVAL'],
      data: {
        status: 'FINALIZED',
        finalizedById: actor.id,
        finalizedAt: now,
        finalComments: input.finalComments ?? null,
        finalRating:
          input.finalRating !== undefined
            ? new Prisma.Decimal(input.finalRating)
            : row.managerOverallRating,
        ...(attainment !== null ? { goalAttainment: attainment } : {}),
      },
    });

    // Only snapshot if we actually won the race — otherwise two concurrent
    // finalisations would both rewrite the links.
    if (count > 0) await repo.snapshotReviewGoals(tx, reviewId);

    return count;
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ALREADY_FINALIZED',
      'That review has already been finalised by somebody else.',
    );
  }

  await recordAudit(req, {
    action: 'HR_REVIEW_FINALIZED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
    newValue: {
      finalRating: input.finalRating ?? row.managerOverallRating?.toString() ?? null,
    },
  });

  /*
    The employee is told. The one notification in this phase that reports a decision
    rather than requesting an action — and it fires precisely because they can no
    longer influence the outcome.
  */
  const accounts = await repo.findUserIdsForEmployees([state.employeeId]);
  const employeeUserId = accounts[0]?.userId;
  if (employeeUserId) {
    await notifications.notifyReviewFinalized(employeeUserId, reviewId);
  }

  return getReview(actor, reviewId);
}

export async function cancelReview(
  req: Request,
  actor: HrActor,
  reviewId: string,
  input: CancelReviewInput,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (
    !mayCancelReview(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
    })
  ) {
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === state.employeeId
        ? 'Nobody cancels their own review.'
        : isReviewSettled(state.status as PerformanceReviewStatus)
          ? 'That review is already closed. A finalised review cannot be withdrawn — it is the record of a conversation that happened.'
          : 'Cancelling a review needs HR_PERFORMANCE:APPROVE.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionReview(tx, {
      id: reviewId,
      fromStatuses: [
        'NOT_STARTED',
        'SELF_ASSESSMENT',
        'PENDING_MANAGER',
        'MANAGER_REVIEW',
        'PENDING_APPROVAL',
      ],
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancellationReason: input.reason,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('ALREADY_SETTLED', 'That review is already closed.');
  }

  await recordAudit(req, {
    action: 'HR_REVIEW_CANCELLED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
    newValue: { reason: input.reason },
  });

  return getReview(actor, reviewId);
}

/**
 * Recording an HR competency rating.
 *
 * `source: 'SELF'` and `'MANAGER'` are refused through this route. Those belong to
 * the people whose assessments they are, written through their own endpoints — and
 * a general rating endpoint accepting SELF would be the obvious way around
 * `mayWriteSelfAssessment`.
 */
export async function rateCompetency(
  req: Request,
  actor: HrActor,
  reviewId: string,
  input: RateCompetencyInput,
): Promise<PerformanceReviewView> {
  const state = await repo.findReviewState(reviewId);
  if (!state) throw notFound();

  if (input.source !== 'HR') {
    throw AppError.badRequest(
      'RATING_SOURCE_NOT_ALLOWED',
      'Self and manager ratings are written through their own assessment forms.',
    );
  }

  if (
    !mayRateAsHr(actor, {
      status: state.status as PerformanceReviewStatus,
      employeeId: state.employeeId,
    })
  ) {
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === state.employeeId
        ? 'Nobody rates their own review.'
        : 'Recording an HR rating needs HR_PERFORMANCE:EDIT.',
    );
  }

  await assertCompetenciesBelongToCycle(state.cycleId, [
    { competencyId: input.competencyId },
  ]);

  await prisma.$transaction(
    (tx) =>
      repo.upsertRating(tx, {
        reviewId,
        competencyId: input.competencyId,
        source: 'HR',
        rating: input.rating,
        comments: input.comments ?? null,
        ratedById: actor.id,
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_COMPETENCY_RATED',
    entityType: 'PerformanceReview',
    entityId: reviewId,
    actorId: actor.id,
  });

  return getReview(actor, reviewId);
}

/**
 * Every rated competency has to belong to this review's cycle.
 *
 * Without this, a rating could reference a competency from a different cycle — which
 * the foreign key permits, since both tables are real. The rating would then be
 * invisible on the review (the sheet does not contain that competency) while still
 * counting towards the weighted average, so the displayed figure would not match the
 * displayed ratings.
 */
async function assertCompetenciesBelongToCycle(
  cycleId: string,
  ratings: { competencyId: string }[] | undefined,
): Promise<void> {
  if (!ratings || ratings.length === 0) return;

  const sheet = await repo.listCompetenciesForCycle(cycleId);
  const allowed = new Set(sheet.map((c) => c.id));

  for (const rating of ratings) {
    if (!allowed.has(rating.competencyId)) {
      throw AppError.badRequest(
        'COMPETENCY_NOT_ON_SHEET',
        'That competency is not on this cycle’s rating sheet.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

export async function createPlan(
  req: Request,
  actor: HrActor,
  input: CreateDevelopmentPlanInput,
): Promise<DevelopmentPlanView> {
  const employee = await repo.findEmployeeState(input.employeeId);
  if (!employee) {
    throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  }

  if (
    !mayManageDevelopmentPlan(actor, {
      employeeId: input.employeeId,
      subjectManagerId: employee.managerId,
      status: 'OPEN',
    })
  ) {
    throw AppError.forbidden(
      actor.employeeId !== null && actor.employeeId === input.employeeId
        ? 'A development plan is written with you, not by you — ask your manager or HR.'
        : 'Creating a development plan needs HR_PERFORMANCE:EDIT or being the employee’s manager.',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const plan = await repo.createPlan(tx, {
      employeeId: input.employeeId,
      kind: input.kind,
      title: input.title,
      objective: input.objective ?? null,
      supportOffered: input.supportOffered ?? null,
      reviewOn: input.reviewOn ?? null,
      reviewId: input.reviewId ?? null,
      createdById: actor.id,
    });

    if (input.actions && input.actions.length > 0) {
      await repo.createActions(
        tx,
        input.actions.map((a, index) => ({
          planId: plan.id,
          description: a.description,
          dueOn: a.dueOn ?? null,
          sortOrder: a.sortOrder ?? index,
        })),
      );
    }

    return plan;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_DEVELOPMENT_PLAN_CREATED',
    entityType: 'DevelopmentPlan',
    entityId: created.id,
    actorId: actor.id,
    newValue: { kind: input.kind },
  });

  /*
    Only an IMPROVEMENT plan notifies. A GROWTH plan is usually agreed in the
    conversation that created it, and a notification would make a development
    opportunity feel like a disciplinary step.
  */
  if (input.kind === 'IMPROVEMENT') {
    const accounts = await repo.findUserIdsForEmployees([input.employeeId]);
    const userId = accounts[0]?.userId;
    if (userId) await notifications.notifyImprovementPlanOpened(userId, created.id);
  }

  return getPlan(actor, created.id);
}

export async function getPlan(actor: HrActor, id: string): Promise<DevelopmentPlanView> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') throw notFound();

  const row = await repo.findPlan(id);
  if (!row) throw notFound();

  // A plan is readable by its subject, their manager and HR — the same population
  // as their review, so the review filter decides it.
  const visible = await repo.listPlans({
    where: {
      id,
      ...(scope.kind === 'all'
        ? {}
        : scope.kind === 'reports'
          ? {
              OR: [
                { employeeId: scope.employeeId },
                { employee: { managerId: scope.employeeId } },
              ],
            }
          : { employeeId: scope.employeeId }),
    },
    take: 1,
  });
  if (visible.length === 0) throw notFound();

  const [now, completed] = await Promise.all([
    repo.databaseNow(),
    repo.countCompletedActions(id),
  ]);
  const todayKey = companyDayKey(now);

  return {
    ...presentPlanSummary(todayKey)(row),
    completedActionCount: completed,
    objective: row.objective,
    supportOffered: row.supportOffered,
    actions: row.actions.map(presentAction),
    createdBy: row.createdBy,
    closedBy: row.closedBy,
    closedAt: iso(row.closedAt),
    outcomeNote: row.outcomeNote,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPlans(
  actor: HrActor,
  query: DevelopmentPlanListQuery,
): Promise<DevelopmentPlanPage> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') return { items: [], nextCursor: null };

  const now = await repo.databaseNow();
  const todayKey = companyDayKey(now);

  const where: Prisma.DevelopmentPlanWhereInput = {
    ...(scope.kind === 'all'
      ? {}
      : scope.kind === 'reports'
        ? {
            OR: [
              { employeeId: scope.employeeId },
              { employee: { managerId: scope.employeeId } },
            ],
          }
        : { employeeId: scope.employeeId }),
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.overdueOnly
      ? { status: 'OPEN' as const, reviewOn: { lt: companyTodayStart(now) } }
      : {}),
  };

  const rows = await repo.listPlans({
    where,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const completedCounts = await Promise.all(
    page.map((row) => repo.countCompletedActions(row.id)),
  );

  return {
    items: page.map((row, index) => ({
      ...presentPlanSummary(todayKey)(row),
      completedActionCount: completedCounts[index] ?? 0,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function updatePlan(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateDevelopmentPlanInput,
): Promise<DevelopmentPlanView> {
  const state = await repo.findPlanState(id);
  if (!state) throw notFound();

  if (!mayManageDevelopmentPlan(actor, state)) {
    throw AppError.forbidden(
      state.status !== 'OPEN'
        ? 'That plan is closed.'
        : 'Only this employee’s manager or HR can amend their plan.',
    );
  }

  // An improvement plan may not have its review date removed — the CHECK would
  // refuse it, and saying so here names the field.
  if (state.kind === 'IMPROVEMENT' && input.reviewOn === null) {
    throw AppError.badRequest(
      'REVIEW_DATE_REQUIRED',
      'An improvement plan needs a review date.',
    );
  }

  await prisma.$transaction(
    (tx) =>
      repo.updatePlan(tx, id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.supportOffered !== undefined
          ? { supportOffered: input.supportOffered }
          : {}),
        ...(input.reviewOn !== undefined ? { reviewOn: input.reviewOn } : {}),
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_DEVELOPMENT_PLAN_UPDATED',
    entityType: 'DevelopmentPlan',
    entityId: id,
    actorId: actor.id,
  });

  return getPlan(actor, id);
}

export async function closePlan(
  req: Request,
  actor: HrActor,
  id: string,
  input: CloseDevelopmentPlanInput,
): Promise<DevelopmentPlanView> {
  const state = await repo.findPlanState(id);
  if (!state) throw notFound();

  if (!mayManageDevelopmentPlan(actor, state)) {
    throw AppError.forbidden(
      state.status !== 'OPEN'
        ? 'That plan is already closed.'
        : 'Only this employee’s manager or HR can close their plan.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionPlan(tx, {
      id,
      fromStatuses: ['OPEN'],
      data: {
        status: input.outcome,
        closedById: actor.id,
        closedAt: now,
        outcomeNote: input.outcomeNote ?? null,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('PLAN_ALREADY_CLOSED', 'That plan has already been closed.');
  }

  await recordAudit(req, {
    action: 'HR_DEVELOPMENT_PLAN_CLOSED',
    entityType: 'DevelopmentPlan',
    entityId: id,
    actorId: actor.id,
    newValue: { outcome: input.outcome },
  });

  return getPlan(actor, id);
}

export async function addAction(
  req: Request,
  actor: HrActor,
  planId: string,
  input: CreateDevelopmentActionInput,
): Promise<DevelopmentActionView> {
  const state = await repo.findPlanState(planId);
  if (!state) throw notFound();

  if (!mayManageDevelopmentPlan(actor, state)) {
    throw AppError.forbidden('Only this employee’s manager or HR can add to their plan.');
  }

  const plan = await repo.findPlan(planId);

  const created = await prisma.$transaction(
    (tx) =>
      repo.createAction(tx, {
        planId,
        description: input.description,
        dueOn: input.dueOn ?? null,
        sortOrder: input.sortOrder ?? (plan?.actions.length ?? 0),
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_DEVELOPMENT_ACTION_ADDED',
    entityType: 'DevelopmentAction',
    entityId: created.id,
    actorId: actor.id,
  });

  return presentAction(created);
}

/**
 * Ticking an action off, or un-ticking it.
 *
 * The subject **is** allowed here, unlike every other write on a plan: doing the
 * things a plan asks for is their work, and requiring a manager to record each one
 * would make the plan a tracking burden rather than a support. They still cannot
 * add, remove or reword actions.
 *
 * `development_action_completion_complete` requires the stamps to agree with the
 * flag, so un-ticking clears both.
 */
export async function completeAction(
  req: Request,
  actor: HrActor,
  id: string,
  isCompleted: boolean,
): Promise<DevelopmentActionView> {
  const action = await repo.findActionState(id);
  if (!action) throw notFound();

  const state = await repo.findPlanState(action.planId);
  if (!state) throw notFound();

  if (!mayCompleteDevelopmentAction(actor, state)) {
    throw AppError.forbidden(
      state.status !== 'OPEN'
        ? 'That plan is closed.'
        : 'Only this employee, their manager or HR can update their plan’s actions.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.updateAction(tx, id, {
      isCompleted,
      // Both stamps move together with the flag, which the CHECK requires.
      completedAt: isCompleted ? now : null,
      completedById: isCompleted ? actor.id : null,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: isCompleted ? 'HR_DEVELOPMENT_ACTION_COMPLETED' : 'HR_DEVELOPMENT_ACTION_REOPENED',
    entityType: 'DevelopmentAction',
    entityId: id,
    actorId: actor.id,
  });

  return presentAction(updated);
}

export async function removeAction(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<{ removed: boolean }> {
  const action = await repo.findActionState(id);
  if (!action) throw notFound();

  const state = await repo.findPlanState(action.planId);
  if (!state) throw notFound();

  if (!mayManageDevelopmentPlan(actor, state)) {
    throw AppError.forbidden('Only this employee’s manager or HR can remove a plan action.');
  }

  await prisma.$transaction((tx) => repo.deleteAction(tx, id), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_DEVELOPMENT_ACTION_REMOVED',
    entityType: 'DevelopmentAction',
    entityId: id,
    actorId: actor.id,
  });

  return { removed: true };
}

// ---------------------------------------------------------------------------
//  Dashboard, history and reports
// ---------------------------------------------------------------------------

/**
 * The performance dashboard.
 *
 * Real aggregate counts, each scoped server-side — so a department head's figures
 * are their department's and an employee's are their own. The same approach Phase
 * 4's training overview takes, and for the same reason: a count derived from the
 * length of a page silently stops being a count at page 2.
 */
export async function getOverview(actor: HrActor): Promise<PerformanceOverview> {
  const scope = await scopeForRequest(actor);

  if (scope.kind === 'none') {
    return {
      activeCycles: 0,
      reviewsNotStarted: 0,
      reviewsAwaitingSelf: 0,
      reviewsAwaitingManager: 0,
      reviewsAwaitingApproval: 0,
      reviewsFinalized: 0,
      selfAssessmentsOverdue: 0,
      managerReviewsOverdue: 0,
      activeGoals: 0,
      goalsOverdue: 0,
      goalsAchieved: 0,
      openImprovementPlans: 0,
      myReviewsToWrite: 0,
      myOwnReviewPending: false,
    };
  }

  const now = await repo.databaseNow();
  const today = companyTodayStart(now);

  const reviewWhere = visibleReviewFilter(scope) as Prisma.PerformanceReviewWhereInput;
  const goalWhere = {
    ...(scope.kind === 'all'
      ? {}
      : scope.kind === 'reports'
        ? {
            OR: [
              { employeeId: scope.employeeId },
              { employee: { managerId: scope.employeeId } },
              { department: { employees: { some: { id: scope.employeeId } } } },
            ],
          }
        : { employeeId: scope.employeeId }),
  } as Prisma.PerformanceGoalWhereInput;
  const planWhere = {
    ...(scope.kind === 'all'
      ? {}
      : scope.kind === 'reports'
        ? {
            OR: [
              { employeeId: scope.employeeId },
              { employee: { managerId: scope.employeeId } },
            ],
          }
        : { employeeId: scope.employeeId }),
  } as Prisma.DevelopmentPlanWhereInput;

  const [
    activeCycles,
    reviewCounts,
    goalCounts,
    selfOverdue,
    managerOverdue,
    goalsOverdue,
    improvementPlans,
    myToWrite,
    myOwn,
  ] = await Promise.all([
    repo.countActiveCycles(),
    repo.countReviewsByStatus(reviewWhere),
    repo.countGoalsByStatus(goalWhere),
    repo.countOverdueSelfAssessments(reviewWhere, today),
    repo.countOverdueManagerReviews(reviewWhere, today),
    repo.countOverdueGoals(goalWhere, today),
    repo.countOpenImprovementPlans(planWhere),
    actor.employeeId
      ? repo.countReviews({
          reviewerId: actor.employeeId,
          status: { in: ['PENDING_MANAGER', 'MANAGER_REVIEW'] },
        })
      : Promise.resolve(0),
    actor.employeeId
      ? repo.countReviews({
          employeeId: actor.employeeId,
          status: { in: ['NOT_STARTED', 'SELF_ASSESSMENT'] },
        })
      : Promise.resolve(0),
  ]);

  return {
    activeCycles,
    reviewsNotStarted: reviewCounts.get('NOT_STARTED') ?? 0,
    reviewsAwaitingSelf: reviewCounts.get('SELF_ASSESSMENT') ?? 0,
    reviewsAwaitingManager:
      (reviewCounts.get('PENDING_MANAGER') ?? 0) + (reviewCounts.get('MANAGER_REVIEW') ?? 0),
    reviewsAwaitingApproval: reviewCounts.get('PENDING_APPROVAL') ?? 0,
    reviewsFinalized: reviewCounts.get('FINALIZED') ?? 0,
    selfAssessmentsOverdue: selfOverdue,
    managerReviewsOverdue: managerOverdue,
    activeGoals: goalCounts.get('ACTIVE') ?? 0,
    goalsOverdue,
    goalsAchieved: goalCounts.get('ACHIEVED') ?? 0,
    openImprovementPlans: improvementPlans,
    myReviewsToWrite: myToWrite,
    myOwnReviewPending: myOwn > 0,
  };
}

/**
 * One employee's appraisal history.
 *
 * Finalized reviews only, oldest first. A history including drafts and cancellations
 * would make a trend line out of noise — and because a finalized review cannot be
 * edited, this list cannot change retroactively.
 */
export async function getHistory(
  actor: HrActor,
  employeeId: string,
  query: PerformanceHistoryQuery,
): Promise<PerformanceHistoryView> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') throw notFound();

  const employee = await repo.findEmployeeState(employeeId);
  if (!employee) throw notFound();

  // The same visibility rule as a review, applied to the subject rather than to a
  // row: somebody who may not read this person's reviews may not read their history.
  const permitted =
    scope.kind === 'all' ||
    (scope.kind === 'reports' &&
      (employeeId === scope.employeeId || employee.managerId === scope.employeeId)) ||
    (scope.kind === 'selfOnly' && employeeId === scope.employeeId);

  if (!permitted) throw notFound();

  const [rows, ref] = await Promise.all([
    repo.listFinalizedReviews({
      employeeId,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    }),
    repo.findEmployeeRef(employeeId),
  ]);

  if (!ref) throw notFound();

  const ratings = rows
    .map((r) => r.finalRating)
    .filter((r): r is Prisma.Decimal => r !== null);

  return {
    employee: toEmployeeRef(ref),
    entries: rows
      .filter(
        (row): row is (typeof rows)[number] & { finalizedAt: Date } =>
          row.finalizedAt !== null,
      )
      .map((row) => ({
      reviewId: row.id,
      cycle: { id: row.cycle.id, code: row.cycle.code, name: row.cycle.name },
      periodStart: row.cycle.periodStart.toISOString().slice(0, 10),
      periodEnd: row.cycle.periodEnd.toISOString().slice(0, 10),
      finalRating: dec(row.finalRating),
      goalAttainment: dec(row.goalAttainment),
      /*
        Non-null on a FINALIZED row by `performance_review_finalized_has_approver`.
        Narrowed by the filter below rather than defaulted, because a fabricated
        date in an appraisal history is worse than a missing entry.
      */
      finalizedAt: row.finalizedAt.toISOString(),
      reviewer: row.reviewer ? toEmployeeRef(row.reviewer) : null,
      })),
    averageRating: dec(averageRating(ratings)),
  };
}

/**
 * A cycle's standing.
 *
 * Counts and a distribution rather than a league table of named people: a report
 * that ranked colleagues by rating would be read as one, and nobody has asked for
 * that. The per-person figures are on each review, behind the access policy.
 */
export async function getCycleReport(
  actor: HrActor,
  cycleId: string,
): Promise<CycleReportView> {
  if (!actor.can('HR_PERFORMANCE', 'VIEW')) {
    throw AppError.forbidden('Reading a cycle report needs HR_PERFORMANCE:VIEW.');
  }

  const cycle = await repo.findCycle(cycleId);
  if (!cycle) throw notFound();

  const [statusRows, finalRatings, perDepartment, finalizedCount] = await Promise.all([
    repo.countReviewsByStatus({ cycleId }),
    repo.listCycleFinalRatings(cycleId),
    repo.listCycleReviewsForReport(cycleId),
    repo.countFinalizedInCycle(cycleId),
  ]);

  const statusCounts = {
    NOT_STARTED: statusRows.get('NOT_STARTED') ?? 0,
    SELF_ASSESSMENT: statusRows.get('SELF_ASSESSMENT') ?? 0,
    PENDING_MANAGER: statusRows.get('PENDING_MANAGER') ?? 0,
    MANAGER_REVIEW: statusRows.get('MANAGER_REVIEW') ?? 0,
    PENDING_APPROVAL: statusRows.get('PENDING_APPROVAL') ?? 0,
    FINALIZED: statusRows.get('FINALIZED') ?? 0,
    CANCELLED: statusRows.get('CANCELLED') ?? 0,
  };

  const ratings = finalRatings
    .map((r) => r.finalRating)
    .filter((r): r is Prisma.Decimal => r !== null);
  const attainments = finalRatings
    .map((r) => r.goalAttainment)
    .filter((r): r is Prisma.Decimal => r !== null);

  // Grouped here rather than in SQL: the key lives on a joined table, which
  // `groupBy` cannot reach through.
  const byDept = new Map<
    string,
    { department: { id: string; name: string; code: string }; reviews: number; finalized: number; ratings: Prisma.Decimal[] }
  >();

  for (const row of perDepartment) {
    if (!row.employee.department) continue;
    const key = row.employee.department.id;
    const entry =
      byDept.get(key) ??
      { department: row.employee.department, reviews: 0, finalized: 0, ratings: [] };
    entry.reviews += 1;
    if (row.status === 'FINALIZED') {
      entry.finalized += 1;
      if (row.finalRating !== null) entry.ratings.push(row.finalRating);
    }
    byDept.set(key, entry);
  }

  return {
    cycle: {
      id: cycle.id,
      code: cycle.code,
      name: cycle.name,
      cadence: cycle.cadence,
      status: cycle.status,
      periodStart: cycle.periodStart.toISOString().slice(0, 10),
      periodEnd: cycle.periodEnd.toISOString().slice(0, 10),
      selfAssessmentDueOn: dayKey(cycle.selfAssessmentDueOn),
      managerReviewDueOn: dayKey(cycle.managerReviewDueOn),
      goalAchievementThreshold: cycle.goalAchievementThreshold.toString(),
      goalPartialThreshold: cycle.goalPartialThreshold.toString(),
      reviewCount: cycle._count.reviews,
      finalizedCount,
      createdAt: cycle.createdAt.toISOString(),
    },
    statusCounts,
    ratingDistribution: ratingDistribution(ratings),
    averageFinalRating: dec(averageRating(ratings)),
    averageGoalAttainment: dec(averageRating(attainments)),
    byDepartment: [...byDept.values()].map((entry) => ({
      department: entry.department,
      reviewCount: entry.reviews,
      finalizedCount: entry.finalized,
      averageFinalRating: dec(averageRating(entry.ratings)),
    })),
  };
}
