/**
 * Every performance query and write, in one place.
 *
 * No business rules and no authorization: this file knows how to read and write
 * rows, and `performance.service.ts` decides whether it should. Following
 * `hr.repository.ts`, `attendance.repository.ts`, `recruitment.repository.ts` and
 * `training.repository.ts`.
 *
 * ### The two selects that matter most
 *
 * `reviewDetailSelect` includes both assessments, because the service needs them to
 * decide what the reader may see. **It must never be serialised directly.**
 * `presentReview` in the service nulls `managerAssessment` for an employee whose
 * manager has not submitted — the Phase 5 equivalent of Phase 4's answer-key rule,
 * and the reason that decision lives in the service rather than in a select here:
 * the answer depends on who is asking, which a select cannot know.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, `Employee`, `Department`, `Designation`, and every
 * table belonging to Sales, Purchase, Dispatch, Post Sales, Lead or RsProduct.
 * Performance *reads* Employee and Department; it creates neither, and it introduces
 * no second identity for a person.
 *
 * ### Where the concurrency safety is
 *
 *   `allocatePerformanceCode`  INSERT … ON CONFLICT DO UPDATE … RETURNING, so two
 *                              concurrent creates cannot be handed the same
 *                              reference. Never `COUNT(*) + 1`.
 *   `transitionReview`         conditional `updateMany` with a status predicate, so
 *                              two people finalising the same review at once means
 *                              one write and one zero-row result — which the service
 *                              reports as a conflict rather than overwriting.
 *   `transitionCycle`          the same, for a cycle being opened twice.
 *   `transitionGoal`           the same, for a goal being closed twice.
 *   `@@unique([cycleId, employeeId])`  one review per person per cycle, so a second
 *                              generation run cannot duplicate somebody.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

// ---------------------------------------------------------------------------
//  Shared reference selects
// ---------------------------------------------------------------------------

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  middleName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

const actorSelect = { id: true, name: true } satisfies Prisma.UserSelect;

const orgUnitRefSelect = {
  id: true,
  name: true,
  code: true,
} satisfies Prisma.DepartmentSelect;

const cycleRefSelect = {
  id: true,
  code: true,
  name: true,
} satisfies Prisma.ReviewCycleSelect;

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

const competencySelect = {
  id: true,
  cycleId: true,
  name: true,
  category: true,
  description: true,
  weight: true,
  sortOrder: true,
} satisfies Prisma.CompetencyDefinitionSelect;

const cycleRowSelect = {
  id: true,
  code: true,
  name: true,
  cadence: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  selfAssessmentDueOn: true,
  managerReviewDueOn: true,
  goalAchievementThreshold: true,
  goalPartialThreshold: true,
  createdAt: true,
  _count: { select: { reviews: true } },
} satisfies Prisma.ReviewCycleSelect;

const cycleDetailSelect = {
  ...cycleRowSelect,
  description: true,
  targetDepartmentId: true,
  targetDepartment: { select: orgUnitRefSelect },
  createdBy: { select: actorSelect },
  activatedAt: true,
  closedAt: true,
  archivedAt: true,
  closureReason: true,
  updatedAt: true,
  competencies: { select: competencySelect, orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.ReviewCycleSelect;

export type CompetencyRecord = Prisma.CompetencyDefinitionGetPayload<{
  select: typeof competencySelect;
}>;
export type CycleRowRecord = Prisma.ReviewCycleGetPayload<{ select: typeof cycleRowSelect }>;
export type CycleDetailRecord = Prisma.ReviewCycleGetPayload<{
  select: typeof cycleDetailSelect;
}>;

/**
 * Allocates the next reference in a series.
 *
 * The row lock is held until the transaction commits, which is what makes
 * concurrent allocation safe — the same mechanism `allocateEmployeeId`,
 * `allocateCaseNumber`, `allocateRecruitmentCode` and `allocateTrainingCode` use.
 * Never `COUNT(*) + 1`: two concurrent creates reading the same maximum would both
 * be handed it, and these references are quoted in appraisal conversations.
 */
export async function allocatePerformanceCode(
  tx: Prisma.TransactionClient,
  scope: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "PerformanceCodeCounter" ("scope", "lastValue", "updatedAt")
    VALUES (${scope}, 1, now())
    ON CONFLICT ("scope")
    DO UPDATE SET
      "lastValue" = "PerformanceCodeCounter"."lastValue" + 1,
      "updatedAt" = now()
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Performance code counter returned no value');
  return next;
}

export function createCycle(
  tx: Prisma.TransactionClient,
  data: Prisma.ReviewCycleUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.reviewCycle.create({ data, select: { id: true } });
}

export function createCompetencies(
  tx: Prisma.TransactionClient,
  data: Prisma.CompetencyDefinitionCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  return tx.competencyDefinition.createMany({ data });
}

export function findCycle(id: string): Promise<CycleDetailRecord | null> {
  return prisma.reviewCycle.findUnique({ where: { id }, select: cycleDetailSelect });
}

/** Just the fields a decision needs, without pulling the competency sheet. */
export function findCycleState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  targetDepartmentId: string | null;
  selfAssessmentDueOn: Date | null;
  managerReviewDueOn: Date | null;
  goalAchievementThreshold: Prisma.Decimal;
  goalPartialThreshold: Prisma.Decimal;
} | null> {
  return tx.reviewCycle.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      targetDepartmentId: true,
      selfAssessmentDueOn: true,
      managerReviewDueOn: true,
      goalAchievementThreshold: true,
      goalPartialThreshold: true,
    },
  });
}

export function listCycles(args: {
  where: Prisma.ReviewCycleWhereInput;
  take: number;
  cursor?: string;
}): Promise<CycleRowRecord[]> {
  return prisma.reviewCycle.findMany({
    where: args.where,
    select: cycleRowSelect,
    orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateCycle(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.ReviewCycleUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.reviewCycle.update({ where: { id }, data, select: { id: true } });
}

/**
 * Moves a cycle's status, but only from the status the caller expected.
 *
 * Conditional, like every other transition in this file: two people opening the
 * same cycle at once means one write and one zero-row result, and the service
 * reports the second as a conflict rather than stamping `activatedAt` twice and
 * sending every employee two notifications.
 */
export async function transitionCycle(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.ReviewCycleUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.reviewCycle.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as Prisma.Enumerable<never> } },
    data: args.data,
  });
  return result.count;
}

export function countFinalizedInCycle(
  cycleId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  return tx.performanceReview.count({ where: { cycleId, status: 'FINALIZED' } });
}

export function findCompetency(id: string): Promise<
  (CompetencyRecord & { cycle: { id: string; status: string } }) | null
> {
  return prisma.competencyDefinition.findUnique({
    where: { id },
    select: { ...competencySelect, cycle: { select: { id: true, status: true } } },
  });
}

export function createCompetency(
  tx: Prisma.TransactionClient,
  data: Prisma.CompetencyDefinitionUncheckedCreateInput,
): Promise<CompetencyRecord> {
  return tx.competencyDefinition.create({ data, select: competencySelect });
}

export function updateCompetency(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.CompetencyDefinitionUncheckedUpdateInput,
): Promise<CompetencyRecord> {
  return tx.competencyDefinition.update({ where: { id }, data, select: competencySelect });
}

export function deleteCompetency(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string }> {
  return tx.competencyDefinition.delete({ where: { id }, select: { id: true } });
}

/**
 * How many ratings reference this competency.
 *
 * The direct check behind the delete guard. A DRAFT cycle cannot have reviews —
 * `generateReviews` refuses anything but ACTIVE, and a cycle never returns to DRAFT
 * — so this is provably zero on the path the service allows. It is asked anyway,
 * because that proof spans two files and one of them could change: deleting a
 * competency cascades its ratings, and a cascade whose safety depends on an
 * inference somewhere else is the kind that eventually deletes somebody's appraisal
 * history.
 */
export function countRatingsForCompetency(
  competencyId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  return tx.competencyRating.count({ where: { competencyId } });
}

/** Competencies for a cycle, with their weights — what the averages are built from. */
export function listCompetenciesForCycle(
  cycleId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<CompetencyRecord[]> {
  return tx.competencyDefinition.findMany({
    where: { cycleId },
    select: competencySelect,
    orderBy: { sortOrder: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Goals and KPIs
// ---------------------------------------------------------------------------

const kpiSelect = {
  id: true,
  goalId: true,
  name: true,
  description: true,
  metricKind: true,
  direction: true,
  targetValue: true,
  baselineValue: true,
  currentValue: true,
  unitLabel: true,
  weight: true,
  attainment: true,
  sortOrder: true,
  lastUpdatedAt: true,
  lastUpdatedBy: { select: actorSelect },
} satisfies Prisma.PerformanceKpiSelect;

const goalRowSelect = {
  id: true,
  code: true,
  title: true,
  scope: true,
  status: true,
  employeeId: true,
  departmentId: true,
  employee: { select: employeeRefSelect },
  department: { select: orgUnitRefSelect },
  cycle: { select: cycleRefSelect },
  startOn: true,
  dueOn: true,
  weight: true,
  attainment: true,
  createdAt: true,
  _count: { select: { kpis: true } },
} satisfies Prisma.PerformanceGoalSelect;

const goalDetailSelect = {
  ...goalRowSelect,
  description: true,
  successCriteria: true,
  cycleId: true,
  createdBy: { select: actorSelect },
  closedBy: { select: actorSelect },
  closedAt: true,
  closureNote: true,
  updatedAt: true,
  kpis: { select: kpiSelect, orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.PerformanceGoalSelect;

export type KpiRecord = Prisma.PerformanceKpiGetPayload<{ select: typeof kpiSelect }>;
export type GoalRowRecord = Prisma.PerformanceGoalGetPayload<{ select: typeof goalRowSelect }>;
export type GoalDetailRecord = Prisma.PerformanceGoalGetPayload<{
  select: typeof goalDetailSelect;
}>;

export function createGoal(
  tx: Prisma.TransactionClient,
  data: Prisma.PerformanceGoalUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.performanceGoal.create({ data, select: { id: true } });
}

export function createKpis(
  tx: Prisma.TransactionClient,
  data: Prisma.PerformanceKpiCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  return tx.performanceKpi.createMany({ data });
}

export function findGoal(id: string): Promise<GoalDetailRecord | null> {
  return prisma.performanceGoal.findUnique({ where: { id }, select: goalDetailSelect });
}

/**
 * The facts an authorization decision needs about a goal.
 *
 * `ownerManagerId` is resolved here rather than in the service, because it is a
 * join — and `performance-access.ts` is pure by design, so the facts it reasons
 * about are passed in. A department goal has no owning manager, which is why the
 * field is nullable rather than absent.
 */
export async function findGoalState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  status: string;
  scope: string;
  employeeId: string | null;
  departmentId: string | null;
  cycleId: string | null;
  ownerManagerId: string | null;
} | null> {
  const row = await tx.performanceGoal.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      scope: true,
      employeeId: true,
      departmentId: true,
      cycleId: true,
      employee: { select: { managerId: true } },
      department: { select: { headId: true } },
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    scope: row.scope,
    employeeId: row.employeeId,
    departmentId: row.departmentId,
    cycleId: row.cycleId,
    // An employee goal's manager, or a department goal's head. Both are "the
    // person accountable for this goal who is not its subject".
    ownerManagerId: row.employee?.managerId ?? row.department?.headId ?? null,
  };
}

export function listGoals(args: {
  where: Prisma.PerformanceGoalWhereInput;
  take: number;
  cursor?: string;
}): Promise<GoalRowRecord[]> {
  return prisma.performanceGoal.findMany({
    where: args.where,
    select: goalRowSelect,
    orderBy: [{ dueOn: 'asc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateGoal(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.PerformanceGoalUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.performanceGoal.update({ where: { id }, data, select: { id: true } });
}

/** Conditional, so one goal cannot be closed twice by two people. */
export async function transitionGoal(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.PerformanceGoalUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.performanceGoal.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as Prisma.Enumerable<never> } },
    data: args.data,
  });
  return result.count;
}

export function findKpi(id: string, tx: Prisma.TransactionClient = prisma): Promise<
  (KpiRecord & { goal: { id: string; status: string } }) | null
> {
  return tx.performanceKpi.findUnique({
    where: { id },
    select: { ...kpiSelect, goal: { select: { id: true, status: true } } },
  });
}

export function createKpi(
  tx: Prisma.TransactionClient,
  data: Prisma.PerformanceKpiUncheckedCreateInput,
): Promise<KpiRecord> {
  return tx.performanceKpi.create({ data, select: kpiSelect });
}

export function updateKpi(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.PerformanceKpiUncheckedUpdateInput,
): Promise<KpiRecord> {
  return tx.performanceKpi.update({ where: { id }, data, select: kpiSelect });
}

export function deleteKpi(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string }> {
  return tx.performanceKpi.delete({ where: { id }, select: { id: true } });
}

export function recordKpiProgress(
  tx: Prisma.TransactionClient,
  data: Prisma.KpiProgressRecordUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.kpiProgressRecord.create({ data, select: { id: true } });
}

export function listKpiProgress(
  kpiId: string,
  take: number,
): Promise<
  {
    id: string;
    kpiId: string;
    value: Prisma.Decimal;
    note: string | null;
    recordedAt: Date;
    recordedBy: { id: string; name: string };
  }[]
> {
  return prisma.kpiProgressRecord.findMany({
    where: { kpiId },
    select: {
      id: true,
      kpiId: true,
      value: true,
      note: true,
      recordedAt: true,
      recordedBy: { select: actorSelect },
    },
    orderBy: { recordedAt: 'desc' },
    take,
  });
}

/**
 * Every KPI's weight and attainment on one goal, for the roll-up.
 *
 * Read inside the same transaction as the progress that changed one of them, so the
 * cached `PerformanceGoal.attainment` cannot drift from its inputs — which is the
 * entire justification for caching it at all.
 */
export function listKpiWeightsForGoal(
  goalId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ weight: Prisma.Decimal; attainment: Prisma.Decimal | null }[]> {
  return tx.performanceKpi.findMany({
    where: { goalId },
    select: { weight: true, attainment: true },
  });
}

/** The same one level up: a review's goals, for its own roll-up. */
export function listGoalWeightsForReview(
  reviewId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ weight: Prisma.Decimal; attainment: Prisma.Decimal | null }[]> {
  return tx.reviewGoalLink
    .findMany({
      where: { reviewId },
      select: { goal: { select: { weight: true, attainment: true } } },
    })
    .then((rows) => rows.map((r) => r.goal));
}

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

const selfAssessmentSelect = {
  achievements: true,
  challenges: true,
  developmentWishes: true,
  overallRating: true,
  submittedAt: true,
  updatedAt: true,
} satisfies Prisma.SelfAssessmentSelect;

const managerAssessmentSelect = {
  strengths: true,
  improvementAreas: true,
  comments: true,
  overallRating: true,
  promotionRecommended: true,
  submittedAt: true,
  submittedBy: { select: actorSelect },
  updatedAt: true,
} satisfies Prisma.ManagerAssessmentSelect;

const ratingSelect = {
  id: true,
  competencyId: true,
  source: true,
  rating: true,
  comments: true,
  ratedAt: true,
  ratedBy: { select: actorSelect },
} satisfies Prisma.CompetencyRatingSelect;

const reviewRowSelect = {
  id: true,
  cycleId: true,
  cycle: { select: cycleRefSelect },
  employeeId: true,
  // `userId` so the service can answer `viewerIsSubject` from the actual account
  // link rather than by comparing two differently-sourced employee codes.
  employee: { select: { ...employeeRefSelect, userId: true } },
  reviewerId: true,
  reviewer: { select: employeeRefSelect },
  status: true,
  selfOverallRating: true,
  managerOverallRating: true,
  finalRating: true,
  selfSubmittedAt: true,
  managerSubmittedAt: true,
  finalizedAt: true,
  createdAt: true,
} satisfies Prisma.PerformanceReviewSelect;

/**
 * The full review, both assessments included.
 *
 * **Never serialise this directly.** `presentReview` in the service decides what
 * the reader may see and nulls the manager's assessment for an employee whose
 * manager has not submitted. That decision depends on who is asking, which is
 * exactly what a select cannot express — so it lives one layer up, and this
 * constant's job is only to fetch everything the decision needs.
 */
const reviewDetailSelect = {
  ...reviewRowSelect,
  goalAttainment: true,
  finalizedBy: { select: actorSelect },
  finalComments: true,
  cancelledAt: true,
  cancellationReason: true,
  updatedAt: true,
  selfAssessment: { select: selfAssessmentSelect },
  managerAssessment: { select: managerAssessmentSelect },
  competencyRatings: { select: ratingSelect },
} satisfies Prisma.PerformanceReviewSelect;

export type ReviewRowRecord = Prisma.PerformanceReviewGetPayload<{
  select: typeof reviewRowSelect;
}>;
export type ReviewDetailRecord = Prisma.PerformanceReviewGetPayload<{
  select: typeof reviewDetailSelect;
}>;
export type RatingRecord = Prisma.CompetencyRatingGetPayload<{ select: typeof ratingSelect }>;

/**
 * The employees a cycle covers.
 *
 * Resolved once at generation time from the cycle's target department and who is
 * ACTIVE at that moment. Somebody who joins afterwards is deliberately not
 * retroactively owed a review for a period they were not here for — which is why
 * this is a snapshot taken by the caller rather than a live view.
 *
 * `managerId` comes back so the generator can stamp `reviewerId` on each review.
 */
export function listEligibleEmployees(args: {
  departmentId: string | null;
  employeeIds?: string[];
}): Promise<{ id: string; managerId: string | null }[]> {
  return prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      ...(args.departmentId ? { departmentId: args.departmentId } : {}),
      ...(args.employeeIds ? { id: { in: args.employeeIds } } : {}),
    },
    select: { id: true, managerId: true },
  });
}

export function createReviews(
  tx: Prisma.TransactionClient,
  data: Prisma.PerformanceReviewCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  /*
    `skipDuplicates` leans on @@unique([cycleId, employeeId]) deliberately: a second
    generation run for a cycle somebody was already covered by should be a no-op for
    them, not a failed batch that leaves half the company without reviews.
  */
  return tx.performanceReview.createMany({ data, skipDuplicates: true });
}

export function findReview(id: string): Promise<ReviewDetailRecord | null> {
  return prisma.performanceReview.findUnique({ where: { id }, select: reviewDetailSelect });
}

/**
 * The facts an authorization decision needs about a review.
 *
 * Deliberately narrow: no assessments, no ratings, no cycle sheet. Every write path
 * loads this first, decides, and only then reads what it needs — so a refused
 * request costs one small query rather than assembling a whole review.
 */
export async function findReviewState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  cycleId: string;
  employeeId: string;
  reviewerId: string | null;
  status: string;
  selfSubmittedAt: Date | null;
  managerSubmittedAt: Date | null;
  finalizedAt: Date | null;
  /**
   * The account linked to the employee being appraised, where there is one.
   *
   * Read so the service can answer "is this reader the subject" against
   * `Employee.userId` rather than by comparing employee *codes*. `User.employeeId`
   * and `Employee.employeeId` are different columns: they share one allocation
   * series so they usually agree, but linking an account does not sync them, so the
   * code comparison can be false for a genuinely linked person.
   */
  subjectUserId: string | null;
} | null> {
  const row = await tx.performanceReview.findUnique({
    where: { id },
    select: {
      id: true,
      cycleId: true,
      employeeId: true,
      reviewerId: true,
      status: true,
      selfSubmittedAt: true,
      managerSubmittedAt: true,
      finalizedAt: true,
      employee: { select: { userId: true } },
    },
  });
  if (!row) return null;

  const { employee, ...rest } = row;
  return { ...rest, subjectUserId: employee.userId };
}

export function listReviews(args: {
  where: Prisma.PerformanceReviewWhereInput;
  take: number;
  cursor?: string;
}): Promise<ReviewRowRecord[]> {
  return prisma.performanceReview.findMany({
    where: args.where,
    select: reviewRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function countReviews(where: Prisma.PerformanceReviewWhereInput): Promise<number> {
  return prisma.performanceReview.count({ where });
}

/**
 * Moves a review's status, but only from the status the caller expected.
 *
 * **The concurrency control for finalisation.** Two approvers pressing finalise at
 * the same moment both pass the authorization check — it is a read — and both reach
 * here. The status predicate means one `updateMany` matches and the other matches
 * nothing, so the service sees a count of 0 and reports a conflict instead of
 * stamping `finalizedById` twice and sending the employee two notifications.
 *
 * The same mechanism guards duplicate submissions on either assessment.
 */
export async function transitionReview(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.PerformanceReviewUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.performanceReview.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as Prisma.Enumerable<never> } },
    data: args.data,
  });
  return result.count;
}

export function upsertSelfAssessment(
  tx: Prisma.TransactionClient,
  reviewId: string,
  data: Omit<Prisma.SelfAssessmentUncheckedUpdateInput, 'reviewId'>,
): Promise<{ id: string }> {
  return tx.selfAssessment.upsert({
    where: { reviewId },
    // `reviewId` last: it is the identity of the row and must not be overridable by
    // a caller's payload, which spreading it first would allow.
    create: { ...(data as Prisma.SelfAssessmentUncheckedCreateInput), reviewId },
    update: data,
    select: { id: true },
  });
}

export function upsertManagerAssessment(
  tx: Prisma.TransactionClient,
  reviewId: string,
  data: Omit<Prisma.ManagerAssessmentUncheckedUpdateInput, 'reviewId'>,
): Promise<{ id: string }> {
  return tx.managerAssessment.upsert({
    where: { reviewId },
    // `reviewId` last, for the same reason as the self-assessment above.
    create: { ...(data as Prisma.ManagerAssessmentUncheckedCreateInput), reviewId },
    update: data,
    select: { id: true },
  });
}

export function findSelfAssessment(
  reviewId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ submittedAt: Date | null } | null> {
  return tx.selfAssessment.findUnique({
    where: { reviewId },
    select: { submittedAt: true },
  });
}

export function findManagerAssessment(
  reviewId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ submittedAt: Date | null } | null> {
  return tx.managerAssessment.findUnique({
    where: { reviewId },
    select: { submittedAt: true },
  });
}

/**
 * Writes one competency rating, replacing this source's previous answer.
 *
 * Upsert on `(reviewId, competencyId, source)` — the unique key that does the real
 * work here. An employee attempting to file a MANAGER-sourced rating collides with
 * the manager's own row rather than silently adding a second opinion the averages
 * would then include.
 */
export function upsertRating(
  tx: Prisma.TransactionClient,
  args: {
    reviewId: string;
    competencyId: string;
    source: string;
    rating: number;
    comments: string | null;
    ratedById: string;
  },
): Promise<{ id: string }> {
  return tx.competencyRating.upsert({
    where: {
      reviewId_competencyId_source: {
        reviewId: args.reviewId,
        competencyId: args.competencyId,
        source: args.source as never,
      },
    },
    create: {
      reviewId: args.reviewId,
      competencyId: args.competencyId,
      source: args.source as never,
      rating: args.rating,
      comments: args.comments,
      ratedById: args.ratedById,
    },
    update: {
      rating: args.rating,
      comments: args.comments,
      ratedById: args.ratedById,
    },
    select: { id: true },
  });
}

/** One source's ratings on a review, with the competency weights, for an average. */
export function listRatingsWithWeights(
  reviewId: string,
  source: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ rating: number; weight: Prisma.Decimal }[]> {
  return tx.competencyRating
    .findMany({
      where: { reviewId, source: source as never },
      select: { rating: true, competency: { select: { weight: true } } },
    })
    .then((rows) => rows.map((r) => ({ rating: r.rating, weight: r.competency.weight })));
}

export function linkGoalsToReview(
  tx: Prisma.TransactionClient,
  data: Prisma.ReviewGoalLinkCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  return tx.reviewGoalLink.createMany({ data, skipDuplicates: true });
}

export function listReviewGoals(
  reviewId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<GoalRowRecord[]> {
  return tx.reviewGoalLink
    .findMany({
      where: { reviewId },
      select: { goal: { select: goalRowSelect } },
      orderBy: { createdAt: 'asc' },
    })
    .then((rows) => rows.map((r) => r.goal));
}

/**
 * Snapshots each linked goal's attainment at finalisation.
 *
 * One statement per link rather than a bulk update, because each carries a
 * different value. Called inside the finalisation transaction so the snapshot is of
 * the figures the approver actually saw.
 */
export async function snapshotReviewGoals(
  tx: Prisma.TransactionClient,
  reviewId: string,
): Promise<number> {
  const links = await tx.reviewGoalLink.findMany({
    where: { reviewId },
    select: { id: true, goal: { select: { attainment: true } } },
  });

  for (const link of links) {
    await tx.reviewGoalLink.update({
      where: { id: link.id },
      data: { attainmentAtFinalisation: link.goal.attainment },
    });
  }

  return links.length;
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

const actionSelect = {
  id: true,
  planId: true,
  description: true,
  dueOn: true,
  isCompleted: true,
  completedAt: true,
  completedBy: { select: actorSelect },
  sortOrder: true,
} satisfies Prisma.DevelopmentActionSelect;

const planRowSelect = {
  id: true,
  employeeId: true,
  employee: { select: employeeRefSelect },
  kind: true,
  status: true,
  title: true,
  reviewOn: true,
  reviewId: true,
  createdAt: true,
  _count: { select: { actions: true } },
} satisfies Prisma.DevelopmentPlanSelect;

const planDetailSelect = {
  ...planRowSelect,
  objective: true,
  supportOffered: true,
  createdBy: { select: actorSelect },
  closedBy: { select: actorSelect },
  closedAt: true,
  outcomeNote: true,
  updatedAt: true,
  actions: { select: actionSelect, orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.DevelopmentPlanSelect;

export type ActionRecord = Prisma.DevelopmentActionGetPayload<{ select: typeof actionSelect }>;
export type PlanRowRecord = Prisma.DevelopmentPlanGetPayload<{ select: typeof planRowSelect }>;
export type PlanDetailRecord = Prisma.DevelopmentPlanGetPayload<{
  select: typeof planDetailSelect;
}>;

export function createPlan(
  tx: Prisma.TransactionClient,
  data: Prisma.DevelopmentPlanUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.developmentPlan.create({ data, select: { id: true } });
}

export function createActions(
  tx: Prisma.TransactionClient,
  data: Prisma.DevelopmentActionCreateManyInput[],
): Promise<Prisma.BatchPayload> {
  return tx.developmentAction.createMany({ data });
}

export function findPlan(id: string): Promise<PlanDetailRecord | null> {
  return prisma.developmentPlan.findUnique({ where: { id }, select: planDetailSelect });
}

/** The facts an authorization decision needs, including the subject's manager. */
export async function findPlanState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  employeeId: string;
  status: string;
  kind: string;
  subjectManagerId: string | null;
} | null> {
  const row = await tx.developmentPlan.findUnique({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      status: true,
      kind: true,
      employee: { select: { managerId: true } },
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    kind: row.kind,
    subjectManagerId: row.employee.managerId,
  };
}

export function listPlans(args: {
  where: Prisma.DevelopmentPlanWhereInput;
  take: number;
  cursor?: string;
}): Promise<PlanRowRecord[]> {
  return prisma.developmentPlan.findMany({
    where: args.where,
    select: planRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updatePlan(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.DevelopmentPlanUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.developmentPlan.update({ where: { id }, data, select: { id: true } });
}

/** Conditional, so one plan cannot be closed twice. */
export async function transitionPlan(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.DevelopmentPlanUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.developmentPlan.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as Prisma.Enumerable<never> } },
    data: args.data,
  });
  return result.count;
}

export function createAction(
  tx: Prisma.TransactionClient,
  data: Prisma.DevelopmentActionUncheckedCreateInput,
): Promise<ActionRecord> {
  return tx.developmentAction.create({ data, select: actionSelect });
}

export function findActionState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; planId: string; isCompleted: boolean } | null> {
  return tx.developmentAction.findUnique({
    where: { id },
    select: { id: true, planId: true, isCompleted: true },
  });
}

export function updateAction(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.DevelopmentActionUncheckedUpdateInput,
): Promise<ActionRecord> {
  return tx.developmentAction.update({ where: { id }, data, select: actionSelect });
}

export function deleteAction(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string }> {
  return tx.developmentAction.delete({ where: { id }, select: { id: true } });
}

export function countCompletedActions(
  planId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  return tx.developmentAction.count({ where: { planId, isCompleted: true } });
}

// ---------------------------------------------------------------------------
//  Dashboard, history and reports
// ---------------------------------------------------------------------------

/**
 * Whether this person manages anybody.
 *
 * One existence check rather than counting reports: the scope rules only ask
 * "manager or not", and counting would read every report row to answer a boolean.
 * The same shape `attendance.service.ts` and `training.service.ts` use.
 */
export async function hasDirectReports(employeeId: string): Promise<boolean> {
  const row = await prisma.employee.findFirst({
    where: { managerId: employeeId, status: 'ACTIVE' },
    select: { id: true },
  });
  return row !== null;
}

/** The acting person's own employee row, with their manager — for scoping. */
export function findEmployeeForScope(
  employeeId: string,
): Promise<{ id: string; managerId: string | null; departmentId: string | null } | null> {
  return prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, managerId: true, departmentId: true },
  });
}

/**
 * Review counts by status within a scope.
 *
 * `groupBy` returning a Map rather than an annotated Prisma type, following
 * `post-sales.repository.ts`'s `lastActivityFor` convention — the generated groupBy
 * return type is awkward to annotate and the Map is what every caller wants.
 */
export async function countReviewsByStatus(
  where: Prisma.PerformanceReviewWhereInput,
): Promise<Map<string, number>> {
  const rows = await prisma.performanceReview.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  return new Map(rows.map((r) => [r.status, r._count._all]));
}

export async function countGoalsByStatus(
  where: Prisma.PerformanceGoalWhereInput,
): Promise<Map<string, number>> {
  const rows = await prisma.performanceGoal.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  return new Map(rows.map((r) => [r.status, r._count._all]));
}

export function countActiveCycles(): Promise<number> {
  return prisma.reviewCycle.count({ where: { status: 'ACTIVE' } });
}

export function countOpenImprovementPlans(
  where: Prisma.DevelopmentPlanWhereInput,
): Promise<number> {
  return prisma.developmentPlan.count({
    where: { ...where, kind: 'IMPROVEMENT', status: 'OPEN' },
  });
}

/**
 * Overdue self-assessments and manager reviews within a scope.
 *
 * Counted against the cycle's due date in the database rather than filtered in
 * JavaScript, so the figure is a real count and not the length of one page. The
 * `todayKey` boundary is passed in as a Date by the service, derived from company
 * time — a count computed off the server's local clock would differ by a day for
 * part of every day.
 */
export function countOverdueSelfAssessments(
  where: Prisma.PerformanceReviewWhereInput,
  today: Date,
): Promise<number> {
  return prisma.performanceReview.count({
    where: {
      ...where,
      selfSubmittedAt: null,
      status: { in: ['NOT_STARTED', 'SELF_ASSESSMENT'] },
      cycle: { selfAssessmentDueOn: { lt: today } },
    },
  });
}

export function countOverdueManagerReviews(
  where: Prisma.PerformanceReviewWhereInput,
  today: Date,
): Promise<number> {
  return prisma.performanceReview.count({
    where: {
      ...where,
      managerSubmittedAt: null,
      status: { in: ['PENDING_MANAGER', 'MANAGER_REVIEW'] },
      cycle: { managerReviewDueOn: { lt: today } },
    },
  });
}

export function countOverdueGoals(
  where: Prisma.PerformanceGoalWhereInput,
  today: Date,
): Promise<number> {
  return prisma.performanceGoal.count({
    where: { ...where, status: 'ACTIVE', dueOn: { lt: today } },
  });
}

/**
 * One employee's finalized reviews, oldest first.
 *
 * Finalized only, deliberately: a history including drafts and cancellations would
 * make a trend line out of noise. Oldest first because that is the direction a
 * trend is read in.
 */
export function listFinalizedReviews(args: {
  employeeId: string;
  from?: Date;
  to?: Date;
}): Promise<
  {
    id: string;
    finalRating: Prisma.Decimal | null;
    goalAttainment: Prisma.Decimal | null;
    finalizedAt: Date | null;
    reviewer: { id: string; employeeId: string; firstName: string; middleName: string | null; lastName: string } | null;
    cycle: { id: string; code: string; name: string; periodStart: Date; periodEnd: Date };
  }[]
> {
  return prisma.performanceReview.findMany({
    where: {
      employeeId: args.employeeId,
      status: 'FINALIZED',
      ...(args.from || args.to
        ? {
            finalizedAt: {
              ...(args.from ? { gte: args.from } : {}),
              ...(args.to ? { lte: args.to } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      finalRating: true,
      goalAttainment: true,
      finalizedAt: true,
      reviewer: { select: employeeRefSelect },
      cycle: {
        select: { id: true, code: true, name: true, periodStart: true, periodEnd: true },
      },
    },
    orderBy: { finalizedAt: 'asc' },
  });
}

/** Finalized ratings in a cycle, for the distribution and average. */
export function listCycleFinalRatings(
  cycleId: string,
): Promise<{ finalRating: Prisma.Decimal | null; goalAttainment: Prisma.Decimal | null }[]> {
  return prisma.performanceReview.findMany({
    where: { cycleId, status: 'FINALIZED' },
    select: { finalRating: true, goalAttainment: true },
  });
}

/**
 * A cycle's reviews grouped by the employee's department.
 *
 * Returned raw and aggregated by the service, because the grouping key lives on a
 * joined table — `groupBy` cannot reach through a relation, and a raw query here
 * would duplicate the scoping logic the service already applies.
 */
export function listCycleReviewsForReport(cycleId: string): Promise<
  {
    status: string;
    finalRating: Prisma.Decimal | null;
    employee: { departmentId: string | null; department: { id: string; name: string; code: string } | null };
  }[]
> {
  return prisma.performanceReview.findMany({
    where: { cycleId },
    select: {
      status: true,
      finalRating: true,
      employee: {
        select: {
          departmentId: true,
          department: { select: orgUnitRefSelect },
        },
      },
    },
  });
}

/** Active employees reporting to somebody, for a manager's dashboard figures. */
export function listReportIds(managerId: string): Promise<string[]> {
  return prisma.employee
    .findMany({ where: { managerId, status: 'ACTIVE' }, select: { id: true } })
    .then((rows) => rows.map((r) => r.id));
}

/** An employee's display identity, for presenting a history or a report header. */
export function findEmployeeRef(id: string): Promise<{
  id: string;
  employeeId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
} | null> {
  return prisma.employee.findUnique({ where: { id }, select: employeeRefSelect });
}

/** Whether an employee exists and is readable, plus the facts scoping needs. */
export function findEmployeeState(
  id: string,
): Promise<{ id: string; managerId: string | null; status: string } | null> {
  return prisma.employee.findUnique({
    where: { id },
    select: { id: true, managerId: true, status: true },
  });
}

export function findDepartmentState(
  id: string,
): Promise<{ id: string; status: string; headId: string | null } | null> {
  return prisma.department.findUnique({
    where: { id },
    select: { id: true, status: true, headId: true },
  });
}

/** Employee ids with a login, for notifying. Performance writes no notifications. */
export function findUserIdsForEmployees(
  employeeIds: string[],
): Promise<{ id: string; userId: string | null }[]> {
  return prisma.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, userId: true },
  });
}

/** The current instant from Postgres, so every stamp shares one clock. */
export async function databaseNow(tx: Prisma.TransactionClient = prisma): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error('Database returned no current time');
  return now;
}
