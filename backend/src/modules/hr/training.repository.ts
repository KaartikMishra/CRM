/**
 * Every training database read and write, and nothing else.
 *
 * No business rule lives here: the service decides, this executes. Selects are
 * shared constants rather than inline objects, so a confidential column cannot be
 * exposed by one query and withheld by another.
 *
 * ### The select that matters most
 *
 * `paperQuestionSelect` builds the question paper a learner sits, and it **omits
 * `isCorrect`**. That omission is the control which keeps the answer key off the
 * wire, and it is asserted by a test. `gradableQuestionSelect` is the separate
 * constant that *does* read correctness — used only by the grader, inside the
 * submission transaction, never serialised.
 *
 * Two constants rather than one with a flag, because a boolean parameter deciding
 * whether to include the answer key is one wrong argument away from leaking it.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, `Employee`, and every table belonging to Sales,
 * Purchase, Dispatch, Post Sales, Lead or RsProduct. Training reads Employee and
 * Department; it creates neither.
 *
 * ### Where the concurrency safety is
 *
 *   `allocateTrainingCode`     INSERT … ON CONFLICT DO UPDATE … RETURNING, so two
 *                              simultaneous creates cannot share a reference.
 *   `createEnrollment`         relies on the partial unique index — two concurrent
 *                              assignments cannot both produce a live enrollment.
 *   `startAttempt`             relies on the (enrollment, assessment, attemptNumber)
 *                              unique — two simultaneous starts cannot both claim
 *                              attempt 3, which is what makes the limit real.
 *   `settleAttempt`            conditional on status IN_PROGRESS, so a double
 *                              submit grades once.
 *   `reviewPractical`          conditional on status SUBMITTED.
 *   `signOffShadowing`         conditional on not already signed off.
 *   `createQualification`      relies on the unique enrollmentId.
 *
 * In every case the database decides the winner, not a read-then-write in the
 * service. A check-then-act would pass in both racing requests.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

// ---------------------------------------------------------------------------
//  Selects
// ---------------------------------------------------------------------------

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

const actorSelect = { id: true, name: true } satisfies Prisma.UserSelect;

const orgUnitRefSelect = {
  id: true,
  name: true,
  code: true,
} satisfies Prisma.DepartmentSelect;

const categoryRefSelect = {
  id: true,
  name: true,
  code: true,
} satisfies Prisma.TrainingCategorySelect;

const categorySelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  _count: { select: { programs: true } },
} satisfies Prisma.TrainingCategorySelect;

const moduleSelect = {
  id: true,
  programId: true,
  title: true,
  kind: true,
  sortOrder: true,
  content: true,
  referenceUrl: true,
  secureDocumentId: true,
  isRequired: true,
  instructions: true,
  estimatedMinutes: true,
  assessment: { select: { id: true } },
} satisfies Prisma.TrainingModuleSelect;

const assessmentSelect = {
  id: true,
  programId: true,
  moduleId: true,
  title: true,
  instructions: true,
  passingScore: true,
  maxAttempts: true,
  timeLimitMinutes: true,
  isFinal: true,
  isActive: true,
  shuffleQuestions: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: actorSelect },
  _count: { select: { questions: true } },
} satisfies Prisma.TrainingAssessmentSelect;

const programRowSelect = {
  id: true,
  code: true,
  title: true,
  status: true,
  obligation: true,
  estimatedMinutes: true,
  passingScore: true,
  maxAttempts: true,
  createdAt: true,
  category: { select: categoryRefSelect },
  targetDepartment: { select: orgUnitRefSelect },
  targetDesignation: { select: orgUnitRefSelect },
  _count: { select: { modules: true, enrollments: true } },
} satisfies Prisma.TrainingProgramSelect;

const programDetailSelect = {
  id: true,
  code: true,
  title: true,
  description: true,
  objectives: true,
  status: true,
  obligation: true,
  estimatedMinutes: true,
  passingScore: true,
  maxAttempts: true,
  requiresPractical: true,
  requiresShadowing: true,
  requiresFinalAssessment: true,
  dueWithinDays: true,
  publishedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  category: { select: categoryRefSelect },
  targetDepartment: { select: orgUnitRefSelect },
  targetDesignation: { select: orgUnitRefSelect },
  createdBy: { select: actorSelect },
  modules: { select: moduleSelect, orderBy: { sortOrder: 'asc' as const } },
  assessments: { select: assessmentSelect, orderBy: { createdAt: 'asc' as const } },
  _count: { select: { modules: true, enrollments: true } },
} satisfies Prisma.TrainingProgramSelect;

/**
 * The policy fields the grader and the gate need, and nothing else.
 *
 * A narrow read because it happens inside the submission transaction, where every
 * extra joined row is time held on a lock.
 */
const programPolicySelect = {
  id: true,
  passingScore: true,
  maxAttempts: true,
  requiresPractical: true,
  requiresShadowing: true,
  requiresFinalAssessment: true,
  status: true,
  dueWithinDays: true,
  obligation: true,
} satisfies Prisma.TrainingProgramSelect;

const enrollmentRowSelect = {
  id: true,
  status: true,
  obligation: true,
  assignedVia: true,
  assignedAt: true,
  dueOn: true,
  startedAt: true,
  completedAt: true,
  employee: { select: { ...employeeRefSelect, managerId: true } },
  program: { select: { id: true, code: true, title: true } },
} satisfies Prisma.TrainingEnrollmentSelect;

const attemptRowSelect = {
  id: true,
  enrollmentId: true,
  assessmentId: true,
  attemptNumber: true,
  status: true,
  startedAt: true,
  expiresAt: true,
  submittedAt: true,
  score: true,
  maxScore: true,
  percentage: true,
  passed: true,
  assessment: {
    select: { id: true, title: true, passingScore: true, maxAttempts: true },
  },
} satisfies Prisma.TrainingAttemptSelect;

const practicalSelect = {
  id: true,
  enrollmentId: true,
  moduleId: true,
  status: true,
  submissionNotes: true,
  secureDocumentId: true,
  submittedAt: true,
  reviewedAt: true,
  reviewNotes: true,
  reviewerId: true,
  module: { select: { id: true, title: true, instructions: true } },
  reviewer: { select: employeeRefSelect },
  reviewedBy: { select: employeeRefSelect },
  enrollment: {
    select: {
      id: true,
      employeeId: true,
      employee: { select: { ...employeeRefSelect, managerId: true } },
    },
  },
} satisfies Prisma.PracticalSubmissionSelect;

const shadowingSelect = {
  id: true,
  enrollmentId: true,
  moduleId: true,
  status: true,
  scheduledFrom: true,
  scheduledTo: true,
  checklist: true,
  feedback: true,
  signedOffAt: true,
  mentorId: true,
  module: { select: { id: true, title: true, instructions: true } },
  mentor: { select: employeeRefSelect },
  signedOffBy: { select: employeeRefSelect },
  enrollment: {
    select: {
      id: true,
      employeeId: true,
      employee: { select: { ...employeeRefSelect, managerId: true } },
    },
  },
} satisfies Prisma.ShadowingRecordSelect;

const qualificationSelect = {
  id: true,
  enrollmentId: true,
  qualifiedAt: true,
  finalScore: true,
  notes: true,
  certificateCode: true,
  certificateIssuedAt: true,
  revokedAt: true,
  revocationReason: true,
  grantedBy: { select: actorSelect },
  revokedBy: { select: actorSelect },
  enrollment: {
    select: {
      id: true,
      employee: { select: { ...employeeRefSelect, managerId: true } },
      program: { select: { id: true, code: true, title: true } },
    },
  },
} satisfies Prisma.TrainingQualificationSelect;

/**
 * A question as the learner sits it.
 *
 * **No `isCorrect`, and no `explanation`.** This is the select that keeps the answer
 * key off the wire — the control is the omission, and a test asserts it. The
 * explanation is withheld too: it usually names the right answer.
 */
const paperQuestionSelect = {
  id: true,
  kind: true,
  prompt: true,
  points: true,
  sortOrder: true,
  options: {
    select: { id: true, label: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.TrainingQuestionSelect;

/**
 * A question as the grader needs it.
 *
 * Reads `isCorrect`. Used only inside the submission transaction and never
 * serialised to a response — the service maps it to a graded result and discards it.
 */
const gradableQuestionSelect = {
  id: true,
  kind: true,
  points: true,
  options: { select: { id: true, isCorrect: true } },
} satisfies Prisma.TrainingQuestionSelect;

/** A question after submission: correctness, explanation and what was chosen. */
const reviewQuestionSelect = {
  id: true,
  kind: true,
  prompt: true,
  points: true,
  sortOrder: true,
  explanation: true,
  options: {
    select: { id: true, label: true, sortOrder: true, isCorrect: true },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.TrainingQuestionSelect;

export type CategoryRecord = Prisma.TrainingCategoryGetPayload<{ select: typeof categorySelect }>;
export type ProgramRowRecord = Prisma.TrainingProgramGetPayload<{ select: typeof programRowSelect }>;
export type ProgramDetailRecord = Prisma.TrainingProgramGetPayload<{
  select: typeof programDetailSelect;
}>;
export type ProgramPolicyRecord = Prisma.TrainingProgramGetPayload<{
  select: typeof programPolicySelect;
}>;
export type ModuleRecord = Prisma.TrainingModuleGetPayload<{ select: typeof moduleSelect }>;
export type AssessmentRecord = Prisma.TrainingAssessmentGetPayload<{
  select: typeof assessmentSelect;
}>;
export type EnrollmentRowRecord = Prisma.TrainingEnrollmentGetPayload<{
  select: typeof enrollmentRowSelect;
}>;
export type AttemptRowRecord = Prisma.TrainingAttemptGetPayload<{ select: typeof attemptRowSelect }>;
export type PracticalRecord = Prisma.PracticalSubmissionGetPayload<{
  select: typeof practicalSelect;
}>;
export type ShadowingRecord = Prisma.ShadowingRecordGetPayload<{ select: typeof shadowingSelect }>;
export type QualificationRecord = Prisma.TrainingQualificationGetPayload<{
  select: typeof qualificationSelect;
}>;
export type PaperQuestionRecord = Prisma.TrainingQuestionGetPayload<{
  select: typeof paperQuestionSelect;
}>;
export type GradableQuestionRecord = Prisma.TrainingQuestionGetPayload<{
  select: typeof gradableQuestionSelect;
}>;
export type ReviewQuestionRecord = Prisma.TrainingQuestionGetPayload<{
  select: typeof reviewQuestionSelect;
}>;

// ---------------------------------------------------------------------------
//  Reference allocation
// ---------------------------------------------------------------------------

/**
 * Allocates the next reference in a series.
 *
 * The row lock is held until the transaction commits, which is what makes
 * concurrent allocation safe — the same mechanism `allocateEmployeeId`,
 * `allocateCaseNumber` and `allocateRecruitmentCode` use. Never `COUNT(*) + 1`.
 */
export async function allocateTrainingCode(
  tx: Prisma.TransactionClient,
  scope: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "TrainingCodeCounter" ("scope", "lastValue", "updatedAt")
    VALUES (${scope}, 1, now())
    ON CONFLICT ("scope")
    DO UPDATE SET
      "lastValue" = "TrainingCodeCounter"."lastValue" + 1,
      "updatedAt" = now()
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Training code counter returned no value');
  return next;
}

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export function createCategory(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingCategoryUncheckedCreateInput,
): Promise<CategoryRecord> {
  return tx.trainingCategory.create({ data, select: categorySelect });
}

export function findCategoryByCode(code: string): Promise<{ id: string } | null> {
  return prisma.trainingCategory.findUnique({ where: { code }, select: { id: true } });
}

export function listCategories(where: Prisma.TrainingCategoryWhereInput): Promise<CategoryRecord[]> {
  return prisma.trainingCategory.findMany({
    where,
    select: categorySelect,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export function updateCategory(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingCategoryUncheckedUpdateInput,
): Promise<CategoryRecord> {
  return tx.trainingCategory.update({ where: { id }, data, select: categorySelect });
}

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

export function createProgram(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingProgramUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.trainingProgram.create({ data, select: { id: true } });
}

export function findProgram(id: string): Promise<ProgramDetailRecord | null> {
  return prisma.trainingProgram.findUnique({ where: { id }, select: programDetailSelect });
}

/** Just the policy a gate or a grader needs. No relations, no counts. */
export function findProgramPolicy(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ProgramPolicyRecord | null> {
  return tx.trainingProgram.findUnique({ where: { id }, select: programPolicySelect });
}

export function listPrograms(args: {
  where: Prisma.TrainingProgramWhereInput;
  take: number;
  cursor?: string;
}): Promise<ProgramRowRecord[]> {
  return prisma.trainingProgram.findMany({
    where: args.where,
    select: programRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateProgram(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingProgramUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.trainingProgram.update({ where: { id }, data, select: { id: true } });
}

/**
 * Moves a program's status, but only from the status the caller expected.
 *
 * Conditional, like every other transition in this file: two people publishing the
 * same draft at once must not both stamp a different `publishedAt`, because the
 * second would overwrite the first's audit trail.
 */
export async function transitionProgram(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.TrainingProgramUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.trainingProgram.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

/** Live enrollments and completions per program, for the list counts. */
export async function countEnrollmentsByProgram(
  programIds: readonly string[],
): Promise<Map<string, { live: number; completed: number }>> {
  if (programIds.length === 0) return new Map();

  const rows = await prisma.trainingEnrollment.groupBy({
    by: ['programId', 'status'],
    where: { programId: { in: [...programIds] } },
    _count: { _all: true },
  });

  const out = new Map<string, { live: number; completed: number }>();
  for (const row of rows) {
    const entry = out.get(row.programId) ?? { live: 0, completed: 0 };
    if (row.status === 'NOT_STARTED' || row.status === 'IN_PROGRESS') {
      entry.live += row._count._all;
    } else if (row.status === 'COMPLETED') {
      entry.completed += row._count._all;
    }
    out.set(row.programId, entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

export function createModules(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingModuleUncheckedCreateInput[],
): Promise<Prisma.BatchPayload> {
  return tx.trainingModule.createMany({ data });
}

export function createModule(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingModuleUncheckedCreateInput,
): Promise<ModuleRecord> {
  return tx.trainingModule.create({ data, select: moduleSelect });
}

export function findModule(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ModuleRecord | null> {
  return tx.trainingModule.findUnique({ where: { id }, select: moduleSelect });
}

export function listProgramModules(
  programId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ModuleRecord[]> {
  return tx.trainingModule.findMany({
    where: { programId },
    select: moduleSelect,
    orderBy: { sortOrder: 'asc' },
  });
}

/** The next free position, so a create appends rather than colliding. */
export async function nextModuleSortOrder(
  tx: Prisma.TransactionClient,
  programId: string,
): Promise<number> {
  const top = await tx.trainingModule.findFirst({
    where: { programId },
    select: { sortOrder: true },
    orderBy: { sortOrder: 'desc' },
  });
  return (top?.sortOrder ?? -1) + 1;
}

export function updateModule(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingModuleUncheckedUpdateInput,
): Promise<ModuleRecord> {
  return tx.trainingModule.update({ where: { id }, data, select: moduleSelect });
}

export function deleteModule(tx: Prisma.TransactionClient, id: string): Promise<{ id: string }> {
  return tx.trainingModule.delete({ where: { id }, select: { id: true } });
}

/**
 * Rewrites the whole sequence.
 *
 * Two passes, and the first is the point: positions are moved to a negative range
 * before being written to their final values. Writing directly would collide with
 * the (programId, sortOrder) unique index the moment any two modules swap — the
 * index cannot be deferred, so the only way through is a range nothing occupies.
 */
export async function reorderModules(
  tx: Prisma.TransactionClient,
  programId: string,
  orderedIds: readonly string[],
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx.trainingModule.updateMany({
      where: { id, programId },
      data: { sortOrder: -(index + 1) },
    });
  }
  for (const [index, id] of orderedIds.entries()) {
    await tx.trainingModule.updateMany({
      where: { id, programId },
      data: { sortOrder: index },
    });
  }
}

// ---------------------------------------------------------------------------
//  Assessments and questions
// ---------------------------------------------------------------------------

export function createAssessment(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingAssessmentUncheckedCreateInput,
): Promise<AssessmentRecord> {
  return tx.trainingAssessment.create({ data, select: assessmentSelect });
}

export function findAssessment(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<AssessmentRecord | null> {
  return tx.trainingAssessment.findUnique({ where: { id }, select: assessmentSelect });
}

export function findProgramFinalAssessment(
  programId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string } | null> {
  return tx.trainingAssessment.findFirst({
    where: { programId, isFinal: true },
    select: { id: true },
  });
}

export function updateAssessment(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingAssessmentUncheckedUpdateInput,
): Promise<AssessmentRecord> {
  return tx.trainingAssessment.update({ where: { id }, data, select: assessmentSelect });
}

/** Creates a question and its options in one statement — never a half-built question. */
export function createQuestion(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingQuestionUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.trainingQuestion.create({ data, select: { id: true } });
}

export async function nextQuestionSortOrder(
  tx: Prisma.TransactionClient,
  assessmentId: string,
): Promise<number> {
  const top = await tx.trainingQuestion.findFirst({
    where: { assessmentId },
    select: { sortOrder: true },
    orderBy: { sortOrder: 'desc' },
  });
  return (top?.sortOrder ?? -1) + 1;
}

export function updateQuestion(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingQuestionUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.trainingQuestion.update({ where: { id }, data, select: { id: true } });
}

export function deleteQuestion(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string }> {
  return tx.trainingQuestion.delete({ where: { id }, select: { id: true } });
}

export function findQuestionState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; assessmentId: string } | null> {
  return tx.trainingQuestion.findUnique({
    where: { id },
    select: { id: true, assessmentId: true },
  });
}

/**
 * The paper a learner sits. **Carries no `isCorrect` and no explanation.**
 */
export function listPaperQuestions(
  assessmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<PaperQuestionRecord[]> {
  return tx.trainingQuestion.findMany({
    where: { assessmentId },
    select: paperQuestionSelect,
    orderBy: { sortOrder: 'asc' },
  });
}

/** The same questions with correctness, for the grader only. */
export function listGradableQuestions(
  assessmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<GradableQuestionRecord[]> {
  return tx.trainingQuestion.findMany({
    where: { assessmentId },
    select: gradableQuestionSelect,
    orderBy: { sortOrder: 'asc' },
  });
}

/** The questions with the key, for reviewing a settled attempt. */
export function listReviewQuestions(
  assessmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ReviewQuestionRecord[]> {
  return tx.trainingQuestion.findMany({
    where: { assessmentId },
    select: reviewQuestionSelect,
    orderBy: { sortOrder: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Enrollments
// ---------------------------------------------------------------------------

export function createEnrollment(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingEnrollmentUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.trainingEnrollment.create({ data, select: { id: true } });
}

export function findEnrollment(id: string): Promise<EnrollmentRowRecord | null> {
  return prisma.trainingEnrollment.findUnique({ where: { id }, select: enrollmentRowSelect });
}

/** The fields a write merges against, plus the learner's manager for scope checks. */
export function findEnrollmentState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  employeeId: string;
  programId: string;
  status: string;
  startedAt: Date | null;
  dueOn: Date | null;
  employee: { managerId: string | null };
} | null> {
  return tx.trainingEnrollment.findUnique({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      programId: true,
      status: true,
      startedAt: true,
      dueOn: true,
      employee: { select: { managerId: true } },
    },
  });
}

/** A live enrollment for this employee on this program, where one exists. */
export function findLiveEnrollment(
  employeeId: string,
  programId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; status: string } | null> {
  return tx.trainingEnrollment.findFirst({
    where: { employeeId, programId, status: { in: ['NOT_STARTED', 'IN_PROGRESS'] } },
    select: { id: true, status: true },
  });
}

export function listEnrollments(args: {
  where: Prisma.TrainingEnrollmentWhereInput;
  take: number;
  cursor?: string;
}): Promise<EnrollmentRowRecord[]> {
  return prisma.trainingEnrollment.findMany({
    where: args.where,
    select: enrollmentRowSelect,
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateEnrollment(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.TrainingEnrollmentUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.trainingEnrollment.update({ where: { id }, data, select: { id: true } });
}

/** Conditional, so a settled enrollment cannot be re-settled or re-exempted. */
export async function transitionEnrollment(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.TrainingEnrollmentUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.trainingEnrollment.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

/** Employees eligible for a department or designation assignment. */
export function findEligibleEmployees(where: Prisma.EmployeeWhereInput): Promise<{ id: string }[]> {
  return prisma.employee.findMany({
    // Only employed people: assigning training to somebody who has left is noise,
    // and the notification would go to a disabled account.
    where: { ...where, status: { notIn: ['EXITED'] } },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
//  Module progress
// ---------------------------------------------------------------------------

export function findModuleProgress(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ moduleId: string; startedAt: Date | null; completedAt: Date | null }[]> {
  return tx.trainingModuleProgress.findMany({
    where: { enrollmentId },
    select: { moduleId: true, startedAt: true, completedAt: true },
  });
}

/**
 * Records progress on a module, creating the row if this is the first touch.
 *
 * An upsert on the composite unique, which is what makes "completed twice"
 * impossible: the second call updates the same row rather than adding another.
 */
export function upsertModuleProgress(
  tx: Prisma.TransactionClient,
  args: {
    enrollmentId: string;
    moduleId: string;
    create: Omit<
      Prisma.TrainingModuleProgressUncheckedCreateInput,
      'enrollmentId' | 'moduleId'
    >;
    update: Prisma.TrainingModuleProgressUncheckedUpdateInput;
  },
): Promise<{ id: string }> {
  return tx.trainingModuleProgress.upsert({
    where: {
      enrollmentId_moduleId: { enrollmentId: args.enrollmentId, moduleId: args.moduleId },
    },
    create: { enrollmentId: args.enrollmentId, moduleId: args.moduleId, ...args.create },
    update: args.update,
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
//  Attempts
// ---------------------------------------------------------------------------

/**
 * Starts an attempt.
 *
 * `attemptNumber` is supplied by the service from a count inside the same
 * transaction, and the (enrollmentId, assessmentId, attemptNumber) unique is what
 * makes the limit real: two simultaneous starts compute the same next number and
 * only one insert survives. A service-level count alone would let both through.
 */
export function createAttempt(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingAttemptUncheckedCreateInput,
): Promise<{ id: string; attemptNumber: number; startedAt: Date; expiresAt: Date | null }> {
  return tx.trainingAttempt.create({
    data,
    select: { id: true, attemptNumber: true, startedAt: true, expiresAt: true },
  });
}

export function findAttempt(id: string): Promise<AttemptRowRecord | null> {
  return prisma.trainingAttempt.findUnique({ where: { id }, select: attemptRowSelect });
}

export function findAttemptState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  enrollmentId: string;
  assessmentId: string;
  attemptNumber: number;
  status: string;
  expiresAt: Date | null;
  enrollment: { employeeId: string; programId: string; employee: { managerId: string | null } };
} | null> {
  return tx.trainingAttempt.findUnique({
    where: { id },
    select: {
      id: true,
      enrollmentId: true,
      assessmentId: true,
      attemptNumber: true,
      status: true,
      expiresAt: true,
      enrollment: {
        select: {
          employeeId: true,
          programId: true,
          employee: { select: { managerId: true } },
        },
      },
    },
  });
}

/** Every attempt on one assessment by one learner — the limit and best-score source. */
export function listAttemptsFor(
  enrollmentId: string,
  assessmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<
  { id: string; attemptNumber: number; status: string; percentage: Prisma.Decimal | null }[]
> {
  return tx.trainingAttempt.findMany({
    where: { enrollmentId, assessmentId },
    select: { id: true, attemptNumber: true, status: true, percentage: true },
    orderBy: { attemptNumber: 'asc' },
  });
}

export function listEnrollmentAttempts(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<AttemptRowRecord[]> {
  return tx.trainingAttempt.findMany({
    where: { enrollmentId },
    select: attemptRowSelect,
    orderBy: [{ startedAt: 'desc' }],
  });
}

export function listAttempts(args: {
  where: Prisma.TrainingAttemptWhereInput;
  take: number;
  cursor?: string;
}): Promise<AttemptRowRecord[]> {
  return prisma.trainingAttempt.findMany({
    where: args.where,
    select: attemptRowSelect,
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/**
 * Settles an attempt with its grade, but only from IN_PROGRESS.
 *
 * The predicate is the double-submit guard: two concurrent submissions both grade,
 * but only one writes — and the loser is told rather than silently overwriting a
 * result. Without it the second write could replace a pass with a fail.
 */
export async function settleAttempt(
  tx: Prisma.TransactionClient,
  args: { id: string; data: Prisma.TrainingAttemptUncheckedUpdateInput },
): Promise<number> {
  const result = await tx.trainingAttempt.updateMany({
    where: { id: args.id, status: 'IN_PROGRESS' },
    data: args.data,
  });
  return result.count;
}

export function createAnswers(
  tx: Prisma.TransactionClient,
  answers: {
    attemptId: string;
    questionId: string;
    isCorrect: boolean;
    pointsAwarded: Prisma.Decimal;
    selectedOptionIds: string[];
  }[],
): Promise<unknown> {
  /*
    Nested creates rather than two createMany calls: the selected options must land
    with their answer or not at all, and a separate insert could commit the answer
    and lose the selections.
  */
  return Promise.all(
    answers.map((a) =>
      tx.trainingAnswer.create({
        data: {
          attemptId: a.attemptId,
          questionId: a.questionId,
          isCorrect: a.isCorrect,
          pointsAwarded: a.pointsAwarded,
          ...(a.selectedOptionIds.length > 0
            ? { selectedOptions: { create: a.selectedOptionIds.map((optionId) => ({ optionId })) } }
            : {}),
        },
        select: { id: true },
      }),
    ),
  );
}

/** What the learner chose, for reviewing a settled attempt. */
export function listAttemptAnswers(
  attemptId: string,
): Promise<
  {
    questionId: string;
    isCorrect: boolean;
    pointsAwarded: Prisma.Decimal;
    selectedOptions: { optionId: string }[];
  }[]
> {
  return prisma.trainingAnswer.findMany({
    where: { attemptId },
    select: {
      questionId: true,
      isCorrect: true,
      pointsAwarded: true,
      selectedOptions: { select: { optionId: true } },
    },
  });
}

// ---------------------------------------------------------------------------
//  Practical submissions
// ---------------------------------------------------------------------------

export function upsertPractical(
  tx: Prisma.TransactionClient,
  args: {
    enrollmentId: string;
    moduleId: string;
    create: Omit<Prisma.PracticalSubmissionUncheckedCreateInput, 'enrollmentId' | 'moduleId'>;
    update: Prisma.PracticalSubmissionUncheckedUpdateInput;
  },
): Promise<PracticalRecord> {
  return tx.practicalSubmission.upsert({
    where: {
      enrollmentId_moduleId: { enrollmentId: args.enrollmentId, moduleId: args.moduleId },
    },
    create: { enrollmentId: args.enrollmentId, moduleId: args.moduleId, ...args.create },
    update: args.update,
    select: practicalSelect,
  });
}

export function findPractical(id: string): Promise<PracticalRecord | null> {
  return prisma.practicalSubmission.findUnique({ where: { id }, select: practicalSelect });
}

export function listEnrollmentPracticals(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<PracticalRecord[]> {
  return tx.practicalSubmission.findMany({
    where: { enrollmentId },
    select: practicalSelect,
    orderBy: { createdAt: 'asc' },
  });
}

export function listPracticals(args: {
  where: Prisma.PracticalSubmissionWhereInput;
  take: number;
  cursor?: string;
}): Promise<PracticalRecord[]> {
  return prisma.practicalSubmission.findMany({
    where: args.where,
    select: practicalSelect,
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** Conditional on SUBMITTED, so one submission cannot be reviewed twice. */
export async function reviewPractical(
  tx: Prisma.TransactionClient,
  args: { id: string; data: Prisma.PracticalSubmissionUncheckedUpdateInput },
): Promise<number> {
  const result = await tx.practicalSubmission.updateMany({
    where: { id: args.id, status: 'SUBMITTED' },
    data: args.data,
  });
  return result.count;
}

export function updatePractical(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.PracticalSubmissionUncheckedUpdateInput,
): Promise<PracticalRecord> {
  return tx.practicalSubmission.update({ where: { id }, data, select: practicalSelect });
}

// ---------------------------------------------------------------------------
//  Shadowing
// ---------------------------------------------------------------------------

export function upsertShadowing(
  tx: Prisma.TransactionClient,
  args: {
    enrollmentId: string;
    moduleId: string;
    create: Omit<Prisma.ShadowingRecordUncheckedCreateInput, 'enrollmentId' | 'moduleId'>;
    update: Prisma.ShadowingRecordUncheckedUpdateInput;
  },
): Promise<ShadowingRecord> {
  return tx.shadowingRecord.upsert({
    where: {
      enrollmentId_moduleId: { enrollmentId: args.enrollmentId, moduleId: args.moduleId },
    },
    create: { enrollmentId: args.enrollmentId, moduleId: args.moduleId, ...args.create },
    update: args.update,
    select: shadowingSelect,
  });
}

export function findShadowing(id: string): Promise<ShadowingRecord | null> {
  return prisma.shadowingRecord.findUnique({ where: { id }, select: shadowingSelect });
}

export function listEnrollmentShadowings(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<ShadowingRecord[]> {
  return tx.shadowingRecord.findMany({
    where: { enrollmentId },
    select: shadowingSelect,
    orderBy: { createdAt: 'asc' },
  });
}

export function listShadowings(args: {
  where: Prisma.ShadowingRecordWhereInput;
  take: number;
  cursor?: string;
}): Promise<ShadowingRecord[]> {
  return prisma.shadowingRecord.findMany({
    where: args.where,
    select: shadowingSelect,
    orderBy: [{ scheduledFrom: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** Conditional on not already signed off, so two mentors cannot both sign. */
export async function signOffShadowing(
  tx: Prisma.TransactionClient,
  args: { id: string; data: Prisma.ShadowingRecordUncheckedUpdateInput },
): Promise<number> {
  const result = await tx.shadowingRecord.updateMany({
    where: { id: args.id, signedOffAt: null },
    data: args.data,
  });
  return result.count;
}

export function updateShadowing(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.ShadowingRecordUncheckedUpdateInput,
): Promise<ShadowingRecord> {
  return tx.shadowingRecord.update({ where: { id }, data, select: shadowingSelect });
}

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * Grants qualification.
 *
 * The unique `enrollmentId` is the race guard: two concurrent grants cannot both
 * insert, so one wins and the other is told rather than producing two
 * qualifications for one enrollment.
 */
export function createQualification(
  tx: Prisma.TransactionClient,
  data: Prisma.TrainingQualificationUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.trainingQualification.create({ data, select: { id: true } });
}

export function findQualification(id: string): Promise<QualificationRecord | null> {
  return prisma.trainingQualification.findUnique({ where: { id }, select: qualificationSelect });
}

export function findQualificationByEnrollment(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; revokedAt: Date | null } | null> {
  return tx.trainingQualification.findUnique({
    where: { enrollmentId },
    select: { id: true, revokedAt: true },
  });
}

export function listQualifications(args: {
  where: Prisma.TrainingQualificationWhereInput;
  take: number;
  cursor?: string;
}): Promise<QualificationRecord[]> {
  return prisma.trainingQualification.findMany({
    where: args.where,
    select: qualificationSelect,
    orderBy: [{ qualifiedAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** Conditional on not already revoked, so one revocation stands. */
export async function revokeQualification(
  tx: Prisma.TransactionClient,
  args: { id: string; data: Prisma.TrainingQualificationUncheckedUpdateInput },
): Promise<number> {
  const result = await tx.trainingQualification.updateMany({
    where: { id: args.id, revokedAt: null },
    data: args.data,
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * The onboarding task's own state, plus the employment record behind it.
 *
 * `employeeId` is null before the EMPLOYEE_CREATED stage, which is what lets the
 * service refuse to assign training to somebody who is not yet employed.
 */
export function findOnboardingTaskForTraining(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  category: string;
  status: string;
  trainingEnrollmentId: string | null;
  onboardingRecord: { id: string; employeeId: string | null };
} | null> {
  return tx.onboardingTask.findUnique({
    where: { id },
    select: {
      id: true,
      category: true,
      status: true,
      trainingEnrollmentId: true,
      onboardingRecord: { select: { id: true, employeeId: true } },
    },
  });
}

export function linkOnboardingTask(
  tx: Prisma.TransactionClient,
  args: { id: string; trainingEnrollmentId: string },
): Promise<{ id: string }> {
  return tx.onboardingTask.update({
    where: { id: args.id },
    data: { trainingEnrollmentId: args.trainingEnrollmentId },
    select: { id: true },
  });
}

/**
 * Tasks linked to one enrollment, so completing training can advance them.
 *
 * Conditional in the caller, not here: the service decides whether a task should
 * follow, because that is a business rule about what training completion means.
 */
export function findTasksForEnrollment(
  enrollmentId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; status: string; onboardingRecordId: string }[]> {
  return tx.onboardingTask.findMany({
    where: { trainingEnrollmentId: enrollmentId },
    select: { id: true, status: true, onboardingRecordId: true },
  });
}

/** Settles a linked onboarding task when its training completes. */
export async function settleLinkedTask(
  tx: Prisma.TransactionClient,
  args: { id: string; completedById: string; now: Date },
): Promise<number> {
  const result = await tx.onboardingTask.updateMany({
    // Only an unsettled task: a skipped or already-completed one keeps its own
    // history, because somebody decided that deliberately.
    where: { id: args.id, status: { in: ['PENDING', 'IN_PROGRESS', 'BLOCKED'] } },
    data: {
      status: 'COMPLETED',
      completedAt: args.now,
      completedById: args.completedById,
    },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Lookups the services need
// ---------------------------------------------------------------------------

/** Whether this employee manages anybody — the `hasReports` scope input. */
export async function hasReports(employeeId: string): Promise<boolean> {
  const count = await prisma.employee.count({ where: { managerId: employeeId } });
  return count > 0;
}

export function findEmployeeForTraining(
  id: string,
): Promise<{ id: string; status: string; managerId: string | null; userId: string | null } | null> {
  return prisma.employee.findUnique({
    where: { id },
    select: { id: true, status: true, managerId: true, userId: true },
  });
}

/** The login behind an employee, for notification routing. Most have none. */
export async function findUserIdForEmployee(employeeId: string): Promise<string | null> {
  const row = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });
  return row?.userId ?? null;
}
