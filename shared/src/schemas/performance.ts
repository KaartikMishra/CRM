import { z } from 'zod';
import {
  COMPETENCY_CATEGORIES,
  DEVELOPMENT_PLAN_KINDS,
  DEVELOPMENT_PLAN_STATUSES,
  GOAL_SCOPES,
  GOAL_STATUSES,
  KPI_DIRECTIONS,
  KPI_METRIC_KINDS,
  MAX_COMPETENCY_RATING,
  MIN_COMPETENCY_RATING,
  PERFORMANCE_REVIEW_STATUSES,
  RATING_SOURCES,
  REVIEW_CYCLE_CADENCES,
  REVIEW_CYCLE_STATUSES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 5 — Performance Management.
 *
 * What these deliberately do NOT accept, and why each omission matters:
 *
 *   - **`status` on any create.** A cycle is born DRAFT, a review NOT_STARTED, a
 *     goal DRAFT. Every move out of those runs through a named endpoint that
 *     writes the audit entry and, where relevant, the notification. Accepting a
 *     status here would let a cycle be born ACTIVE with nothing recording who
 *     opened it, and would let a review be created FINALIZED — a locked record of
 *     a conversation that never happened.
 *   - **`code` on a cycle or a goal.** Allocated server-side from the same atomic
 *     counter mechanism Phases 1 and 3 use. A client-supplied reference is a
 *     duplicate waiting to happen, and these are quoted in conversations.
 *   - **`attainment` anywhere.** Computed from target, value and direction in
 *     `performance.calc.ts`. A client-supplied attainment is a client-supplied
 *     performance result.
 *   - **`finalRating` on anything but finalisation.** It is the figure of record
 *     and is written once, by somebody holding APPROVE who is not the subject.
 *   - **`finalizedAt`, `selfSubmittedAt`, `managerSubmittedAt`.** Timestamps are
 *     the server's. A submitted-at the client could set is a deadline the client
 *     could beat retroactively.
 *   - **`employeeId` on a self-assessment write.** The subject comes from the
 *     review, and the actor must *be* that subject. A field here would be the
 *     obvious way to write an assessment into somebody else's review.
 *
 * On thresholds: `DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD` (100) and
 * `DEFAULT_GOAL_PARTIAL_THRESHOLD` (50) are column defaults and UI suggestions.
 * These schemas validate the *range* a stated threshold may take; nothing here or
 * in the services compares against the constants. Each cycle carries its own.
 */

const dateSchema = z.coerce.date();

const titleSchema = z.string().trim().min(2, 'Give it a title').max(200);

const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Say why — a decision with no reason cannot be explained later')
  .max(2000);

/** Long-form narrative. Generous, because an appraisal comment is prose. */
const narrativeSchema = z.string().trim().max(10_000);

/**
 * A weight or threshold percentage, to two decimal places.
 *
 * Bounded above 0: a zero-weight KPI cannot affect a result, so it is either a
 * mistake or a KPI that should not be there. Paired with database CHECKs.
 */
const percentageSchema = z.coerce
  .number()
  .gt(0, 'A weight of zero would mean this counts for nothing')
  .max(100, 'A percentage above 100 is not a share of anything');

/**
 * A threshold, which unlike a weight may legitimately exceed 100.
 *
 * A business may define "achieved" as 110% of target for a stretch goal. Capping
 * it at 100 would quietly make that impossible to express.
 */
const thresholdSchema = z.coerce
  .number()
  .gt(0, 'A threshold of zero would mean everything is achieved')
  .max(1000, 'A threshold above 1000% is not a target anybody is working to');

/**
 * A measured value: a target, a baseline or a recorded figure.
 *
 * Signed, because a KPI can legitimately move below zero — a margin, a variance, a
 * net change. Two decimal places, matching the Decimal(14,2) column.
 */
const measureSchema = z.coerce
  .number()
  .min(-1_000_000_000_000, 'That value is outside what this can record')
  .max(1_000_000_000_000, 'That value is outside what this can record');

/**
 * An overall rating, 1.00–5.00.
 *
 * Fractional deliberately: an overall figure is often a weighted mean of
 * competencies, and forcing it to a whole number would throw that away. The
 * per-competency ratings below are integers, which is different — a rater picks one
 * of five named levels.
 */
const overallRatingSchema = z.coerce
  .number()
  .min(MIN_COMPETENCY_RATING, `A rating cannot be below ${MIN_COMPETENCY_RATING}`)
  .max(MAX_COMPETENCY_RATING, `A rating cannot be above ${MAX_COMPETENCY_RATING}`);

/** One of the five named levels. An integer, matching Phase 3's 1–5 scale. */
const competencyRatingSchema = z.coerce
  .number()
  .int('Pick one of the five levels')
  .min(MIN_COMPETENCY_RATING)
  .max(MAX_COMPETENCY_RATING);

const sortOrderSchema = z.coerce.number().int().min(0).max(10_000);

// ---------------------------------------------------------------------------
//  Review cycles
// ---------------------------------------------------------------------------

/**
 * Creating a cycle.
 *
 * The competency sheet is created with the cycle rather than afterwards, because a
 * cycle with no competencies cannot be reviewed against and a half-configured one
 * is worse than none. Competencies can still be amended while the cycle is DRAFT.
 *
 * `periodEnd >= periodStart` is checked here and by a CHECK. The due dates are not
 * required to fall inside the period: a self-assessment is often due shortly after
 * the period it covers, which is the normal case rather than an error.
 */
export const createReviewCycleSchema = z
  .object({
    name: titleSchema,
    description: narrativeSchema.optional(),
    cadence: z.enum(REVIEW_CYCLE_CADENCES),
    periodStart: dateSchema,
    periodEnd: dateSchema,
    selfAssessmentDueOn: dateSchema.optional(),
    managerReviewDueOn: dateSchema.optional(),
    /** Null or omitted covers the whole company. */
    targetDepartmentId: cuidSchema.optional(),
    goalAchievementThreshold: thresholdSchema.optional(),
    goalPartialThreshold: thresholdSchema.optional(),
    competencies: z
      .array(
        z.object({
          name: titleSchema,
          category: z.enum(COMPETENCY_CATEGORIES),
          description: narrativeSchema.optional(),
          weight: percentageSchema.optional(),
          sortOrder: sortOrderSchema.optional(),
        }),
      )
      .min(1, 'A cycle needs at least one competency to rate')
      .max(50, 'Fifty competencies is already more than anybody rates honestly')
      .optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'The period cannot end before it starts',
    path: ['periodEnd'],
  })
  .refine(
    (v) =>
      v.goalPartialThreshold === undefined ||
      v.goalAchievementThreshold === undefined ||
      v.goalPartialThreshold <= v.goalAchievementThreshold,
    {
      message: 'The partial threshold cannot be above the achievement threshold',
      path: ['goalPartialThreshold'],
    },
  );

/**
 * Amending a cycle.
 *
 * `status` is absent: opening, closing and archiving are their own endpoints, each
 * carrying a timestamp and an audit entry. A PATCH able to set `status: 'ACTIVE'`
 * would make a cycle live with no record of who did it.
 *
 * The service additionally refuses changing the period or the thresholds once the
 * cycle is ACTIVE — reviews have already been judged against them, and moving the
 * goalposts mid-cycle silently rescores work that is already done.
 */
export const updateReviewCycleSchema = z
  .object({
    name: titleSchema.optional(),
    description: narrativeSchema.nullable().optional(),
    cadence: z.enum(REVIEW_CYCLE_CADENCES).optional(),
    periodStart: dateSchema.optional(),
    periodEnd: dateSchema.optional(),
    selfAssessmentDueOn: dateSchema.nullable().optional(),
    managerReviewDueOn: dateSchema.nullable().optional(),
    targetDepartmentId: cuidSchema.nullable().optional(),
    goalAchievementThreshold: thresholdSchema.optional(),
    goalPartialThreshold: thresholdSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field')
  .refine(
    (v) =>
      v.periodStart === undefined ||
      v.periodEnd === undefined ||
      v.periodEnd >= v.periodStart,
    { message: 'The period cannot end before it starts', path: ['periodEnd'] },
  );

export const reviewCycleListQuerySchema = paginationSchema.extend({
  status: z.enum(REVIEW_CYCLE_STATUSES).optional(),
  cadence: z.enum(REVIEW_CYCLE_CADENCES).optional(),
  departmentId: cuidSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const closeReviewCycleSchema = z.object({ reason: reasonSchema });

// ---------------------------------------------------------------------------
//  Competencies
// ---------------------------------------------------------------------------

export const createCompetencySchema = z.object({
  name: titleSchema,
  category: z.enum(COMPETENCY_CATEGORIES),
  description: narrativeSchema.optional(),
  weight: percentageSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
});

export const updateCompetencySchema = z
  .object({
    name: titleSchema.optional(),
    category: z.enum(COMPETENCY_CATEGORIES).optional(),
    description: narrativeSchema.nullable().optional(),
    weight: percentageSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

/**
 * Creating a goal.
 *
 * Exactly one owner — an employee or a department — enforced here and by the
 * `goal_exactly_one_owner` CHECK. A goal with neither belongs to nobody and a goal
 * with both is ambiguous about who is accountable.
 *
 * KPIs may be created with the goal, which is the common case: a goal with no
 * measure is an intention, and the requirement is explicit that targets be
 * measurable.
 */
export const createGoalSchema = z
  .object({
    title: titleSchema,
    description: narrativeSchema.optional(),
    successCriteria: narrativeSchema.optional(),
    scope: z.enum(GOAL_SCOPES),
    employeeId: cuidSchema.optional(),
    departmentId: cuidSchema.optional(),
    /** Ties the goal to a cycle so it is appraised in that review. */
    cycleId: cuidSchema.optional(),
    startOn: dateSchema,
    dueOn: dateSchema,
    weight: percentageSchema.optional(),
    kpis: z
      .array(
        z.object({
          name: titleSchema,
          description: narrativeSchema.optional(),
          metricKind: z.enum(KPI_METRIC_KINDS),
          direction: z.enum(KPI_DIRECTIONS).optional(),
          targetValue: measureSchema,
          baselineValue: measureSchema.optional(),
          unitLabel: z.string().trim().max(50).optional(),
          weight: percentageSchema.optional(),
          sortOrder: sortOrderSchema.optional(),
        }),
      )
      .max(50, 'Fifty indicators on one goal is not a goal')
      .optional(),
  })
  .refine((v) => v.dueOn >= v.startOn, {
    message: 'A goal cannot be due before it starts',
    path: ['dueOn'],
  })
  .refine(
    (v) =>
      v.scope === 'EMPLOYEE'
        ? v.employeeId !== undefined && v.departmentId === undefined
        : v.departmentId !== undefined && v.employeeId === undefined,
    {
      message: 'An employee goal names an employee; a department goal names a department',
      path: ['employeeId'],
    },
  );

/**
 * Amending a goal.
 *
 * `status` is absent — closing a goal is its own endpoint, because the outcome
 * (achieved, partially met, missed) is a judgement that needs a reason and an
 * author. `scope`, `employeeId` and `departmentId` are absent too: moving a goal to
 * a different owner mid-cycle would silently transfer somebody's appraised work.
 */
export const updateGoalSchema = z
  .object({
    title: titleSchema.optional(),
    description: narrativeSchema.nullable().optional(),
    successCriteria: narrativeSchema.nullable().optional(),
    cycleId: cuidSchema.nullable().optional(),
    startOn: dateSchema.optional(),
    dueOn: dateSchema.optional(),
    weight: percentageSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field')
  .refine(
    (v) => v.startOn === undefined || v.dueOn === undefined || v.dueOn >= v.startOn,
    { message: 'A goal cannot be due before it starts', path: ['dueOn'] },
  );

/** Agreeing a goal — DRAFT to ACTIVE. Its own act, so it carries an author. */
export const activateGoalSchema = z.object({}).optional();

/**
 * Closing a goal with its outcome.
 *
 * The outcome is stated rather than derived, deliberately. The service *computes*
 * attainment and suggests an outcome against the cycle's thresholds, but a manager
 * closing a goal may know that a missed target was missed for a good reason. So the
 * judgement is theirs and the arithmetic is the server's, and both are recorded.
 *
 * A note is required when the stated outcome disagrees with the computed
 * attainment — enforced in the service, which is the only place that knows both.
 */
export const closeGoalSchema = z.object({
  outcome: z.enum(['ACHIEVED', 'PARTIALLY_MET', 'MISSED', 'CANCELLED'] as const),
  closureNote: narrativeSchema.optional(),
});

export const goalListQuerySchema = paginationSchema.extend({
  scope: z.enum(GOAL_SCOPES).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  employeeId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  cycleId: cuidSchema.optional(),
  /** Past their due date and not settled. */
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

export const createKpiSchema = z.object({
  name: titleSchema,
  description: narrativeSchema.optional(),
  metricKind: z.enum(KPI_METRIC_KINDS),
  direction: z.enum(KPI_DIRECTIONS).optional(),
  targetValue: measureSchema,
  baselineValue: measureSchema.optional(),
  unitLabel: z.string().trim().max(50).optional(),
  weight: percentageSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
});

/**
 * Amending a KPI's definition.
 *
 * `currentValue` is absent: recording progress is its own endpoint, because each
 * movement is an event with an author, a timestamp and an optional note — a history
 * worth keeping. A PATCH that set the value would overwrite the number with no
 * record of who moved it or when.
 *
 * `metricKind` is absent too. Changing it would reinterpret every recorded value:
 * a 40 that meant "40 orders" becoming "40%" changes a result retroactively.
 */
export const updateKpiSchema = z
  .object({
    name: titleSchema.optional(),
    description: narrativeSchema.nullable().optional(),
    direction: z.enum(KPI_DIRECTIONS).optional(),
    targetValue: measureSchema.optional(),
    baselineValue: measureSchema.nullable().optional(),
    unitLabel: z.string().trim().max(50).nullable().optional(),
    weight: percentageSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Recording progress on a KPI.
 *
 * Carries the measured value and nothing else. **No attainment and no percentage**
 * — those are computed in `performance.calc.ts` from the value, the target and the
 * direction. A client-supplied attainment would be a client-supplied performance
 * result, which is this phase's equivalent of Phase 4's forged score.
 */
export const recordKpiProgressSchema = z.object({
  value: measureSchema,
  note: narrativeSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

/**
 * Opening reviews for a cycle.
 *
 * One endpoint rather than creating reviews one at a time, because a cycle's whole
 * point is that everybody in scope is reviewed: generating them individually is how
 * somebody gets missed. The eligible set is resolved **once, server-side**, from the
 * cycle's target department and the employees active at that moment — so somebody
 * who joins later is not retroactively owed a review for a period they were not
 * here for.
 *
 * Exactly one of `employeeIds` or `allInScope`, so a deliberate subset is possible
 * without making the common case a list somebody has to assemble.
 */
export const generateReviewsSchema = z
  .object({
    employeeIds: z.array(cuidSchema).min(1).max(1000).optional(),
    allInScope: z.literal(true).optional(),
  })
  .refine(
    (v) =>
      [v.employeeIds !== undefined, v.allInScope !== undefined].filter(Boolean).length === 1,
    {
      message: 'Generate for named employees, or for everybody in scope — exactly one',
      path: ['employeeIds'],
    },
  );

/**
 * Writing a self-assessment.
 *
 * **No `employeeId`.** The subject comes from the review and the actor must be that
 * subject — the service refuses anybody else, including an administrator holding
 * every grant. A field here would be the obvious way to write an assessment into
 * a colleague's review.
 *
 * **No `submittedAt` and no `status`.** Submitting is its own endpoint. A draft that
 * could set its own submitted-at is a deadline the client could beat retroactively.
 *
 * Every field optional so the form can be saved in pieces — somebody writing an
 * honest appraisal does it over more than one sitting. The submit endpoint is where
 * completeness is checked.
 */
export const saveSelfAssessmentSchema = z
  .object({
    achievements: narrativeSchema.nullable().optional(),
    challenges: narrativeSchema.nullable().optional(),
    developmentWishes: narrativeSchema.nullable().optional(),
    overallRating: overallRatingSchema.optional(),
    /** Competency ratings, saved alongside the narrative. */
    competencyRatings: z
      .array(
        z.object({
          competencyId: cuidSchema,
          rating: competencyRatingSchema,
          comments: narrativeSchema.optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to save');

/**
 * Writing a manager review.
 *
 * Same shape, different author and a different authorisation rule: the actor must
 * be this employee's manager, or hold HR_PERFORMANCE:EDIT. The service refuses the
 * **employee themselves first**, before any permission check — a review somebody
 * wrote about themselves and filed as their manager's is not a review.
 */
export const saveManagerAssessmentSchema = z
  .object({
    strengths: narrativeSchema.nullable().optional(),
    improvementAreas: narrativeSchema.nullable().optional(),
    comments: narrativeSchema.nullable().optional(),
    overallRating: overallRatingSchema.optional(),
    promotionRecommended: z.boolean().nullable().optional(),
    competencyRatings: z
      .array(
        z.object({
          competencyId: cuidSchema,
          rating: competencyRatingSchema,
          comments: narrativeSchema.optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to save');

/**
 * Submitting — either side.
 *
 * Deliberately `.strict()`, and it is the only strict schema here.
 *
 * This is the request a forged `finalRating` or `status` would ride on, and the
 * difference matters: elsewhere a stray key is a client being sloppy, and 422-ing a
 * whole appraisal form over it is unkind. Here, answering 200 to an attempted
 * forgery — even though the field is stripped and the rating is still set
 * server-side at finalisation — would tell the sender their claim was accepted. So
 * this one refuses loudly. Phase 4 reached the same conclusion about
 * `submitTrainingAttemptSchema` for the same reason.
 */
export const submitReviewSchema = z
  .object({
    /** An optional note accompanying the submission. Not part of the assessment. */
    note: narrativeSchema.optional(),
  })
  .strict();

/**
 * Finalising a review.
 *
 * `finalRating` is accepted here and **nowhere else**, because this is the one act
 * that sets the figure of record. Optional: a cycle may finalise on the manager's
 * rating without a separate adjudicated number, and the service falls back to it.
 *
 * The service enforces what no schema can: the actor holds HR_PERFORMANCE:APPROVE,
 * is not the subject, and the review is actually awaiting approval. Finalisation
 * locks the record — nothing edits a FINALIZED review afterwards.
 */
export const finalizeReviewSchema = z.object({
  finalRating: overallRatingSchema.optional(),
  finalComments: narrativeSchema.optional(),
});

export const cancelReviewSchema = z.object({ reason: reasonSchema });

export const performanceReviewListQuerySchema = paginationSchema.extend({
  cycleId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  reviewerId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  status: z.enum(PERFORMANCE_REVIEW_STATUSES).optional(),
  /** Past the cycle's due date and not submitted. */
  overdueOnly: z.coerce.boolean().optional(),
  /** Only the reviews this reader personally owes. */
  mineToWrite: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

/**
 * Rating a competency outside the assessment forms.
 *
 * Exists for an HR rating — a third view where one is genuinely needed — and is
 * gated on HR_PERFORMANCE:EDIT. `source` is accepted so the row says who it speaks
 * for, but the service refuses SELF and MANAGER through this route: those belong to
 * the people whose assessments they are, written through their own endpoints.
 */
export const rateCompetencySchema = z.object({
  competencyId: cuidSchema,
  source: z.enum(RATING_SOURCES),
  rating: competencyRatingSchema,
  comments: narrativeSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Development and improvement plans
// ---------------------------------------------------------------------------

/**
 * Creating a development plan.
 *
 * `reviewOn` is required for an IMPROVEMENT plan and optional for a GROWTH one — a
 * formal improvement plan with no review date is not a plan, it is a complaint on
 * file. Enforced here and by the `development_plan_improvement_has_review_date`
 * CHECK.
 */
export const createDevelopmentPlanSchema = z
  .object({
    employeeId: cuidSchema,
    kind: z.enum(DEVELOPMENT_PLAN_KINDS),
    title: titleSchema,
    objective: narrativeSchema.optional(),
    supportOffered: narrativeSchema.optional(),
    reviewOn: dateSchema.optional(),
    /** The review this came out of, where it came out of one. */
    reviewId: cuidSchema.optional(),
    actions: z
      .array(
        z.object({
          description: z.string().trim().min(2, 'Say what will be done').max(2000),
          dueOn: dateSchema.optional(),
          sortOrder: sortOrderSchema.optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => v.kind !== 'IMPROVEMENT' || v.reviewOn !== undefined, {
    message: 'An improvement plan needs a review date',
    path: ['reviewOn'],
  });

export const updateDevelopmentPlanSchema = z
  .object({
    title: titleSchema.optional(),
    objective: narrativeSchema.nullable().optional(),
    supportOffered: narrativeSchema.nullable().optional(),
    reviewOn: dateSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const closeDevelopmentPlanSchema = z.object({
  outcome: z.enum(['COMPLETED', 'ABANDONED'] as const),
  outcomeNote: narrativeSchema.optional(),
});

export const createDevelopmentActionSchema = z.object({
  description: z.string().trim().min(2, 'Say what will be done').max(2000),
  dueOn: dateSchema.optional(),
  sortOrder: sortOrderSchema.optional(),
});

/** Ticking an action off, or un-ticking it. The server stamps who and when. */
export const completeDevelopmentActionSchema = z.object({
  isCompleted: z.boolean(),
});

export const developmentPlanListQuerySchema = paginationSchema.extend({
  employeeId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  kind: z.enum(DEVELOPMENT_PLAN_KINDS).optional(),
  status: z.enum(DEVELOPMENT_PLAN_STATUSES).optional(),
  overdueOnly: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------

export const performanceHistoryQuerySchema = z.object({
  /** How far back to go. Omitted returns every finalized review. */
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Path parameters
// ---------------------------------------------------------------------------

/*
  One per resource rather than a shared `{ id }`, following the Phase 1–4
  precedent. They are identical today, which is why they are separate: the route
  table reads `goalParamSchema` and says what it expects, so a handler wired to the
  wrong path is visible at the call site.
*/
export const reviewCycleParamSchema = z.object({ id: cuidSchema });
export const competencyParamSchema = z.object({ id: cuidSchema });
export const goalParamSchema = z.object({ id: cuidSchema });
export const kpiParamSchema = z.object({ id: cuidSchema });
export const performanceReviewParamSchema = z.object({ id: cuidSchema });
export const developmentPlanParamSchema = z.object({ id: cuidSchema });
export const developmentActionParamSchema = z.object({ id: cuidSchema });
export const performanceEmployeeParamSchema = z.object({ id: cuidSchema });

/** A KPI reached through its goal, so the route states the containment. */
export const goalKpiParamSchema = z.object({
  id: cuidSchema,
  kpiId: cuidSchema,
});

// ---------------------------------------------------------------------------
//  Inferred input types
// ---------------------------------------------------------------------------

export type CreateReviewCycleInput = z.infer<typeof createReviewCycleSchema>;
export type UpdateReviewCycleInput = z.infer<typeof updateReviewCycleSchema>;
export type ReviewCycleListQuery = z.infer<typeof reviewCycleListQuerySchema>;
export type CreateCompetencyInput = z.infer<typeof createCompetencySchema>;
export type UpdateCompetencyInput = z.infer<typeof updateCompetencySchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type CloseGoalInput = z.infer<typeof closeGoalSchema>;
export type GoalListQuery = z.infer<typeof goalListQuerySchema>;
export type CreateKpiInput = z.infer<typeof createKpiSchema>;
export type UpdateKpiInput = z.infer<typeof updateKpiSchema>;
export type RecordKpiProgressInput = z.infer<typeof recordKpiProgressSchema>;
export type GenerateReviewsInput = z.infer<typeof generateReviewsSchema>;
export type SaveSelfAssessmentInput = z.infer<typeof saveSelfAssessmentSchema>;
export type SaveManagerAssessmentInput = z.infer<typeof saveManagerAssessmentSchema>;
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
export type FinalizeReviewInput = z.infer<typeof finalizeReviewSchema>;
export type CancelReviewInput = z.infer<typeof cancelReviewSchema>;
export type PerformanceReviewListQuery = z.infer<typeof performanceReviewListQuerySchema>;
export type RateCompetencyInput = z.infer<typeof rateCompetencySchema>;
export type CreateDevelopmentPlanInput = z.infer<typeof createDevelopmentPlanSchema>;
export type UpdateDevelopmentPlanInput = z.infer<typeof updateDevelopmentPlanSchema>;
export type CloseDevelopmentPlanInput = z.infer<typeof closeDevelopmentPlanSchema>;
export type CreateDevelopmentActionInput = z.infer<typeof createDevelopmentActionSchema>;
export type CompleteDevelopmentActionInput = z.infer<typeof completeDevelopmentActionSchema>;
export type DevelopmentPlanListQuery = z.infer<typeof developmentPlanListQuerySchema>;
export type PerformanceHistoryQuery = z.infer<typeof performanceHistoryQuerySchema>;
