/**
 * HR Phase 5 — cycles, competencies, goals and KPIs.
 *
 * Reviews, assessments, finalisation and development plans live in
 * `performance-review.service.ts`. Split the way Phase 4 split training from
 * assessments: this file owns *what the business is aiming at*, that one owns *what
 * happened*, and neither is small enough to share a file comfortably.
 *
 * ### Every decision here is made twice
 *
 * Capability in the route table via `requirePermission`, then again here. The route
 * table cannot see rows — whether this actor is the goal's owner, whether the cycle
 * is still DRAFT — so it admits anybody holding the grant and this layer decides. A
 * check in only one of the two places is a check that one refactor removes.
 *
 * ### Attainment is computed here and nowhere else
 *
 * `performance.calc.ts` does the arithmetic; this file calls it inside the same
 * transaction as the progress that changed the inputs, then writes the cached
 * `attainment` on the KPI and rolls it up to the goal. Caching it is a deliberate
 * trade for the dashboard's sake, and writing it in the same transaction is what
 * stops the cache drifting from its inputs.
 *
 * The browser never computes any of it. A performance figure that two tiers
 * disagree about is a figure somebody will dispute.
 */

import { Prisma } from '@prisma/client';
import {
  DEFAULT_KPI_WEIGHT,
  type CloseGoalInput,
  type CompetencyDefinitionView,
  type CreateCompetencyInput,
  type CreateGoalInput,
  type CreateKpiInput,
  type CreateReviewCycleInput,
  type GoalListQuery,
  type GoalPage,
  type GoalSummary,
  type GoalView,
  type KpiProgressEntry,
  type KpiView,
  type RecordKpiProgressInput,
  type ReviewCycleListQuery,
  type ReviewCyclePage,
  type ReviewCycleSummary,
  type ReviewCycleView,
  type UpdateCompetencyInput,
  type UpdateGoalInput,
  type UpdateKpiInput,
  type UpdateReviewCycleInput,
} from '@rs/shared';
import type { Request } from 'express';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  mayAssignGoals,
  mayCloseGoal,
  mayEditGoal,
  mayManageCycles,
  mayOperateCycle,
  mayRecordProgress,
  performanceScope,
  visibleGoalFilter,
  type PerformanceScope,
} from './performance-access.js';
import {
  goalAttainment,
  kpiAttainment,
  outcomeContradictsAttainment,
  suggestGoalOutcome,
} from './performance.calc.js';
import * as repo from './performance.repository.js';

/** Matching the budget every other module's transactions use. */
export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** Bounded, so a long-running KPI's history cannot become an unbounded read. */
const PROGRESS_PAGE = 100;

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------

export const notFound = (): AppError =>
  new AppError('NOT_FOUND', 404, 'That record could not be found.');

const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());
const dayKey = (v: Date | null): string | null =>
  v === null ? null : v.toISOString().slice(0, 10);
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

const personName = (r: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}): string =>
  [r.firstName, r.middleName, r.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ');

export function toEmployeeRef(r: {
  id: string;
  employeeId: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
}): { id: string; employeeId: string; displayName: string } {
  return { id: r.id, employeeId: r.employeeId, displayName: personName(r) };
}

/** Today in company time (IST, +5:30 fixed) — the convention every HR date uses. */
const COMPANY_OFFSET_MINUTES = 330;
export function companyDayKey(now: Date): string {
  return new Date(now.getTime() + COMPANY_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Midnight of the company-time day, as an instant.
 *
 * What the overdue counts compare against. Derived from the company day rather than
 * from the server's local midnight, so the figure does not shift for part of every
 * day depending on where the process happens to run.
 */
export function companyTodayStart(now: Date): Date {
  return new Date(`${companyDayKey(now)}T00:00:00.000Z`);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * The reader's performance scope, resolved once per request.
 *
 * The `hasReports` lookup is skipped entirely for somebody holding the module:
 * their scope is `all` regardless, so a query to discover whether they manage
 * anybody would be wasted on every request an HR administrator makes.
 */
export async function scopeForRequest(actor: HrActor): Promise<PerformanceScope> {
  if (actor.can('HR_PERFORMANCE', 'VIEW')) return { kind: 'all' };
  if (actor.employeeId === null) return { kind: 'none' };

  const hasReports = await repo.hasDirectReports(actor.employeeId);
  return performanceScope(actor, { hasReports });
}

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

function presentCompetency(row: repo.CompetencyRecord): CompetencyDefinitionView {
  return {
    id: row.id,
    cycleId: row.cycleId,
    name: row.name,
    category: row.category,
    description: row.description,
    weight: row.weight.toString(),
    sortOrder: row.sortOrder,
  };
}

function presentCycleSummary(
  row: repo.CycleRowRecord,
  finalizedCount: number,
): ReviewCycleSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    cadence: row.cadence,
    status: row.status,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    selfAssessmentDueOn: dayKey(row.selfAssessmentDueOn),
    managerReviewDueOn: dayKey(row.managerReviewDueOn),
    goalAchievementThreshold: row.goalAchievementThreshold.toString(),
    goalPartialThreshold: row.goalPartialThreshold.toString(),
    reviewCount: row._count.reviews,
    finalizedCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentCycleView(
  row: repo.CycleDetailRecord,
  finalizedCount: number,
): ReviewCycleView {
  return {
    ...presentCycleSummary(row, finalizedCount),
    description: row.description,
    targetDepartment: row.targetDepartment,
    competencies: row.competencies.map(presentCompetency),
    createdBy: row.createdBy,
    activatedAt: iso(row.activatedAt),
    closedAt: iso(row.closedAt),
    archivedAt: iso(row.archivedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentKpi(row: repo.KpiRecord): KpiView {
  return {
    id: row.id,
    goalId: row.goalId,
    name: row.name,
    description: row.description,
    metricKind: row.metricKind,
    direction: row.direction,
    targetValue: row.targetValue.toString(),
    baselineValue: dec(row.baselineValue),
    currentValue: dec(row.currentValue),
    unitLabel: row.unitLabel,
    weight: row.weight.toString(),
    attainment: dec(row.attainment),
    lastUpdatedAt: iso(row.lastUpdatedAt),
    lastUpdatedBy: row.lastUpdatedBy,
    sortOrder: row.sortOrder,
  };
}

export function presentGoalSummary(row: repo.GoalRowRecord, todayKey: string): GoalSummary {
  const dueKey = row.dueOn.toISOString().slice(0, 10);
  const settled =
    row.status === 'ACHIEVED' ||
    row.status === 'PARTIALLY_MET' ||
    row.status === 'MISSED' ||
    row.status === 'CANCELLED';

  return {
    id: row.id,
    code: row.code,
    title: row.title,
    scope: row.scope,
    status: row.status,
    employee: row.employee ? toEmployeeRef(row.employee) : null,
    department: row.department,
    cycle: row.cycle,
    startOn: row.startOn.toISOString().slice(0, 10),
    dueOn: dueKey,
    weight: row.weight.toString(),
    attainment: dec(row.attainment),
    kpiCount: row._count.kpis,
    // Derived against the company-time day, not the viewer's clock — so a colleague
    // abroad does not see a goal flagged overdue a day early.
    isOverdue: !settled && dueKey < todayKey,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentGoalView(row: repo.GoalDetailRecord, todayKey: string): GoalView {
  return {
    ...presentGoalSummary(row, todayKey),
    description: row.description,
    successCriteria: row.successCriteria,
    kpis: row.kpis.map(presentKpi),
    createdBy: row.createdBy,
    closedBy: row.closedBy,
    closedAt: iso(row.closedAt),
    closureNote: row.closureNote,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

/**
 * Creating a cycle.
 *
 * Born DRAFT so the competency sheet, dates and thresholds can be settled before
 * anybody is reviewed against a half-built form. The reference comes from the atomic
 * counter inside the creating transaction — never from the client, and never from
 * `COUNT(*) + 1`.
 *
 * The competency sheet is written in the same transaction. A cycle with no
 * competencies cannot be reviewed against, so creating one and then failing to add
 * them would leave a cycle that looks ready and is not.
 */
export async function createCycle(
  req: Request,
  actor: HrActor,
  input: CreateReviewCycleInput,
): Promise<ReviewCycleView> {
  if (!mayManageCycles(actor)) {
    throw AppError.forbidden('Designing a review cycle needs HR_PERFORMANCE:CREATE.');
  }

  if (input.targetDepartmentId) {
    const department = await repo.findDepartmentState(input.targetDepartmentId);
    if (!department) throw AppError.badRequest('DEPARTMENT_NOT_FOUND', 'That department could not be found.');
    if (department.status !== 'ACTIVE') {
      throw AppError.badRequest(
        'DEPARTMENT_NOT_ACTIVE',
        'A cycle cannot target an archived department.',
      );
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const year = input.periodStart.getUTCFullYear();
    const next = await repo.allocatePerformanceCode(tx, `PRF-${year}`);
    const code = `PRF-${year}-${String(next).padStart(4, '0')}`;

    const cycle = await repo.createCycle(tx, {
      code,
      name: input.name,
      description: input.description ?? null,
      cadence: input.cadence,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      selfAssessmentDueOn: input.selfAssessmentDueOn ?? null,
      managerReviewDueOn: input.managerReviewDueOn ?? null,
      targetDepartmentId: input.targetDepartmentId ?? null,
      ...(input.goalAchievementThreshold !== undefined
        ? { goalAchievementThreshold: input.goalAchievementThreshold }
        : {}),
      ...(input.goalPartialThreshold !== undefined
        ? { goalPartialThreshold: input.goalPartialThreshold }
        : {}),
      createdById: actor.id,
    });

    if (input.competencies && input.competencies.length > 0) {
      await repo.createCompetencies(
        tx,
        input.competencies.map((c, index) => ({
          cycleId: cycle.id,
          name: c.name,
          category: c.category,
          description: c.description ?? null,
          ...(c.weight !== undefined ? { weight: c.weight } : {}),
          sortOrder: c.sortOrder ?? index,
        })),
      );
    }

    return cycle;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_REVIEW_CYCLE_CREATED',
    entityType: 'ReviewCycle',
    entityId: created.id,
    actorId: actor.id,
  });

  return getCycle(actor, created.id);
}

export async function getCycle(actor: HrActor, id: string): Promise<ReviewCycleView> {
  /*
    Readable by anybody who can reach the module at all, including an employee with
    no grant: a cycle is the terms they are being judged against, and withholding
    them would be withholding the rules of their own appraisal. Nothing on a cycle
    is personal to anybody.
  */
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') throw notFound();

  const row = await repo.findCycle(id);
  if (!row) throw notFound();

  const finalized = await repo.countFinalizedInCycle(id);
  return presentCycleView(row, finalized);
}

export async function listCycles(
  actor: HrActor,
  query: ReviewCycleListQuery,
): Promise<ReviewCyclePage> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') return { items: [], nextCursor: null };

  const where: Prisma.ReviewCycleWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.cadence ? { cadence: query.cadence } : {}),
    ...(query.departmentId ? { targetDepartmentId: query.departmentId } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const rows = await repo.listCycles({
    where,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  /*
    Finalised counts for the page, one query rather than one per row. A cycle list
    of 25 would otherwise issue 26 queries, which is how a list page becomes slow
    in a way nobody notices until there are a hundred cycles.
  */
  const finalizedCounts = await Promise.all(
    page.map((row) => repo.countFinalizedInCycle(row.id)),
  );

  return {
    items: page.map((row, index) => presentCycleSummary(row, finalizedCounts[index] ?? 0)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Amending a cycle.
 *
 * The period and the thresholds are refused once the cycle is ACTIVE. Reviews have
 * already been judged against them, and moving the goalposts mid-cycle silently
 * rescores work that is already done — a goal closed as ACHIEVED at a 100%
 * threshold would be wrong the moment the threshold moved to 110.
 *
 * Names and due dates stay editable: those do not change anybody's result.
 */
export async function updateCycle(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateReviewCycleInput,
): Promise<ReviewCycleView> {
  if (!mayManageCycles(actor)) {
    throw AppError.forbidden('Amending a review cycle needs HR_PERFORMANCE:CREATE.');
  }

  const state = await repo.findCycleState(id);
  if (!state) throw notFound();

  if (state.status === 'ARCHIVED') {
    throw AppError.badRequest('CYCLE_ARCHIVED', 'An archived cycle cannot be amended.');
  }

  const touchesScoring =
    input.periodStart !== undefined ||
    input.periodEnd !== undefined ||
    input.goalAchievementThreshold !== undefined ||
    input.goalPartialThreshold !== undefined;

  if (touchesScoring && state.status !== 'DRAFT') {
    throw AppError.badRequest(
      'CYCLE_SCORING_LOCKED',
      'The period and thresholds cannot change once a cycle has opened — reviews have already been judged against them.',
    );
  }

  // Checked here as well as by the CHECK, because the CHECK sees only the row after
  // the update and cannot produce a message naming which field was wrong.
  const start = input.periodStart ?? state.periodStart;
  const end = input.periodEnd ?? state.periodEnd;
  if (end < start) {
    throw AppError.badRequest('CYCLE_PERIOD_INVALID', 'The period cannot end before it starts.');
  }

  const achievement = input.goalAchievementThreshold;
  const partial = input.goalPartialThreshold;
  const effectiveAchievement =
    achievement !== undefined
      ? new Prisma.Decimal(achievement)
      : state.goalAchievementThreshold;
  const effectivePartial =
    partial !== undefined ? new Prisma.Decimal(partial) : state.goalPartialThreshold;

  if (effectivePartial.greaterThan(effectiveAchievement)) {
    throw AppError.badRequest(
      'CYCLE_THRESHOLDS_INVALID',
      'The partial threshold cannot be above the achievement threshold.',
    );
  }

  await prisma.$transaction(
    (tx) =>
      repo.updateCycle(tx, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
        ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
        ...(input.selfAssessmentDueOn !== undefined
          ? { selfAssessmentDueOn: input.selfAssessmentDueOn }
          : {}),
        ...(input.managerReviewDueOn !== undefined
          ? { managerReviewDueOn: input.managerReviewDueOn }
          : {}),
        ...(input.targetDepartmentId !== undefined
          ? { targetDepartmentId: input.targetDepartmentId }
          : {}),
        ...(achievement !== undefined ? { goalAchievementThreshold: achievement } : {}),
        ...(partial !== undefined ? { goalPartialThreshold: partial } : {}),
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_REVIEW_CYCLE_UPDATED',
    entityType: 'ReviewCycle',
    entityId: id,
    actorId: actor.id,
    newValue: input as Record<string, unknown>,
  });

  return getCycle(actor, id);
}

/**
 * Opening a cycle.
 *
 * APPROVE, not CREATE: this makes every employee in scope owe a self-assessment
 * with a deadline, which commits the organisation. The same line APPROVE marks
 * everywhere else in HR.
 *
 * The transition is conditional on DRAFT, so two people opening the same cycle at
 * once means one write and one conflict — rather than two `activatedAt` stamps and
 * every employee receiving two notifications.
 *
 * A cycle with no competencies is refused. It would produce reviews nobody can
 * rate, and discovering that after notifying the whole company is worse than
 * refusing now.
 */
export async function activateCycle(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<ReviewCycleView> {
  if (!mayOperateCycle(actor)) {
    throw AppError.forbidden('Opening a review cycle needs HR_PERFORMANCE:APPROVE.');
  }

  const state = await repo.findCycleState(id);
  if (!state) throw notFound();
  if (state.status !== 'DRAFT') {
    throw AppError.conflict('CYCLE_NOT_DRAFT', 'Only a draft cycle can be opened.');
  }

  const competencies = await repo.listCompetenciesForCycle(id);
  if (competencies.length === 0) {
    throw AppError.badRequest(
      'CYCLE_HAS_NO_COMPETENCIES',
      'Add at least one competency before opening the cycle — otherwise its reviews cannot be rated.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionCycle(tx, {
      id,
      fromStatuses: ['DRAFT'],
      data: { status: 'ACTIVE', activatedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('CYCLE_ALREADY_OPEN', 'That cycle has already been opened.');
  }

  await recordAudit(req, {
    action: 'HR_REVIEW_CYCLE_OPENED',
    entityType: 'ReviewCycle',
    entityId: id,
    actorId: actor.id,
  });

  return getCycle(actor, id);
}

/** Closing a cycle. Stops new submissions; leaves everything readable. */
export async function closeCycle(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<ReviewCycleView> {
  if (!mayOperateCycle(actor)) {
    throw AppError.forbidden('Closing a review cycle needs HR_PERFORMANCE:APPROVE.');
  }

  const state = await repo.findCycleState(id);
  if (!state) throw notFound();
  if (state.status !== 'ACTIVE') {
    throw AppError.conflict('CYCLE_NOT_ACTIVE', 'Only an open cycle can be closed.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionCycle(tx, {
      id,
      fromStatuses: ['ACTIVE'],
      data: { status: 'CLOSED', closedAt: now, closureReason: reason },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('CYCLE_ALREADY_CLOSED', 'That cycle has already been closed.');
  }

  await recordAudit(req, {
    action: 'HR_REVIEW_CYCLE_CLOSED',
    entityType: 'ReviewCycle',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  return getCycle(actor, id);
}

/** Archiving a closed cycle. History, and nothing more. */
export async function archiveCycle(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<ReviewCycleView> {
  if (!mayOperateCycle(actor)) {
    throw AppError.forbidden('Archiving a review cycle needs HR_PERFORMANCE:APPROVE.');
  }

  const state = await repo.findCycleState(id);
  if (!state) throw notFound();
  if (state.status !== 'CLOSED') {
    throw AppError.conflict(
      'CYCLE_NOT_CLOSED',
      'A cycle has to be closed before it can be archived.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionCycle(tx, {
      id,
      fromStatuses: ['CLOSED'],
      data: { status: 'ARCHIVED', archivedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('CYCLE_ALREADY_ARCHIVED', 'That cycle has already been archived.');
  }

  await recordAudit(req, {
    action: 'HR_REVIEW_CYCLE_ARCHIVED',
    entityType: 'ReviewCycle',
    entityId: id,
    actorId: actor.id,
  });

  return getCycle(actor, id);
}

// ---------------------------------------------------------------------------
//  Competencies
// ---------------------------------------------------------------------------

/**
 * Adding a competency to a cycle.
 *
 * DRAFT only. A sheet that grew mid-cycle would mean two employees rated against
 * different sets of attributes in the same appraisal round, and the second would be
 * missing a rating nobody asked them for.
 */
export async function addCompetency(
  req: Request,
  actor: HrActor,
  cycleId: string,
  input: CreateCompetencyInput,
): Promise<CompetencyDefinitionView> {
  if (!mayManageCycles(actor)) {
    throw AppError.forbidden('Editing a competency sheet needs HR_PERFORMANCE:CREATE.');
  }

  const state = await repo.findCycleState(cycleId);
  if (!state) throw notFound();
  if (state.status !== 'DRAFT') {
    throw AppError.badRequest(
      'CYCLE_SHEET_LOCKED',
      'The competency sheet is fixed once a cycle opens — otherwise two people in one round would be rated on different things.',
    );
  }

  const existing = await repo.listCompetenciesForCycle(cycleId);

  try {
    const created = await prisma.$transaction(
      (tx) =>
        repo.createCompetency(tx, {
          cycleId,
          name: input.name,
          category: input.category,
          description: input.description ?? null,
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          sortOrder: input.sortOrder ?? existing.length,
        }),
      TX_OPTIONS,
    );

    await recordAudit(req, {
      action: 'HR_COMPETENCY_ADDED',
      entityType: 'CompetencyDefinition',
      entityId: created.id,
      actorId: actor.id,
    });

    return presentCompetency(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'COMPETENCY_DUPLICATE',
        'That competency is already on this cycle’s sheet.',
      );
    }
    throw error;
  }
}

export async function updateCompetency(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateCompetencyInput,
): Promise<CompetencyDefinitionView> {
  if (!mayManageCycles(actor)) {
    throw AppError.forbidden('Editing a competency sheet needs HR_PERFORMANCE:CREATE.');
  }

  const existing = await repo.findCompetency(id);
  if (!existing) throw notFound();
  if (existing.cycle.status !== 'DRAFT') {
    throw AppError.badRequest(
      'CYCLE_SHEET_LOCKED',
      'The competency sheet is fixed once a cycle opens.',
    );
  }

  try {
    const updated = await prisma.$transaction(
      (tx) =>
        repo.updateCompetency(tx, id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        }),
      TX_OPTIONS,
    );

    await recordAudit(req, {
      action: 'HR_COMPETENCY_UPDATED',
      entityType: 'CompetencyDefinition',
      entityId: id,
      actorId: actor.id,
      newValue: input as Record<string, unknown>,
    });

    return presentCompetency(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'COMPETENCY_DUPLICATE',
        'Another competency on this sheet already has that name.',
      );
    }
    throw error;
  }
}

export async function removeCompetency(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<{ removed: boolean }> {
  if (!mayManageCycles(actor)) {
    throw AppError.forbidden('Editing a competency sheet needs HR_PERFORMANCE:CREATE.');
  }

  const existing = await repo.findCompetency(id);
  if (!existing) throw notFound();
  if (existing.cycle.status !== 'DRAFT') {
    throw AppError.badRequest(
      'CYCLE_SHEET_LOCKED',
      'The competency sheet is fixed once a cycle opens — removing one would delete ratings already given.',
    );
  }

  /*
    The belt to the DRAFT check's braces. Deleting a competency cascades its
    ratings, so a referenced one must never be removed — history is preserved and
    the operation refused rather than the rows deleted.

    Unreachable through the API today, since a DRAFT cycle cannot have reviews. It
    is checked because the alternative is a cascade whose safety rests on an
    inference in a different file.
  */
  const ratings = await repo.countRatingsForCompetency(id);
  if (ratings > 0) {
    throw AppError.conflict(
      'COMPETENCY_IN_USE',
      `This competency has already been rated ${ratings} ${ratings === 1 ? 'time' : 'times'}. It cannot be removed — removing it would delete those ratings.`,
    );
  }

  await prisma.$transaction((tx) => repo.deleteCompetency(tx, id), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_COMPETENCY_REMOVED',
    entityType: 'CompetencyDefinition',
    entityId: id,
    actorId: actor.id,
  });

  return { removed: true };
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

/**
 * Creating a goal.
 *
 * ASSIGN, because setting a goal places an obligation with a deadline on somebody —
 * the same grant Phase 4 uses for putting a colleague into a course.
 *
 * Born DRAFT. Agreeing it is a separate act, so a goal that was imposed and one
 * that was agreed are distinguishable, and the agreement carries an author.
 *
 * KPIs are written in the same transaction: a goal with no measure is an intention,
 * and the requirement is explicit that targets be measurable.
 */
export async function createGoal(
  req: Request,
  actor: HrActor,
  input: CreateGoalInput,
): Promise<GoalView> {
  if (!mayAssignGoals(actor)) {
    throw AppError.forbidden('Setting a goal needs HR_PERFORMANCE:ASSIGN.');
  }

  if (input.scope === 'EMPLOYEE') {
    const employee = await repo.findEmployeeState(input.employeeId as string);
    if (!employee) {
      throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
    }
    if (employee.status !== 'ACTIVE') {
      throw AppError.badRequest(
        'EMPLOYEE_NOT_ACTIVE',
        'A goal cannot be set for somebody who has left.',
      );
    }
  } else {
    const department = await repo.findDepartmentState(input.departmentId as string);
    if (!department) {
      throw AppError.badRequest('DEPARTMENT_NOT_FOUND', 'That department could not be found.');
    }
    if (department.status !== 'ACTIVE') {
      throw AppError.badRequest(
        'DEPARTMENT_NOT_ACTIVE',
        'A goal cannot be set for an archived department.',
      );
    }
  }

  if (input.cycleId) {
    const cycle = await repo.findCycleState(input.cycleId);
    if (!cycle) throw AppError.badRequest('CYCLE_NOT_FOUND', 'That cycle could not be found.');
    if (cycle.status === 'ARCHIVED') {
      throw AppError.badRequest(
        'CYCLE_ARCHIVED',
        'A goal cannot be attached to an archived cycle.',
      );
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const year = input.startOn.getUTCFullYear();
    const next = await repo.allocatePerformanceCode(tx, `GOL-${year}`);
    const code = `GOL-${year}-${String(next).padStart(4, '0')}`;

    const goal = await repo.createGoal(tx, {
      code,
      title: input.title,
      description: input.description ?? null,
      successCriteria: input.successCriteria ?? null,
      scope: input.scope,
      employeeId: input.scope === 'EMPLOYEE' ? (input.employeeId as string) : null,
      departmentId: input.scope === 'DEPARTMENT' ? (input.departmentId as string) : null,
      cycleId: input.cycleId ?? null,
      startOn: input.startOn,
      dueOn: input.dueOn,
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      createdById: actor.id,
    });

    if (input.kpis && input.kpis.length > 0) {
      await repo.createKpis(
        tx,
        input.kpis.map((k, index) => ({
          goalId: goal.id,
          name: k.name,
          description: k.description ?? null,
          metricKind: k.metricKind,
          ...(k.direction !== undefined ? { direction: k.direction } : {}),
          targetValue: k.targetValue,
          baselineValue: k.baselineValue ?? null,
          unitLabel: k.unitLabel ?? null,
          weight: k.weight ?? DEFAULT_KPI_WEIGHT,
          sortOrder: k.sortOrder ?? index,
        })),
      );
    }

    return goal;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_GOAL_CREATED',
    entityType: 'PerformanceGoal',
    entityId: created.id,
    actorId: actor.id,
  });

  return getGoal(actor, created.id);
}

export async function getGoal(actor: HrActor, id: string): Promise<GoalView> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') throw notFound();

  const row = await repo.findGoal(id);
  if (!row) throw notFound();

  /*
    Scope enforced by re-querying with the visibility filter rather than comparing
    fields here. The filter is the same expression the list uses, so a goal
    reachable by id is exactly a goal that would have appeared in the list — and the
    two cannot drift into disagreeing.

    Not found rather than forbidden: telling somebody "you may not see goal X"
    confirms X exists and whose it is.
  */
  const visible = await repo.listGoals({
    where: {
      id,
      ...(visibleGoalFilter(scope) as Prisma.PerformanceGoalWhereInput),
    },
    take: 1,
  });
  if (visible.length === 0) throw notFound();

  const now = await repo.databaseNow();
  return presentGoalView(row, companyDayKey(now));
}

export async function listGoals(actor: HrActor, query: GoalListQuery): Promise<GoalPage> {
  const scope = await scopeForRequest(actor);
  if (scope.kind === 'none') return { items: [], nextCursor: null };

  const now = await repo.databaseNow();
  const todayKey = companyDayKey(now);

  const where: Prisma.PerformanceGoalWhereInput = {
    ...(visibleGoalFilter(scope) as Prisma.PerformanceGoalWhereInput),
    ...(query.scope ? { scope: query.scope } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.cycleId ? { cycleId: query.cycleId } : {}),
    ...(query.overdueOnly
      ? {
          status: 'ACTIVE' as const,
          dueOn: { lt: companyTodayStart(now) },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' as const } },
            { code: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const rows = await repo.listGoals({
    where,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: page.map((row) => presentGoalSummary(row, todayKey)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function updateGoal(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateGoalInput,
): Promise<GoalView> {
  const state = await repo.findGoalState(id);
  if (!state) throw notFound();

  if (!mayEditGoal(actor, state)) {
    /*
      One message for both "you are not entitled" and "this goal is settled",
      because the two want different words and the second is the commoner case.
    */
    throw AppError.forbidden(
      state.status === 'ACTIVE' || state.status === 'DRAFT'
        ? 'Only this goal’s manager or HR can amend it — and an employee cannot amend their own target.'
        : 'A closed goal cannot be amended. Its outcome has already been recorded.',
    );
  }

  const existing = await repo.findGoal(id);
  if (!existing) throw notFound();

  const start = input.startOn ?? existing.startOn;
  const due = input.dueOn ?? existing.dueOn;
  if (due < start) {
    throw AppError.badRequest('GOAL_DATES_INVALID', 'A goal cannot be due before it starts.');
  }

  if (input.cycleId) {
    const cycle = await repo.findCycleState(input.cycleId);
    if (!cycle) throw AppError.badRequest('CYCLE_NOT_FOUND', 'That cycle could not be found.');
  }

  await prisma.$transaction(
    (tx) =>
      repo.updateGoal(tx, id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.successCriteria !== undefined
          ? { successCriteria: input.successCriteria }
          : {}),
        ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
        ...(input.startOn !== undefined ? { startOn: input.startOn } : {}),
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_GOAL_UPDATED',
    entityType: 'PerformanceGoal',
    entityId: id,
    actorId: actor.id,
    newValue: input as Record<string, unknown>,
  });

  return getGoal(actor, id);
}

/**
 * Agreeing a goal — DRAFT to ACTIVE.
 *
 * Its own act rather than a status field, so the agreement carries a timestamp and
 * an author. A goal cannot be worked against until it is agreed, and progress
 * against a DRAFT goal is refused by `mayRecordProgress`.
 */
export async function activateGoal(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<GoalView> {
  const state = await repo.findGoalState(id);
  if (!state) throw notFound();

  if (!mayEditGoal(actor, state)) {
    throw AppError.forbidden('Only this goal’s manager or HR can agree it.');
  }
  if (state.status !== 'DRAFT') {
    throw AppError.conflict('GOAL_NOT_DRAFT', 'Only a draft goal can be agreed.');
  }

  const changed = await prisma.$transaction(
    (tx) =>
      repo.transitionGoal(tx, {
        id,
        fromStatuses: ['DRAFT'],
        data: { status: 'ACTIVE' },
      }),
    TX_OPTIONS,
  );

  if (changed === 0) {
    throw AppError.conflict('GOAL_ALREADY_ACTIVE', 'That goal has already been agreed.');
  }

  await recordAudit(req, {
    action: 'HR_GOAL_ACTIVATED',
    entityType: 'PerformanceGoal',
    entityId: id,
    actorId: actor.id,
  });

  return getGoal(actor, id);
}

/**
 * Closing a goal with its outcome.
 *
 * ### The judgement is the manager's; the arithmetic is the server's
 *
 * `suggestGoalOutcome` computes what the recorded attainment implies, against **the
 * cycle's own thresholds** — never a constant. The closing manager states the
 * outcome, which may differ: a target missed because the market moved is a different
 * thing from one missed through inattention, and a system that auto-graded it would
 * be wrong in exactly the cases a human appraisal exists to handle.
 *
 * When the two disagree, a note is required. That is the compromise: the override is
 * allowed and it has to be explained, so the record shows both the figure and the
 * reasoning.
 *
 * Never the goal's owner — `mayCloseGoal` refuses the subject first, whatever grants
 * they hold. Declaring your own target achieved is the same act as approving your
 * own review.
 */
export async function closeGoal(
  req: Request,
  actor: HrActor,
  id: string,
  input: CloseGoalInput,
): Promise<GoalView> {
  const state = await repo.findGoalState(id);
  if (!state) throw notFound();

  if (!mayCloseGoal(actor, state)) {
    throw AppError.forbidden(
      state.status === 'ACTIVE' || state.status === 'DRAFT'
        ? 'Closing a goal needs HR_PERFORMANCE:APPROVE or the owner’s manager — and never the owner themselves.'
        : 'That goal is already closed.',
    );
  }

  const goal = await repo.findGoal(id);
  if (!goal) throw notFound();

  /*
    The thresholds come from the goal's cycle where it has one, and from the column
    defaults otherwise. Read per goal rather than held in a constant, which is what
    makes a stretch cycle's 110% threshold actually take effect.
  */
  let achievement = new Prisma.Decimal(100);
  let partial = new Prisma.Decimal(50);
  if (state.cycleId) {
    const cycle = await repo.findCycleState(state.cycleId);
    if (cycle) {
      achievement = cycle.goalAchievementThreshold;
      partial = cycle.goalPartialThreshold;
    }
  }

  const suggested = suggestGoalOutcome(goal.attainment, { achievement, partial });

  if (
    outcomeContradictsAttainment(input.outcome, suggested) &&
    (input.closureNote === undefined || input.closureNote.trim().length < 5)
  ) {
    throw AppError.badRequest(
      'OUTCOME_NEEDS_EXPLANATION',
      `The figures suggest ${suggested ?? 'no outcome'} but you have recorded ${input.outcome}. Say why — an override with no reason cannot be explained later.`,
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    return repo.transitionGoal(tx, {
      id,
      fromStatuses: ['DRAFT', 'ACTIVE'],
      data: {
        status: input.outcome,
        closedById: actor.id,
        closedAt: now,
        closureNote: input.closureNote ?? null,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('GOAL_ALREADY_CLOSED', 'That goal has already been closed.');
  }

  await recordAudit(req, {
    action: 'HR_GOAL_CLOSED',
    entityType: 'PerformanceGoal',
    entityId: id,
    actorId: actor.id,
    newValue: {
      outcome: input.outcome,
      suggested,
      attainment: goal.attainment?.toString() ?? null,
    },
  });

  return getGoal(actor, id);
}

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

export async function addKpi(
  req: Request,
  actor: HrActor,
  goalId: string,
  input: CreateKpiInput,
): Promise<KpiView> {
  const state = await repo.findGoalState(goalId);
  if (!state) throw notFound();

  if (!mayEditGoal(actor, state)) {
    throw AppError.forbidden('Only this goal’s manager or HR can add an indicator to it.');
  }

  // A BOOLEAN indicator's target is 1 — a CHECK enforces it, and saying so here
  // produces a message naming the field rather than a constraint violation.
  if (input.metricKind === 'BOOLEAN' && input.targetValue !== 1) {
    throw AppError.badRequest(
      'BOOLEAN_TARGET_INVALID',
      'A done/not-done indicator has a target of 1.',
    );
  }
  if (input.targetValue === 0) {
    throw AppError.badRequest(
      'TARGET_ZERO',
      'A target of zero has no proportion to measure against. For "zero defects", use a lower-is-better indicator with a small target.',
    );
  }

  const existing = await repo.findGoal(goalId);

  try {
    const created = await prisma.$transaction(
      (tx) =>
        repo.createKpi(tx, {
          goalId,
          name: input.name,
          description: input.description ?? null,
          metricKind: input.metricKind,
          ...(input.direction !== undefined ? { direction: input.direction } : {}),
          targetValue: input.targetValue,
          baselineValue: input.baselineValue ?? null,
          unitLabel: input.unitLabel ?? null,
          weight: input.weight ?? DEFAULT_KPI_WEIGHT,
          sortOrder: input.sortOrder ?? (existing?.kpis.length ?? 0),
        }),
      TX_OPTIONS,
    );

    await recordAudit(req, {
      action: 'HR_KPI_ADDED',
      entityType: 'PerformanceKpi',
      entityId: created.id,
      actorId: actor.id,
    });

    return presentKpi(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('KPI_DUPLICATE', 'This goal already has an indicator with that name.');
    }
    throw error;
  }
}

/**
 * Amending a KPI's definition.
 *
 * Changing the target or the direction **recomputes attainment** in the same
 * transaction, because the stored figure was computed against the old definition and
 * would otherwise be stale in a way nobody can see. The goal's roll-up follows.
 *
 * `metricKind` cannot be changed at all — the schema has no field for it. A 40 that
 * meant "40 orders" becoming "40%" would reinterpret every recorded value.
 */
export async function updateKpi(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateKpiInput,
): Promise<KpiView> {
  const existing = await repo.findKpi(id);
  if (!existing) throw notFound();

  const state = await repo.findGoalState(existing.goalId);
  if (!state) throw notFound();

  if (!mayEditGoal(actor, state)) {
    throw AppError.forbidden('Only this goal’s manager or HR can amend its indicators.');
  }

  if (input.targetValue === 0) {
    throw AppError.badRequest(
      'TARGET_ZERO',
      'A target of zero has no proportion to measure against.',
    );
  }
  if (existing.metricKind === 'BOOLEAN' && input.targetValue !== undefined && input.targetValue !== 1) {
    throw AppError.badRequest(
      'BOOLEAN_TARGET_INVALID',
      'A done/not-done indicator has a target of 1.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await repo.updateKpi(tx, id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.targetValue !== undefined ? { targetValue: input.targetValue } : {}),
      ...(input.baselineValue !== undefined ? { baselineValue: input.baselineValue } : {}),
      ...(input.unitLabel !== undefined ? { unitLabel: input.unitLabel } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    });

    /*
      Recompute against the new definition. Skipped when nothing scoring-relevant
      changed — renaming an indicator must not rewrite its attainment, because the
      write would look like a measurement nobody took.
    */
    const scoringChanged =
      input.targetValue !== undefined ||
      input.baselineValue !== undefined ||
      input.direction !== undefined;

    if (scoringChanged) {
      const attainment = kpiAttainment({
        metricKind: row.metricKind,
        direction: row.direction,
        targetValue: row.targetValue,
        baselineValue: row.baselineValue,
        currentValue: row.currentValue,
      });
      const rescored = await repo.updateKpi(tx, id, { attainment });
      await rollUpGoal(tx, existing.goalId);
      return rescored;
    }

    if (input.weight !== undefined) await rollUpGoal(tx, existing.goalId);
    return row;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_KPI_UPDATED',
    entityType: 'PerformanceKpi',
    entityId: id,
    actorId: actor.id,
    newValue: input as Record<string, unknown>,
  });

  return presentKpi(updated);
}

export async function removeKpi(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<{ removed: boolean }> {
  const existing = await repo.findKpi(id);
  if (!existing) throw notFound();

  const state = await repo.findGoalState(existing.goalId);
  if (!state) throw notFound();

  if (!mayEditGoal(actor, state)) {
    throw AppError.forbidden('Only this goal’s manager or HR can remove its indicators.');
  }

  await prisma.$transaction(async (tx) => {
    await repo.deleteKpi(tx, id);
    // The goal's roll-up changes when an indicator leaves it.
    await rollUpGoal(tx, existing.goalId);
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_KPI_REMOVED',
    entityType: 'PerformanceKpi',
    entityId: id,
    actorId: actor.id,
  });

  return { removed: true };
}

/**
 * Recording progress on a KPI.
 *
 * ### The whole arithmetic chain, in one transaction
 *
 * The movement is appended to `KpiProgressRecord` (append-only, so the history of a
 * number cannot be quietly rewritten), the KPI's `currentValue` and `attainment` are
 * updated, and the goal's roll-up follows — all inside one transaction. That is what
 * makes the cached attainment trustworthy: it cannot be read in a state where the
 * value and the derived figure disagree.
 *
 * ### The client sends a measurement and nothing else
 *
 * No attainment, no percentage. `recordKpiProgressSchema` has no field for one, and
 * `kpiAttainment` computes it from the value, the target, the baseline and the
 * direction. A client-supplied attainment would be a client-supplied performance
 * result.
 *
 * Allowed for the goal's owner as well as their manager: they are the one who knows
 * the number, and making them ask would mean the figures are always stale. They
 * cannot change the target, which is the part that matters.
 */
export async function recordProgress(
  req: Request,
  actor: HrActor,
  kpiId: string,
  input: RecordKpiProgressInput,
): Promise<KpiView> {
  const existing = await repo.findKpi(kpiId);
  if (!existing) throw notFound();

  const state = await repo.findGoalState(existing.goalId);
  if (!state) throw notFound();

  if (!mayRecordProgress(actor, state)) {
    throw AppError.forbidden(
      state.status === 'ACTIVE'
        ? 'Only this goal’s owner, their manager or HR can record progress on it.'
        : 'Progress can only be recorded against an agreed, open goal.',
    );
  }

  if (existing.metricKind === 'BOOLEAN' && input.value !== 0 && input.value !== 1) {
    throw AppError.badRequest(
      'BOOLEAN_VALUE_INVALID',
      'A done/not-done indicator records 0 or 1.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);

    await repo.recordKpiProgress(tx, {
      kpiId,
      value: input.value,
      note: input.note ?? null,
      recordedById: actor.id,
      recordedAt: now,
    });

    const value = new Prisma.Decimal(input.value);
    const attainment = kpiAttainment({
      metricKind: existing.metricKind,
      direction: existing.direction,
      targetValue: existing.targetValue,
      baselineValue: existing.baselineValue,
      currentValue: value,
    });

    const row = await repo.updateKpi(tx, kpiId, {
      currentValue: value,
      attainment,
      lastUpdatedById: actor.id,
      lastUpdatedAt: now,
    });

    await rollUpGoal(tx, existing.goalId);
    return row;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_KPI_PROGRESS_RECORDED',
    entityType: 'PerformanceKpi',
    entityId: kpiId,
    actorId: actor.id,
    newValue: { value: input.value },
  });

  return presentKpi(updated);
}

/**
 * Recomputes a goal's cached attainment from its KPIs.
 *
 * Always called inside the transaction that changed an input, which is the entire
 * justification for caching the figure at all — a cache written in a separate
 * transaction could be read between the two and would be wrong.
 */
async function rollUpGoal(tx: Prisma.TransactionClient, goalId: string): Promise<void> {
  const kpis = await repo.listKpiWeightsForGoal(goalId, tx);
  const attainment = goalAttainment(kpis);
  await repo.updateGoal(tx, goalId, { attainment });
}

export async function listProgress(
  actor: HrActor,
  kpiId: string,
): Promise<KpiProgressEntry[]> {
  const existing = await repo.findKpi(kpiId);
  if (!existing) throw notFound();

  // Reuses the goal's own visibility, so a KPI's history is readable by exactly
  // whoever may read the goal. One rule rather than two that could disagree.
  await getGoal(actor, existing.goalId);

  const rows = await repo.listKpiProgress(kpiId, PROGRESS_PAGE);
  return rows.map((row) => ({
    id: row.id,
    kpiId: row.kpiId,
    value: row.value.toString(),
    note: row.note,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
  }));
}
