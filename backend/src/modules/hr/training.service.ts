/**
 * Training — the catalogue and enrollment business rules.
 *
 * Every decision lives here; the repository executes and the controller translates.
 * Assessment grading and the qualification gate are in `assessment.service.ts`,
 * split because this file already carries the catalogue and enrollment lifecycle.
 *
 * ### Authorization is checked here, not only in the route table
 *
 * Each exported function re-checks what it needs through `training-access.ts`. The
 * route table is the first gate and this is the second, deliberately: a route can
 * only know "may this person reach the module", while "may this person review *this*
 * submission" needs the row. Anything that depends on a row is decided here.
 *
 * ### Nothing here writes Employee, User or a permission row
 *
 * Training reads the employee directory and the department tree; it creates
 * neither, and it has no second RBAC, audit or notification system.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PASSING_SCORE,
  REQUIRED_JOURNEY_TEMPLATE,
  type AssignTrainingInput,
  type CompleteModuleInput,
  type CreateTrainingCategoryInput,
  type CreateTrainingModuleInput,
  type CreateTrainingProgramInput,
  type TrainingCategoryView,
  type TrainingEnrollmentListQuery,
  type TrainingEnrollmentSummary,
  type TrainingModuleView,
  type TrainingProgramListQuery,
  type TrainingProgramSummary,
  type TrainingProgramView,
  type UpdateTrainingCategoryInput,
  type UpdateTrainingModuleInput,
  type UpdateTrainingProgramInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  type TrainingScope,
  mayApproveTraining,
  mayAssignTraining,
  mayCreatePrograms,
  mayEditPrograms,
  mayExemptTraining,
  mayViewLearner,
  trainingScope,
  visibleLearnerFilter,
} from './training-access.js';
import { dueDateFrom, isOverdue } from './training.calc.js';
import * as notifications from './training.notify.js';
import * as repo from './training.repository.js';

export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

/**
 * The reader's training scope, resolved once per request.
 *
 * The `hasReports` lookup is skipped entirely for somebody holding the module:
 * their scope is `all` regardless, so a query to discover whether they manage
 * anybody would be wasted on every request a training administrator makes.
 */
export async function scopeForRequest(actor: HrActor): Promise<TrainingScope> {
  if (actor.can('HR_TRAINING', 'VIEW')) return { kind: 'all' };
  if (actor.employeeId === null) return { kind: 'none' };

  const hasReports = await repo.hasReports(actor.employeeId);
  return trainingScope(actor, { hasReports });
}

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());
const dayKey = (v: Date | null): string | null =>
  v === null ? null : v.toISOString().slice(0, 10);
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

const personName = (r: { firstName: string; lastName: string }): string =>
  `${r.firstName} ${r.lastName}`.trim();

export function toEmployeeRef(r: {
  id: string;
  employeeId: string;
  firstName: string;
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

export const notFound = (): AppError =>
  new AppError('NOT_FOUND', 404, 'That record could not be found.');

function presentCategory(row: repo.CategoryRecord): TrainingCategoryView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    programCount: row._count.programs,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentModule(row: repo.ModuleRecord): TrainingModuleView {
  return {
    id: row.id,
    programId: row.programId,
    title: row.title,
    kind: row.kind,
    sortOrder: row.sortOrder,
    content: row.content,
    referenceUrl: row.referenceUrl,
    secureDocumentId: row.secureDocumentId,
    isRequired: row.isRequired,
    instructions: row.instructions,
    estimatedMinutes: row.estimatedMinutes,
    assessmentId: row.assessment?.id ?? null,
  };
}

function presentProgramRow(
  row: repo.ProgramRowRecord,
  counts: { live: number; completed: number },
): TrainingProgramSummary {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    category: row.category,
    status: row.status,
    obligation: row.obligation,
    targetDepartment: row.targetDepartment,
    targetDesignation: row.targetDesignation,
    estimatedMinutes: row.estimatedMinutes,
    passingScore: row.passingScore.toString(),
    maxAttempts: row.maxAttempts,
    moduleCount: row._count.modules,
    enrolledCount: counts.live,
    completedCount: counts.completed,
    createdAt: row.createdAt.toISOString(),
  };
}

export function presentProgram(
  row: repo.ProgramDetailRecord,
  counts: { live: number; completed: number },
): TrainingProgramView {
  return {
    ...presentProgramRow(row as unknown as repo.ProgramRowRecord, counts),
    description: row.description,
    objectives: row.objectives,
    requiresPractical: row.requiresPractical,
    requiresShadowing: row.requiresShadowing,
    requiresFinalAssessment: row.requiresFinalAssessment,
    dueWithinDays: row.dueWithinDays,
    modules: row.modules.map(presentModule),
    assessments: row.assessments.map((a) => ({
      id: a.id,
      programId: a.programId,
      moduleId: a.moduleId,
      title: a.title,
      // The effective threshold: the assessment's own, or the program's. Never a
      // constant — see training.calc.ts.
      passingScore: (a.passingScore ?? row.passingScore).toString(),
      maxAttempts: a.maxAttempts ?? row.maxAttempts,
      timeLimitMinutes: a.timeLimitMinutes,
      isFinal: a.isFinal,
      isActive: a.isActive,
      questionCount: a._count.questions,
      totalPoints: '0.00',
    })),
    createdBy: row.createdBy,
    publishedAt: iso(row.publishedAt),
    archivedAt: iso(row.archivedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function presentEnrollmentRow(
  row: repo.EnrollmentRowRecord,
  context: { todayKey: string; completedModules: number; requiredModules: number },
): TrainingEnrollmentSummary {
  return {
    id: row.id,
    employee: toEmployeeRef(row.employee),
    program: row.program,
    status: row.status,
    obligation: row.obligation,
    assignedVia: row.assignedVia as TrainingEnrollmentSummary['assignedVia'],
    assignedAt: row.assignedAt.toISOString(),
    dueOn: dayKey(row.dueOn),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    isOverdue: isOverdue(row.dueOn, context.todayKey, row.status),
    completedModuleCount: context.completedModules,
    requiredModuleCount: context.requiredModules,
  };
}

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export async function createCategory(
  req: Request,
  actor: HrActor,
  input: CreateTrainingCategoryInput,
): Promise<TrainingCategoryView> {
  if (!mayCreatePrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Creating a training category needs HR_TRAINING:CREATE.');
  }

  // Checked before the write for a useful message, and again by the unique index so
  // a race cannot slip past — the shape every other module in this codebase uses.
  const existing = await repo.findCategoryByCode(input.code);
  if (existing) {
    throw AppError.conflict('CATEGORY_EXISTS', 'A category with that code already exists.');
  }

  const row = await prisma.$transaction(
    (tx) =>
      repo.createCategory(tx, {
        name: input.name,
        code: input.code,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdById: actor.id,
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_CATEGORY_CREATED',
    entityType: 'TrainingCategory',
    entityId: row.id,
    actorId: actor.id,
    newValue: { code: row.code, name: row.name },
  });

  return presentCategory(row);
}

export async function listCategories(isActive?: boolean): Promise<TrainingCategoryView[]> {
  const rows = await repo.listCategories(isActive === undefined ? {} : { isActive });
  return rows.map(presentCategory);
}

export async function updateCategory(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateTrainingCategoryInput,
): Promise<TrainingCategoryView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a training category needs HR_TRAINING:EDIT.');
  }

  const row = await prisma.$transaction(
    (tx) => repo.updateCategory(tx, id, input as Prisma.TrainingCategoryUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_CATEGORY_UPDATED',
    entityType: 'TrainingCategory',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  return presentCategory(row);
}

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

/**
 * Allocates a program reference, shaped `TRN-<year>-<n>`.
 *
 * The year comes from the database's clock rather than the server's, for the reason
 * every instant in HR does: a server with a wrong clock would file a 2026 program
 * under 2025 and the series would then contain two of some numbers.
 */
async function allocateProgramCode(tx: Prisma.TransactionClient): Promise<string> {
  const now = await databaseNow(tx);
  const year = now.getUTCFullYear();
  const next = await repo.allocateTrainingCode(tx, `TRN-${year}`);
  return `TRN-${year}-${String(next).padStart(4, '0')}`;
}

/**
 * Creating a program.
 *
 * Born DRAFT and unassignable. Publishing is a separate act so it carries a
 * timestamp and an audit entry naming whoever did it — a program that could be born
 * ACTIVE would be assignable to real people with no record of who made it so.
 *
 * `seedRequiredJourney` materialises `REQUIRED_JOURNEY_TEMPLATE` as ordinary module
 * rows. That is the only place the template is read: afterwards the modules are
 * plain data and can be reordered, removed or added to, and no service consults the
 * template again.
 */
export async function createProgram(
  req: Request,
  actor: HrActor,
  input: CreateTrainingProgramInput,
): Promise<TrainingProgramView> {
  if (!mayCreatePrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Creating a training program needs HR_TRAINING:CREATE.');
  }

  if (input.categoryId) await assertCategoryUsable(input.categoryId);
  if (input.targetDepartmentId) await assertDepartmentUsable(input.targetDepartmentId);
  if (input.targetDesignationId) await assertDesignationUsable(input.targetDesignationId);

  const id = await prisma.$transaction(async (tx) => {
    const code = await allocateProgramCode(tx);

    const created = await repo.createProgram(tx, {
      code,
      title: input.title,
      description: input.description ?? null,
      objectives: input.objectives ?? null,
      categoryId: input.categoryId ?? null,
      targetDepartmentId: input.targetDepartmentId ?? null,
      targetDesignationId: input.targetDesignationId ?? null,
      obligation: input.obligation ?? 'OPTIONAL',
      estimatedMinutes: input.estimatedMinutes ?? null,
      /*
        Omitted means the column default applies — 80 and 3. That is where the
        business default lives; nothing in the services compares against the
        constant.
      */
      ...(input.passingScore === undefined ? {} : { passingScore: input.passingScore }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      requiresPractical: input.requiresPractical ?? false,
      requiresShadowing: input.requiresShadowing ?? false,
      requiresFinalAssessment: input.requiresFinalAssessment ?? true,
      dueWithinDays: input.dueWithinDays ?? null,
      // Not accepted from the caller.
      status: 'DRAFT',
      createdById: actor.id,
    });

    if (input.seedRequiredJourney === true) {
      await repo.createModules(
        tx,
        REQUIRED_JOURNEY_TEMPLATE.map((step, index) => ({
          programId: created.id,
          title: step.title,
          kind: step.kind,
          sortOrder: index,
          isRequired: true,
          /*
            A practical or shadowing step must carry instructions — the CHECK
            enforces it — so the seed supplies a placeholder the author will replace.
            Seeding without them would fail the constraint and the whole create.
          */
          instructions:
            step.kind === 'PRACTICAL'
              ? 'Describe the practical exercise the learner must complete.'
              : step.kind === 'SHADOWING'
                ? 'Describe what the learner should observe while shadowing.'
                : null,
        })),
      );
    }

    return created.id;
  }, TX_OPTIONS);

  const row = await repo.findProgram(id);
  if (!row) throw notFound();

  await recordAudit(req, {
    action: 'HR_TRAINING_PROGRAM_CREATED',
    entityType: 'TrainingProgram',
    entityId: id,
    actorId: actor.id,
    newValue: {
      code: row.code,
      title: row.title,
      passingScore: row.passingScore.toString(),
      maxAttempts: row.maxAttempts,
      seeded: input.seedRequiredJourney === true,
    },
  });

  return presentProgram(row, { live: 0, completed: 0 });
}

export async function listPrograms(
  query: TrainingProgramListQuery,
): Promise<{ items: TrainingProgramSummary[]; nextCursor: string | null }> {
  /*
    The catalogue is readable by any signed-in employee — see `mayViewCatalogue`.
    Knowing a "Customer psychology" course exists discloses nothing, and hiding it
    from learners would mean they could not see what they are being asked to do.
    Progress and results are scoped separately.
  */
  const where: Prisma.TrainingProgramWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.departmentId ? { targetDepartmentId: query.departmentId } : {}),
    ...(query.obligation ? { obligation: query.obligation } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { code: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // One more than asked for, so "is there another page" needs no second count.
  const rows = await repo.listPrograms({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);
  const counts = await repo.countEnrollmentsByProgram(page.map((r) => r.id));

  return {
    items: page.map((row) =>
      presentProgramRow(row, counts.get(row.id) ?? { live: 0, completed: 0 }),
    ),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getProgram(id: string): Promise<TrainingProgramView> {
  const row = await repo.findProgram(id);
  if (!row) throw notFound();
  const counts = await repo.countEnrollmentsByProgram([id]);
  return presentProgram(row, counts.get(id) ?? { live: 0, completed: 0 });
}

export async function updateProgram(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateTrainingProgramInput,
): Promise<TrainingProgramView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a training program needs HR_TRAINING:EDIT.');
  }

  const before = await repo.findProgramPolicy(id);
  if (!before) throw notFound();

  /*
    An archived program is history. Amending its pass mark or its requirements would
    change what the people already enrolled were asked to do, which is the kind of
    quiet rewriting that makes a training record untrustworthy.
  */
  if (before.status === 'ARCHIVED') {
    throw AppError.badRequest(
      'PROGRAM_ARCHIVED',
      'An archived program cannot be changed. Create a new one.',
    );
  }

  if (input.categoryId) await assertCategoryUsable(input.categoryId);
  if (input.targetDepartmentId) await assertDepartmentUsable(input.targetDepartmentId);
  if (input.targetDesignationId) await assertDesignationUsable(input.targetDesignationId);

  await prisma.$transaction(
    (tx) => repo.updateProgram(tx, id, input as Prisma.TrainingProgramUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_PROGRAM_UPDATED',
    entityType: 'TrainingProgram',
    entityId: id,
    actorId: actor.id,
    // The threshold change specifically, because it alters what "passed" means for
    // everybody enrolled after it.
    oldValue: { passingScore: before.passingScore.toString(), maxAttempts: before.maxAttempts },
    newValue: { changed: Object.keys(input) },
  });

  return getProgram(id);
}

/**
 * Publishing a program.
 *
 * APPROVE, because it makes the program assignable to real people with real
 * deadlines. The transition is conditional on the current status, so two people
 * publishing one draft cannot both stamp a different `publishedAt`.
 *
 * A program with no modules cannot be published: somebody would be enrolled into a
 * course with nothing in it, and the enrollment would complete immediately — which
 * is worse than a visible refusal.
 */
export async function publishProgram(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<TrainingProgramView> {
  if (!mayApproveTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Publishing a program needs HR_TRAINING:APPROVE.');
  }

  const modules = await repo.listProgramModules(id);
  if (modules.length === 0) {
    throw AppError.badRequest(
      'PROGRAM_EMPTY',
      'Add at least one module before publishing — an empty program would complete itself.',
    );
  }

  /*
    A program requiring a final assessment must have one before it can be published.
    Otherwise nobody enrolled could ever qualify, and the reason would only surface
    when somebody finished every module and was still refused.
  */
  const policy = await repo.findProgramPolicy(id);
  if (!policy) throw notFound();
  if (policy.requiresFinalAssessment) {
    const final = await repo.findProgramFinalAssessment(id);
    if (!final) {
      throw AppError.badRequest(
        'FINAL_ASSESSMENT_MISSING',
        'This program requires a final assessment. Add one, or turn the requirement off.',
      );
    }
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionProgram(tx, {
      id,
      fromStatuses: ['DRAFT', 'ARCHIVED'],
      data: { status: 'ACTIVE', publishedAt: now, archivedAt: null },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('PROGRAM_NOT_PUBLISHABLE', 'This program is already active.');
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_PROGRAM_PUBLISHED',
    entityType: 'TrainingProgram',
    entityId: id,
    actorId: actor.id,
  });

  return getProgram(id);
}

export async function archiveProgram(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<TrainingProgramView> {
  if (!mayApproveTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Archiving a program needs HR_TRAINING:APPROVE.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionProgram(tx, {
      id,
      fromStatuses: ['DRAFT', 'ACTIVE'],
      data: { status: 'ARCHIVED', archivedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('PROGRAM_ALREADY_ARCHIVED', 'This program is already archived.');
  }

  /*
    Existing enrollments are deliberately left alone. Archiving stops new
    assignments; it does not cancel work somebody is halfway through, and it does not
    erase what they completed. Mass-cancelling would discard real progress for an
    administrative act.
  */
  await recordAudit(req, {
    action: 'HR_TRAINING_PROGRAM_ARCHIVED',
    entityType: 'TrainingProgram',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  return getProgram(id);
}

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

export async function addModule(
  req: Request,
  actor: HrActor,
  programId: string,
  input: CreateTrainingModuleInput,
): Promise<TrainingModuleView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a program needs HR_TRAINING:EDIT.');
  }

  const policy = await repo.findProgramPolicy(programId);
  if (!policy) throw notFound();
  if (policy.status === 'ARCHIVED') {
    throw AppError.badRequest('PROGRAM_ARCHIVED', 'An archived program cannot be changed.');
  }

  const row = await prisma.$transaction(async (tx) => {
    // Appended unless a position was given, so building a sequence in order works
    // without the author tracking indices.
    const sortOrder =
      input.sortOrder ?? (await repo.nextModuleSortOrder(tx, programId));

    return repo.createModule(tx, {
      programId,
      title: input.title,
      kind: input.kind,
      sortOrder,
      content: input.content ?? null,
      referenceUrl: input.referenceUrl ?? null,
      secureDocumentId: input.secureDocumentId ?? null,
      isRequired: input.isRequired ?? true,
      instructions: input.instructions ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
    });
  }, TX_OPTIONS).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'MODULE_POSITION_TAKEN',
        'Another module already occupies that position.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_TRAINING_MODULE_ADDED',
    entityType: 'TrainingModule',
    entityId: row.id,
    actorId: actor.id,
    newValue: { programId, kind: row.kind, sortOrder: row.sortOrder },
  });

  return presentModule(row);
}

export async function updateModule(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateTrainingModuleInput,
): Promise<TrainingModuleView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a program needs HR_TRAINING:EDIT.');
  }

  const before = await repo.findModule(id);
  if (!before) throw notFound();

  const row = await prisma.$transaction(
    (tx) => repo.updateModule(tx, id, input as Prisma.TrainingModuleUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_MODULE_UPDATED',
    entityType: 'TrainingModule',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  return presentModule(row);
}

export async function removeModule(req: Request, actor: HrActor, id: string): Promise<void> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a program needs HR_TRAINING:EDIT.');
  }

  const before = await repo.findModule(id);
  if (!before) throw notFound();

  const policy = await repo.findProgramPolicy(before.programId);
  if (policy?.status === 'ACTIVE') {
    /*
      Removing a module from a live program would change what the people already
      enrolled were asked to do, and their progress rows would point at nothing.
      Archive the program and publish a new version instead.
    */
    throw AppError.badRequest(
      'PROGRAM_ACTIVE',
      'A module cannot be removed from an active program. Archive it and publish a new version.',
    );
  }

  await prisma.$transaction((tx) => repo.deleteModule(tx, id), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_TRAINING_MODULE_REMOVED',
    entityType: 'TrainingModule',
    entityId: id,
    actorId: actor.id,
    oldValue: { programId: before.programId, title: before.title },
  });
}

export async function reorderModules(
  req: Request,
  actor: HrActor,
  programId: string,
  moduleIds: string[],
): Promise<TrainingModuleView[]> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a program needs HR_TRAINING:EDIT.');
  }

  const existing = await repo.listProgramModules(programId);

  /*
    The submitted list must be exactly this program's modules. A partial list would
    leave the omitted ones at stale positions, and a foreign id would silently move a
    module out of somebody else's program.
  */
  const existingIds = new Set(existing.map((m) => m.id));
  if (moduleIds.length !== existing.length || !moduleIds.every((id) => existingIds.has(id))) {
    throw AppError.badRequest(
      'MODULE_ORDER_MISMATCH',
      'Send every module of this program exactly once, in the new order.',
    );
  }

  await prisma.$transaction((tx) => repo.reorderModules(tx, programId, moduleIds), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_TRAINING_MODULES_REORDERED',
    entityType: 'TrainingProgram',
    entityId: programId,
    actorId: actor.id,
    newValue: { order: moduleIds },
  });

  const rows = await repo.listProgramModules(programId);
  return rows.map(presentModule);
}

// ---------------------------------------------------------------------------
//  Assignment and enrollment
// ---------------------------------------------------------------------------

/**
 * Assigning a program.
 *
 * ### The eligible set is expanded once, here
 *
 * A department assignment resolves its members **at assignment time** and writes one
 * enrollment each, stamped `assignedVia: 'DEPARTMENT'`. It is deliberately not a
 * live membership query: an employee who later moves department keeps the
 * enrollment they were given, because a course somebody has half-finished must not
 * vanish when they change team, and re-deriving would rewrite history.
 *
 * ### Duplicates
 *
 * The partial unique index refuses a second *live* enrollment for the same
 * (employee, program). Already-enrolled employees are skipped rather than failing
 * the whole batch — assigning a course to a department where three people already
 * have it is a normal operation, not an error.
 */
export async function assignTraining(
  req: Request,
  actor: HrActor,
  input: AssignTrainingInput,
): Promise<{ assigned: number; skipped: number; enrollmentIds: string[] }> {
  if (!mayAssignTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Assigning training needs HR_TRAINING:ASSIGN.');
  }

  const policy = await repo.findProgramPolicy(input.programId);
  if (!policy) {
    throw AppError.badRequest('PROGRAM_NOT_FOUND', 'That program could not be found.');
  }
  /*
    Only a published program is assignable. A draft is unfinished — its modules may
    change under the learner's feet — and an archived one is history.
  */
  if (policy.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'PROGRAM_NOT_ASSIGNABLE',
      'Only a published program can be assigned. Publish it first.',
    );
  }

  // Resolve the eligible set, once.
  let employeeIds: string[];
  let assignedVia: 'INDIVIDUAL' | 'DEPARTMENT' | 'DESIGNATION';

  if (input.employeeIds) {
    employeeIds = [...new Set(input.employeeIds)];
    assignedVia = 'INDIVIDUAL';
    for (const id of employeeIds) await assertEmployeeAssignable(id);
  } else if (input.departmentId) {
    const rows = await repo.findEligibleEmployees({ departmentId: input.departmentId });
    employeeIds = rows.map((r) => r.id);
    assignedVia = 'DEPARTMENT';
  } else {
    const rows = await repo.findEligibleEmployees({ designationId: input.designationId });
    employeeIds = rows.map((r) => r.id);
    assignedVia = 'DESIGNATION';
  }

  if (employeeIds.length === 0) {
    throw AppError.badRequest(
      'NO_ELIGIBLE_EMPLOYEES',
      'Nobody employed matches that selection.',
    );
  }

  const obligation = input.obligation ?? policy.obligation;
  const enrollmentIds: string[] = [];
  let skipped = 0;

  const now = await databaseNow();
  const dueOn = input.dueOn ?? dueDateFrom(now, policy.dueWithinDays);

  /*
    One transaction per enrollment rather than one for the batch. A department of
    four hundred would exceed the 15-second transaction budget, and a single failure
    would roll back three hundred successful assignments — whereas per-employee means
    a conflict skips that person and the rest proceed.
  */
  for (const employeeId of employeeIds) {
    const live = await repo.findLiveEnrollment(employeeId, input.programId);
    if (live) {
      skipped += 1;
      continue;
    }

    try {
      const created = await prisma.$transaction(
        (tx) =>
          repo.createEnrollment(tx, {
            employeeId,
            programId: input.programId,
            status: 'NOT_STARTED',
            obligation,
            assignedById: actor.id,
            assignedVia,
            dueOn,
          }),
        TX_OPTIONS,
      );
      enrollmentIds.push(created.id);
    } catch (error) {
      // The partial unique index caught a concurrent assignment. Skipping is the
      // right outcome: the person is enrolled either way.
      if (isUniqueViolation(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_ASSIGNED',
    entityType: 'TrainingProgram',
    entityId: input.programId,
    actorId: actor.id,
    newValue: {
      assignedVia,
      assigned: enrollmentIds.length,
      skipped,
      obligation,
      dueOn: dueOn ? dueOn.toISOString().slice(0, 10) : null,
    },
  });

  // Mandatory work only — see training.notify.ts on why optional raises nothing.
  if (obligation === 'MANDATORY') {
    for (const enrollmentId of enrollmentIds) {
      const enrollment = await repo.findEnrollmentState(enrollmentId);
      if (!enrollment) continue;
      const userId = await repo.findUserIdForEmployee(enrollment.employeeId);
      if (userId) await notifications.notifyTrainingAssigned(userId, enrollmentId, true);
    }
  }

  return { assigned: enrollmentIds.length, skipped, enrollmentIds };
}

export async function listEnrollments(
  scope: TrainingScope,
  query: TrainingEnrollmentListQuery,
): Promise<{ items: TrainingEnrollmentSummary[]; nextCursor: string | null }> {
  const now = await databaseNow();
  const todayKey = companyDayKey(now);

  const where: Prisma.TrainingEnrollmentWhereInput = {
    ...(visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput),
    ...(query.programId ? { programId: query.programId } : {}),
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.obligation ? { obligation: query.obligation } : {}),
    ...(query.assignedVia ? { assignedVia: query.assignedVia } : {}),
    ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
    ...(query.overdueOnly
      ? {
          dueOn: { lt: new Date(`${todayKey}T00:00:00.000Z`) },
          status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { employee: { firstName: { contains: query.search, mode: 'insensitive' } } },
            { employee: { lastName: { contains: query.search, mode: 'insensitive' } } },
            { program: { title: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const rows = await repo.listEnrollments({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);

  /*
    Module counts per enrollment. Resolved in two grouped reads rather than per row —
    a page of 25 would otherwise be 50 queries.
  */
  const counts = await progressCountsFor(page.map((r) => ({ id: r.id, programId: r.program.id })));

  return {
    items: page.map((row) =>
      presentEnrollmentRow(row, {
        todayKey,
        completedModules: counts.get(row.id)?.completed ?? 0,
        requiredModules: counts.get(row.id)?.required ?? 0,
      }),
    ),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Required-module and completed-module counts for a page of enrollments. */
async function progressCountsFor(
  enrollments: { id: string; programId: string }[],
): Promise<Map<string, { required: number; completed: number }>> {
  const out = new Map<string, { required: number; completed: number }>();
  if (enrollments.length === 0) return out;

  const programIds = [...new Set(enrollments.map((e) => e.programId))];
  const requiredByProgram = new Map<string, number>();

  const moduleCounts = await prisma.trainingModule.groupBy({
    by: ['programId'],
    where: { programId: { in: programIds }, isRequired: true },
    _count: { _all: true },
  });
  for (const row of moduleCounts) requiredByProgram.set(row.programId, row._count._all);

  const progressCounts = await prisma.trainingModuleProgress.groupBy({
    by: ['enrollmentId'],
    where: {
      enrollmentId: { in: enrollments.map((e) => e.id) },
      completedAt: { not: null },
      module: { isRequired: true },
    },
    _count: { _all: true },
  });
  const completedByEnrollment = new Map(
    progressCounts.map((r) => [r.enrollmentId, r._count._all]),
  );

  for (const e of enrollments) {
    out.set(e.id, {
      required: requiredByProgram.get(e.programId) ?? 0,
      completed: completedByEnrollment.get(e.id) ?? 0,
    });
  }
  return out;
}

/**
 * Excusing somebody from training.
 *
 * APPROVE, and the reason is required by this signature, by Zod and by a CHECK —
 * "I was excused from that course" is unanswerable if the record cannot say who
 * excused them or why.
 */
export async function exemptEnrollment(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<TrainingEnrollmentSummary> {
  if (!mayExemptTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Excusing training needs HR_TRAINING:APPROVE.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionEnrollment(tx, {
      id,
      fromStatuses: ['NOT_STARTED', 'IN_PROGRESS'],
      data: {
        status: 'EXEMPTED',
        exemptedById: actor.id,
        exemptedAt: now,
        exemptionReason: reason,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ENROLLMENT_NOT_LIVE',
      'This enrollment is already finished, excused or withdrawn.',
    );
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_EXEMPTED',
    entityType: 'TrainingEnrollment',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  return getEnrollmentSummary(id);
}

export async function cancelEnrollment(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<TrainingEnrollmentSummary> {
  if (!mayAssignTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Withdrawing an assignment needs HR_TRAINING:ASSIGN.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionEnrollment(tx, {
      id,
      fromStatuses: ['NOT_STARTED', 'IN_PROGRESS'],
      data: { status: 'CANCELLED', cancelledAt: now, cancellationReason: reason },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('ENROLLMENT_NOT_LIVE', 'This enrollment is no longer live.');
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_ENROLLMENT_CANCELLED',
    entityType: 'TrainingEnrollment',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  return getEnrollmentSummary(id);
}

export async function updateEnrollmentDueDate(
  req: Request,
  actor: HrActor,
  id: string,
  dueOn: Date | null,
  reason: string,
): Promise<TrainingEnrollmentSummary> {
  if (!mayAssignTraining(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing a due date needs HR_TRAINING:ASSIGN.');
  }

  const before = await repo.findEnrollmentState(id);
  if (!before) throw notFound();

  await prisma.$transaction((tx) => repo.updateEnrollment(tx, id, { dueOn }), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_TRAINING_DUE_DATE_CHANGED',
    entityType: 'TrainingEnrollment',
    entityId: id,
    actorId: actor.id,
    oldValue: { dueOn: before.dueOn ? before.dueOn.toISOString().slice(0, 10) : null },
    newValue: { dueOn: dueOn ? dueOn.toISOString().slice(0, 10) : null, reason },
  });

  return getEnrollmentSummary(id);
}

async function getEnrollmentSummary(id: string): Promise<TrainingEnrollmentSummary> {
  const row = await repo.findEnrollment(id);
  if (!row) throw notFound();
  const now = await databaseNow();
  const counts = await progressCountsFor([{ id: row.id, programId: row.program.id }]);
  return presentEnrollmentRow(row, {
    todayKey: companyDayKey(now),
    completedModules: counts.get(row.id)?.completed ?? 0,
    requiredModules: counts.get(row.id)?.required ?? 0,
  });
}

// ---------------------------------------------------------------------------
//  Shared guards
// ---------------------------------------------------------------------------

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Loads an enrollment the reader may see.
 *
 * A not-found rather than a forbidden for an out-of-scope record: telling somebody
 * "you may not see enrollment X" confirms that X exists, which discloses that a
 * named colleague is doing a named course. The same reasoning the employee directory
 * and the recruitment pipeline apply.
 */
export async function loadVisibleEnrollment(
  id: string,
  scope: TrainingScope,
): Promise<{
  id: string;
  employeeId: string;
  programId: string;
  status: string;
  startedAt: Date | null;
  dueOn: Date | null;
  employee: { managerId: string | null };
}> {
  const row = await repo.findEnrollmentState(id);
  if (!row) throw notFound();

  const visible = mayViewLearner(scope, {
    employeeId: row.employeeId,
    managerId: row.employee.managerId,
  });
  if (!visible) throw notFound();

  return row;
}

async function assertCategoryUsable(id: string): Promise<void> {
  const row = await prisma.trainingCategory.findUnique({
    where: { id },
    select: { isActive: true },
  });
  if (!row) throw AppError.badRequest('CATEGORY_NOT_FOUND', 'That category does not exist.');
  if (!row.isActive) {
    throw AppError.badRequest('CATEGORY_INACTIVE', 'That category is no longer in use.');
  }
}

async function assertDepartmentUsable(id: string): Promise<void> {
  const row = await prisma.department.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw AppError.badRequest('DEPARTMENT_NOT_FOUND', 'That department does not exist.');
  if (row.status !== 'ACTIVE') {
    throw AppError.badRequest('DEPARTMENT_INACTIVE', 'That department is archived.');
  }
}

async function assertDesignationUsable(id: string): Promise<void> {
  const row = await prisma.designation.findUnique({ where: { id }, select: { status: true } });
  if (!row) {
    throw AppError.badRequest('DESIGNATION_NOT_FOUND', 'That designation does not exist.');
  }
  if (row.status !== 'ACTIVE') {
    throw AppError.badRequest('DESIGNATION_INACTIVE', 'That designation is archived.');
  }
}

/**
 * A departed employee cannot be assigned training.
 *
 * Checked rather than assumed: an exited employee on a mandatory course would sit in
 * every overdue report indefinitely, and the notification would go to a disabled
 * account.
 */
async function assertEmployeeAssignable(id: string): Promise<void> {
  const row = await repo.findEmployeeForTraining(id);
  if (!row) throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  if (row.status === 'EXITED') {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_EMPLOYED',
      'That person has left, so training cannot be assigned to them.',
    );
  }
}

export { DEFAULT_MAX_ATTEMPTS, DEFAULT_PASSING_SCORE };
