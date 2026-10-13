/**
 * Every recruitment, onboarding and probation database read and write.
 *
 * No business rule lives here: the service decides, this executes. Selects are
 * shared constants rather than inline objects, so a confidential column cannot be
 * exposed by one query and withheld by another — which is how a leak happens.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, and every table belonging to Sales, Purchase,
 * Dispatch, Post Sales, Lead, RsProduct or inventory. Creating an employee from an
 * onboarding writes `Employee` through Phase 1's own allocator and nothing else —
 * no credential, no permission row, no login.
 *
 * ### Where the concurrency safety actually is
 *
 * Four places, and each guards a different accident:
 *
 *   `allocateRecruitmentCode`  INSERT … ON CONFLICT DO UPDATE … RETURNING, so two
 *                              simultaneous creates cannot be handed one reference.
 *   `transitionApplication`    a conditional updateMany predicated on the stage and
 *                              status it expects, so two people moving the same
 *                              application cannot both think they won.
 *   `transitionOffer`          the same, predicated on status: an offer cannot be
 *                              accepted twice, nor accepted and withdrawn at once.
 *   `attachEmployeeToOnboarding` a conditional update predicated on `employeeId`
 *                              still being null. This is the one that matters most:
 *                              it is what stops one hire producing two employment
 *                              records with two employee numbers.
 *
 * In all four the database decides the winner, not a read-then-write in the
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

const candidateRefSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} satisfies Prisma.CandidateSelect;

const jobRefSelect = {
  id: true,
  code: true,
  title: true,
} satisfies Prisma.JobRequisitionSelect;

/**
 * A requisition row for a list.
 *
 * `_count` carries the application tallies, derived by the database rather than
 * stored: a stored count would be a second answer free to drift from the
 * applications themselves, the same reasoning `DepartmentView.employeeCount`
 * applies.
 */
const jobRowSelect = {
  id: true,
  code: true,
  title: true,
  employmentType: true,
  workMode: true,
  location: true,
  openings: true,
  status: true,
  priority: true,
  targetJoinDate: true,
  publishedAt: true,
  createdAt: true,
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  hiringManager: { select: employeeRefSelect },
  recruiter: { select: employeeRefSelect },
  _count: { select: { applications: true } },
} satisfies Prisma.JobRequisitionSelect;

const jobDetailSelect = {
  id: true,
  code: true,
  title: true,
  employmentType: true,
  workMode: true,
  location: true,
  openings: true,
  status: true,
  priority: true,
  targetJoinDate: true,
  publishedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  description: true,
  requirements: true,
  responsibilities: true,
  salaryRangeMin: true,
  salaryRangeMax: true,
  salaryCurrency: true,
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  hiringManager: { select: employeeRefSelect },
  recruiter: { select: employeeRefSelect },
  createdBy: { select: actorSelect },
  _count: { select: { applications: true } },
} satisfies Prisma.JobRequisitionSelect;

const candidateRowSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  location: true,
  source: true,
  currentEmployer: true,
  currentDesignation: true,
  totalExperienceYears: true,
  isActive: true,
  createdAt: true,
  _count: { select: { applications: true } },
} satisfies Prisma.CandidateSelect;

const candidateDocumentSelect = {
  id: true,
  secureDocumentId: true,
  documentType: true,
  title: true,
  verificationStatus: true,
  verifiedAt: true,
  createdAt: true,
  verifiedBy: { select: actorSelect },
  uploadedBy: { select: actorSelect },
} satisfies Prisma.CandidateDocumentSelect;

const candidateDetailSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  location: true,
  source: true,
  sourceDetail: true,
  currentEmployer: true,
  currentDesignation: true,
  totalExperienceYears: true,
  skills: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: actorSelect },
  _count: { select: { applications: true } },
  documents: { select: candidateDocumentSelect, orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.CandidateSelect;

const applicationRowSelect = {
  id: true,
  currentStage: true,
  status: true,
  appliedAt: true,
  source: true,
  candidate: { select: candidateRefSelect },
  jobRequisition: { select: jobRefSelect },
  recruiter: { select: employeeRefSelect },
  hiringManager: { select: employeeRefSelect },
} satisfies Prisma.ApplicationSelect;

const stageHistorySelect = {
  id: true,
  fromStage: true,
  toStage: true,
  reason: true,
  createdAt: true,
  performedBy: { select: actorSelect },
} satisfies Prisma.ApplicationStageHistorySelect;

const interviewFeedbackSelect = {
  id: true,
  employeeId: true,
  rating: true,
  recommendation: true,
  strengths: true,
  concerns: true,
  notes: true,
  submittedAt: true,
  employee: { select: employeeRefSelect },
} satisfies Prisma.InterviewFeedbackSelect;

const interviewRowSelect = {
  id: true,
  applicationId: true,
  interviewType: true,
  round: true,
  scheduledAt: true,
  durationMinutes: true,
  status: true,
  interviewerId: true,
  interviewer: { select: employeeRefSelect },
  participants: { select: { employee: { select: employeeRefSelect }, employeeId: true } },
  application: {
    select: {
      candidate: { select: candidateRefSelect },
      jobRequisition: { select: jobRefSelect },
    },
  },
} satisfies Prisma.InterviewSelect;

const interviewDetailSelect = {
  ...interviewRowSelect,
  location: true,
  meetingUrl: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: actorSelect },
  feedback: { select: interviewFeedbackSelect, orderBy: { submittedAt: 'asc' as const } },
} satisfies Prisma.InterviewSelect;

const assessmentSelect = {
  id: true,
  applicationId: true,
  assessmentType: true,
  title: true,
  assignedAt: true,
  dueAt: true,
  score: true,
  maxScore: true,
  status: true,
  reviewedAt: true,
  notes: true,
  reviewer: { select: employeeRefSelect },
} satisfies Prisma.AssessmentSelect;

const offerRowSelect = {
  id: true,
  code: true,
  applicationId: true,
  position: true,
  proposedJoiningDate: true,
  status: true,
  expiresOn: true,
  sentAt: true,
  respondedAt: true,
  application: { select: { candidate: { select: candidateRefSelect } } },
} satisfies Prisma.OfferSelect;

const offerDetailSelect = {
  ...offerRowSelect,
  employmentType: true,
  workMode: true,
  location: true,
  annualPackage: true,
  packageCurrency: true,
  benefitsSummary: true,
  responseNote: true,
  secureDocumentId: true,
  createdAt: true,
  updatedAt: true,
  jobRequisition: { select: jobRefSelect },
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  createdBy: { select: actorSelect },
} satisfies Prisma.OfferSelect;

/**
 * A background check.
 *
 * `result` is the most sensitive string in this phase, so this select is used only
 * by paths the service has already gated on `mayViewBackgroundChecks`. Keeping it
 * a named constant rather than an inline object is what makes that auditable.
 */
const backgroundCheckSelect = {
  id: true,
  applicationId: true,
  checkType: true,
  status: true,
  requestedAt: true,
  completedAt: true,
  result: true,
  notes: true,
  verifierName: true,
  verifiedBy: { select: actorSelect },
} satisfies Prisma.BackgroundCheckSelect;

const applicationDetailSelect = {
  id: true,
  currentStage: true,
  status: true,
  appliedAt: true,
  source: true,
  screeningScore: true,
  screeningNotes: true,
  rejectionReason: true,
  selectedAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  candidate: { select: candidateRefSelect },
  jobRequisition: { select: jobRefSelect },
  recruiter: { select: employeeRefSelect },
  hiringManager: { select: employeeRefSelect },
  selectedBy: { select: actorSelect },
  stageHistory: { select: stageHistorySelect, orderBy: { createdAt: 'asc' as const } },
  interviews: { select: interviewRowSelect, orderBy: { scheduledAt: 'asc' as const } },
  assessments: { select: assessmentSelect, orderBy: { assignedAt: 'asc' as const } },
  offers: { select: offerRowSelect, orderBy: { createdAt: 'desc' as const } },
  backgroundChecks: { select: backgroundCheckSelect, orderBy: { requestedAt: 'asc' as const } },
  onboarding: { select: { id: true } },
} satisfies Prisma.ApplicationSelect;

const onboardingTaskSelect = {
  id: true,
  onboardingRecordId: true,
  title: true,
  category: true,
  detail: true,
  dueOn: true,
  status: true,
  completedAt: true,
  notes: true,
  sortOrder: true,
  assigneeId: true,
  // Phase 4. Says whether a TRAINING task has been linked to a real enrollment —
  // the checklist needs it to know whether to offer the link or report it.
  trainingEnrollmentId: true,
  assignee: { select: employeeRefSelect },
  completedBy: { select: actorSelect },
} satisfies Prisma.OnboardingTaskSelect;

const onboardingRowSelect = {
  id: true,
  applicationId: true,
  stage: true,
  joiningDate: true,
  actualJoiningDate: true,
  completedAt: true,
  employee: { select: employeeRefSelect },
  department: { select: orgUnitRefSelect },
  designation: { select: orgUnitRefSelect },
  manager: { select: employeeRefSelect },
  application: {
    select: {
      candidate: { select: candidateRefSelect },
      jobRequisition: { select: jobRefSelect },
    },
  },
  _count: { select: { tasks: true } },
} satisfies Prisma.OnboardingRecordSelect;

const onboardingDetailSelect = {
  ...onboardingRowSelect,
  notes: true,
  createdAt: true,
  updatedAt: true,
  employeeId: true,
  createdBy: { select: actorSelect },
  tasks: { select: onboardingTaskSelect, orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.OnboardingRecordSelect;

const probationReviewSelect = {
  id: true,
  probationRecordId: true,
  reviewType: true,
  scheduledOn: true,
  status: true,
  rating: true,
  comments: true,
  recommendation: true,
  completedAt: true,
  reviewer: { select: employeeRefSelect },
} satisfies Prisma.ProbationReviewSelect;

const probationRowSelect = {
  id: true,
  employeeId: true,
  startDate: true,
  endDate: true,
  status: true,
  managerId: true,
  decision: true,
  employee: { select: employeeRefSelect },
  manager: { select: employeeRefSelect },
  _count: { select: { reviews: true } },
} satisfies Prisma.ProbationRecordSelect;

const probationDetailSelect = {
  ...probationRowSelect,
  originalEndDate: true,
  decisionReason: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
  decidedBy: { select: actorSelect },
  reviews: { select: probationReviewSelect, orderBy: { scheduledOn: 'asc' as const } },
} satisfies Prisma.ProbationRecordSelect;

export type JobRowRecord = Prisma.JobRequisitionGetPayload<{ select: typeof jobRowSelect }>;
export type JobDetailRecord = Prisma.JobRequisitionGetPayload<{ select: typeof jobDetailSelect }>;
export type CandidateRowRecord = Prisma.CandidateGetPayload<{ select: typeof candidateRowSelect }>;
export type CandidateDetailRecord = Prisma.CandidateGetPayload<{
  select: typeof candidateDetailSelect;
}>;
export type ApplicationRowRecord = Prisma.ApplicationGetPayload<{
  select: typeof applicationRowSelect;
}>;
export type ApplicationDetailRecord = Prisma.ApplicationGetPayload<{
  select: typeof applicationDetailSelect;
}>;
export type InterviewRowRecord = Prisma.InterviewGetPayload<{ select: typeof interviewRowSelect }>;
export type InterviewDetailRecord = Prisma.InterviewGetPayload<{
  select: typeof interviewDetailSelect;
}>;
export type AssessmentRecord = Prisma.AssessmentGetPayload<{ select: typeof assessmentSelect }>;
export type OfferRowRecord = Prisma.OfferGetPayload<{ select: typeof offerRowSelect }>;
export type OfferDetailRecord = Prisma.OfferGetPayload<{ select: typeof offerDetailSelect }>;
export type BackgroundCheckRecord = Prisma.BackgroundCheckGetPayload<{
  select: typeof backgroundCheckSelect;
}>;
export type CandidateDocumentRecord = Prisma.CandidateDocumentGetPayload<{
  select: typeof candidateDocumentSelect;
}>;
export type OnboardingRowRecord = Prisma.OnboardingRecordGetPayload<{
  select: typeof onboardingRowSelect;
}>;
export type OnboardingDetailRecord = Prisma.OnboardingRecordGetPayload<{
  select: typeof onboardingDetailSelect;
}>;
export type OnboardingTaskRecord = Prisma.OnboardingTaskGetPayload<{
  select: typeof onboardingTaskSelect;
}>;
export type ProbationRowRecord = Prisma.ProbationRecordGetPayload<{
  select: typeof probationRowSelect;
}>;
export type ProbationDetailRecord = Prisma.ProbationRecordGetPayload<{
  select: typeof probationDetailSelect;
}>;
export type ProbationReviewRecord = Prisma.ProbationReviewGetPayload<{
  select: typeof probationReviewSelect;
}>;

// ---------------------------------------------------------------------------
//  Reference allocation
// ---------------------------------------------------------------------------

/**
 * Allocates the next reference in a series.
 *
 * One statement that inserts or bumps the counter and hands back the new value.
 * The row lock is held until the transaction commits, which is what makes
 * concurrent allocation safe — the same mechanism `allocateCaseNumber` and
 * `allocateEmployeeId` use. Never `COUNT(*) + 1`, which two simultaneous creates
 * would both read as the same number.
 */
export async function allocateRecruitmentCode(
  tx: Prisma.TransactionClient,
  scope: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "RecruitmentCodeCounter" ("scope", "lastValue", "updatedAt")
    VALUES (${scope}, 1, now())
    ON CONFLICT ("scope")
    DO UPDATE SET
      "lastValue" = "RecruitmentCodeCounter"."lastValue" + 1,
      "updatedAt" = now()
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Recruitment code counter returned no value');
  return next;
}

// ---------------------------------------------------------------------------
//  Involvement — the facts the access policy needs
// ---------------------------------------------------------------------------

/**
 * Which requisitions and applications one employee is working on.
 *
 * Resolved in two queries rather than one join, because they answer different
 * questions and the second depends on a wider set of relationships: a person is
 * involved in an application by being named on it *or* by being booked to
 * interview against it, and an OR across two relations is clearer as its own read.
 *
 * Returns id lists rather than rows: the access policy needs only membership, and
 * loading the rows would be fetching data to decide whether it may be fetched.
 */
export async function findInvolvement(employeeId: string): Promise<{
  jobRequisitionIds: string[];
  applicationIds: string[];
}> {
  const [jobs, applications] = await Promise.all([
    prisma.jobRequisition.findMany({
      where: {
        OR: [{ hiringManagerId: employeeId }, { recruiterId: employeeId }],
      },
      select: { id: true },
    }),
    prisma.application.findMany({
      where: {
        OR: [
          { recruiterId: employeeId },
          { hiringManagerId: employeeId },
          { interviews: { some: { interviewerId: employeeId } } },
          { interviews: { some: { participants: { some: { employeeId } } } } },
        ],
      },
      select: { id: true },
    }),
  ]);

  return {
    jobRequisitionIds: jobs.map((j) => j.id),
    applicationIds: applications.map((a) => a.id),
  };
}

/**
 * The login behind an employee, where they have one.
 *
 * Notifications address *accounts*, and most employees have none — so every notice
 * in this module has to resolve one and skip silently when there isn't one. Lives
 * here rather than in `hr.repository.ts` because notification routing is a Phase 3
 * need and widening Phase 1's repository for it would mean two modules owning the
 * same read.
 */
export async function findUserIdForEmployee(employeeId: string): Promise<string | null> {
  const row = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/** The same for several employees at once — an interview panel, typically. */
export async function findUserIdsForEmployees(
  employeeIds: readonly string[],
): Promise<string[]> {
  if (employeeIds.length === 0) return [];

  const rows = await prisma.employee.findMany({
    where: { id: { in: [...employeeIds] }, userId: { not: null } },
    select: { userId: true },
  });
  return rows.flatMap((row) => (row.userId === null ? [] : [row.userId]));
}

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export function createJobRequisition(
  tx: Prisma.TransactionClient,
  data: Prisma.JobRequisitionUncheckedCreateInput,
): Promise<JobDetailRecord> {
  return tx.jobRequisition.create({ data, select: jobDetailSelect });
}

export function findJob(id: string): Promise<JobDetailRecord | null> {
  return prisma.jobRequisition.findUnique({ where: { id }, select: jobDetailSelect });
}

/** Just the fields a write merges against — no relations, no counts. */
export function findJobState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  status: string;
  openings: number;
  recruiterId: string | null;
  hiringManagerId: string | null;
  departmentId: string | null;
  designationId: string | null;
  title: string;
  code: string;
} | null> {
  return tx.jobRequisition.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      openings: true,
      recruiterId: true,
      hiringManagerId: true,
      departmentId: true,
      designationId: true,
      title: true,
      code: true,
    },
  });
}

export function listJobs(args: {
  where: Prisma.JobRequisitionWhereInput;
  take: number;
  cursor?: string;
}): Promise<JobRowRecord[]> {
  return prisma.jobRequisition.findMany({
    where: args.where,
    select: jobRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/**
 * How many applications on this requisition are still live.
 *
 * Counted separately from the `_count` in the row select, which counts all of
 * them: "12 applied, 3 still in play" are two different numbers a recruiter needs
 * at once, and Prisma's `_count` cannot be filtered per relation in the same
 * select.
 */
export async function countActiveApplications(
  jobRequisitionIds: readonly string[],
): Promise<Map<string, number>> {
  if (jobRequisitionIds.length === 0) return new Map();

  const rows = await prisma.application.groupBy({
    by: ['jobRequisitionId'],
    where: { jobRequisitionId: { in: [...jobRequisitionIds] }, status: 'ACTIVE' },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.jobRequisitionId, row._count._all]));
}

export function updateJob(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.JobRequisitionUpdateInput,
): Promise<JobDetailRecord> {
  return tx.jobRequisition.update({ where: { id }, data, select: jobDetailSelect });
}

/**
 * Moves a requisition's status, but only from the status the caller expected.
 *
 * Conditional, like every other transition in this file: two people publishing the
 * same draft at once must not both succeed, because each would stamp a different
 * `publishedAt` and the second would overwrite the first's audit trail. The count
 * tells the service whether it won.
 */
export async function transitionJob(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.JobRequisitionUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.jobRequisition.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export function createCandidate(
  tx: Prisma.TransactionClient,
  data: Prisma.CandidateUncheckedCreateInput,
): Promise<CandidateDetailRecord> {
  return tx.candidate.create({ data, select: candidateDetailSelect });
}

export function findCandidate(id: string): Promise<CandidateDetailRecord | null> {
  return prisma.candidate.findUnique({ where: { id }, select: candidateDetailSelect });
}

export function findCandidateByEmail(
  email: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; email: string; isActive: boolean } | null> {
  return tx.candidate.findUnique({
    where: { email },
    select: { id: true, email: true, isActive: true },
  });
}

export function listCandidates(args: {
  where: Prisma.CandidateWhereInput;
  take: number;
  cursor?: string;
}): Promise<CandidateRowRecord[]> {
  return prisma.candidate.findMany({
    where: args.where,
    select: candidateRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateCandidate(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.CandidateUpdateInput,
): Promise<CandidateDetailRecord> {
  return tx.candidate.update({ where: { id }, data, select: candidateDetailSelect });
}

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export function createApplication(
  tx: Prisma.TransactionClient,
  data: Prisma.ApplicationUncheckedCreateInput,
): Promise<ApplicationDetailRecord> {
  return tx.application.create({ data, select: applicationDetailSelect });
}

export function findApplication(id: string): Promise<ApplicationDetailRecord | null> {
  return prisma.application.findUnique({ where: { id }, select: applicationDetailSelect });
}

export function findApplicationState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  candidateId: string;
  jobRequisitionId: string;
  currentStage: string;
  status: string;
  recruiterId: string | null;
  hiringManagerId: string | null;
  selectedAt: Date | null;
} | null> {
  return tx.application.findUnique({
    where: { id },
    select: {
      id: true,
      candidateId: true,
      jobRequisitionId: true,
      currentStage: true,
      status: true,
      recruiterId: true,
      hiringManagerId: true,
      selectedAt: true,
    },
  });
}

export function listApplications(args: {
  where: Prisma.ApplicationWhereInput;
  take: number;
  cursor?: string;
}): Promise<ApplicationRowRecord[]> {
  return prisma.application.findMany({
    where: args.where,
    select: applicationRowSelect,
    orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateApplication(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.ApplicationUncheckedUpdateInput,
): Promise<ApplicationDetailRecord> {
  return tx.application.update({ where: { id }, data, select: applicationDetailSelect });
}

/**
 * Moves an application, but only from the stage and status the caller expected.
 *
 * The predicate is the safety property. Two recruiters moving one application at
 * once — one shortlisting, one rejecting — would otherwise both read ACTIVE,
 * both write, and the second would silently erase the first's decision along with
 * its stage-history entry. Here the loser gets a count of 0 and is told.
 */
export async function transitionApplication(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStage?: string;
    fromStatuses: readonly string[];
    data: Prisma.ApplicationUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.application.updateMany({
    where: {
      id: args.id,
      status: { in: args.fromStatuses as never },
      ...(args.fromStage ? { currentStage: args.fromStage as never } : {}),
    },
    data: args.data,
  });
  return result.count;
}

export function recordStageChange(
  tx: Prisma.TransactionClient,
  data: Prisma.ApplicationStageHistoryUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.applicationStageHistory.create({ data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

/**
 * Books an interview and its participants in one statement.
 *
 * Nested create rather than two calls, so a participant list cannot be half
 * written: an interview with three of its four panellists is worse than a failed
 * booking, because nobody notices.
 */
export function createInterview(
  tx: Prisma.TransactionClient,
  data: Prisma.InterviewUncheckedCreateInput,
): Promise<InterviewDetailRecord> {
  return tx.interview.create({ data, select: interviewDetailSelect });
}

export function findInterview(id: string): Promise<InterviewDetailRecord | null> {
  return prisma.interview.findUnique({ where: { id }, select: interviewDetailSelect });
}

export function findInterviewState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  applicationId: string;
  status: string;
  interviewerId: string | null;
  scheduledAt: Date;
  participants: { employeeId: string }[];
} | null> {
  return tx.interview.findUnique({
    where: { id },
    select: {
      id: true,
      applicationId: true,
      status: true,
      interviewerId: true,
      scheduledAt: true,
      participants: { select: { employeeId: true } },
    },
  });
}

export function listInterviews(args: {
  where: Prisma.InterviewWhereInput;
  take: number;
  cursor?: string;
}): Promise<InterviewRowRecord[]> {
  return prisma.interview.findMany({
    where: args.where,
    select: interviewRowSelect,
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** Conditional, so a cancelled interview cannot be rescheduled into existence. */
export async function transitionInterview(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.InterviewUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.interview.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

/**
 * One person's feedback, written or amended.
 *
 * An upsert on the composite unique, because an interviewer correcting their own
 * note should amend it rather than add a second row the panel then has to
 * reconcile. The unique index is what makes this atomic under a double submit.
 */
export function upsertInterviewFeedback(
  tx: Prisma.TransactionClient,
  args: {
    interviewId: string;
    employeeId: string;
    data: Omit<Prisma.InterviewFeedbackUncheckedCreateInput, 'interviewId' | 'employeeId'>;
  },
): Promise<{ id: string }> {
  return tx.interviewFeedback.upsert({
    where: {
      interviewId_employeeId: { interviewId: args.interviewId, employeeId: args.employeeId },
    },
    create: { interviewId: args.interviewId, employeeId: args.employeeId, ...args.data },
    update: args.data,
    select: { id: true },
  });
}

export async function hasSubmittedFeedback(
  interviewId: string,
  employeeId: string,
): Promise<boolean> {
  const row = await prisma.interviewFeedback.findUnique({
    where: { interviewId_employeeId: { interviewId, employeeId } },
    select: { id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export function createAssessment(
  tx: Prisma.TransactionClient,
  data: Prisma.AssessmentUncheckedCreateInput,
): Promise<AssessmentRecord> {
  return tx.assessment.create({ data, select: assessmentSelect });
}

export function findAssessmentState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; applicationId: string; status: string; maxScore: unknown } | null> {
  return tx.assessment.findUnique({
    where: { id },
    select: { id: true, applicationId: true, status: true, maxScore: true },
  });
}

export function updateAssessment(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.AssessmentUncheckedUpdateInput,
): Promise<AssessmentRecord> {
  return tx.assessment.update({ where: { id }, data, select: assessmentSelect });
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export function createOffer(
  tx: Prisma.TransactionClient,
  data: Prisma.OfferUncheckedCreateInput,
): Promise<OfferDetailRecord> {
  return tx.offer.create({ data, select: offerDetailSelect });
}

export function findOffer(id: string): Promise<OfferDetailRecord | null> {
  return prisma.offer.findUnique({ where: { id }, select: offerDetailSelect });
}

export function findOfferState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  applicationId: string;
  status: string;
  proposedJoiningDate: Date;
  departmentId: string | null;
  designationId: string | null;
  position: string;
} | null> {
  return tx.offer.findUnique({
    where: { id },
    select: {
      id: true,
      applicationId: true,
      status: true,
      proposedJoiningDate: true,
      departmentId: true,
      designationId: true,
      position: true,
    },
  });
}

export function listOffers(args: {
  where: Prisma.OfferWhereInput;
  take: number;
  cursor?: string;
}): Promise<OfferRowRecord[]> {
  return prisma.offer.findMany({
    where: args.where,
    select: offerRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function updateOffer(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.OfferUncheckedUpdateInput,
): Promise<OfferDetailRecord> {
  return tx.offer.update({ where: { id }, data, select: offerDetailSelect });
}

/**
 * Moves an offer's status, but only from the status the caller expected.
 *
 * An offer cannot be accepted twice, nor accepted and withdrawn simultaneously —
 * and both are reachable by a double click on a slow connection. The predicate
 * makes the database pick one.
 */
export async function transitionOffer(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.OfferUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.offer.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

/**
 * Requests a check, or re-requests one of the same type.
 *
 * An upsert on (applicationId, checkType), because re-running an education check
 * should amend that check rather than accumulate rows nobody can order. The unique
 * index makes it atomic.
 */
export function upsertBackgroundCheck(
  tx: Prisma.TransactionClient,
  args: {
    applicationId: string;
    checkType: string;
    create: Omit<Prisma.BackgroundCheckUncheckedCreateInput, 'applicationId' | 'checkType'>;
    update: Prisma.BackgroundCheckUncheckedUpdateInput;
  },
): Promise<BackgroundCheckRecord> {
  return tx.backgroundCheck.upsert({
    where: {
      applicationId_checkType: {
        applicationId: args.applicationId,
        checkType: args.checkType as never,
      },
    },
    create: {
      applicationId: args.applicationId,
      checkType: args.checkType as never,
      ...args.create,
    },
    update: args.update,
    select: backgroundCheckSelect,
  });
}

export function findBackgroundCheckState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; applicationId: string; status: string; checkType: string } | null> {
  return tx.backgroundCheck.findUnique({
    where: { id },
    select: { id: true, applicationId: true, status: true, checkType: true },
  });
}

export function updateBackgroundCheck(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.BackgroundCheckUncheckedUpdateInput,
): Promise<BackgroundCheckRecord> {
  return tx.backgroundCheck.update({ where: { id }, data, select: backgroundCheckSelect });
}

export function listBackgroundChecks(applicationId: string): Promise<BackgroundCheckRecord[]> {
  return prisma.backgroundCheck.findMany({
    where: { applicationId },
    select: backgroundCheckSelect,
    orderBy: { requestedAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Candidate documents
// ---------------------------------------------------------------------------

export function createCandidateDocument(
  tx: Prisma.TransactionClient,
  data: Prisma.CandidateDocumentUncheckedCreateInput,
): Promise<CandidateDocumentRecord> {
  return tx.candidateDocument.create({ data, select: candidateDocumentSelect });
}

export function findCandidateDocumentState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  candidateId: string;
  secureDocumentId: string;
  verificationStatus: string;
} | null> {
  return tx.candidateDocument.findUnique({
    where: { id },
    select: {
      id: true,
      candidateId: true,
      secureDocumentId: true,
      verificationStatus: true,
    },
  });
}

export function updateCandidateDocument(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.CandidateDocumentUncheckedUpdateInput,
): Promise<CandidateDocumentRecord> {
  return tx.candidateDocument.update({ where: { id }, data, select: candidateDocumentSelect });
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export function createOnboarding(
  tx: Prisma.TransactionClient,
  data: Prisma.OnboardingRecordUncheckedCreateInput,
): Promise<OnboardingDetailRecord> {
  return tx.onboardingRecord.create({ data, select: onboardingDetailSelect });
}

export function findOnboarding(id: string): Promise<OnboardingDetailRecord | null> {
  return prisma.onboardingRecord.findUnique({ where: { id }, select: onboardingDetailSelect });
}

export function findOnboardingByApplication(
  applicationId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; stage: string; employeeId: string | null } | null> {
  return tx.onboardingRecord.findUnique({
    where: { applicationId },
    select: { id: true, stage: true, employeeId: true },
  });
}

export function findOnboardingState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  applicationId: string;
  stage: string;
  employeeId: string | null;
  joiningDate: Date;
  departmentId: string | null;
  designationId: string | null;
  managerId: string | null;
} | null> {
  return tx.onboardingRecord.findUnique({
    where: { id },
    select: {
      id: true,
      applicationId: true,
      stage: true,
      employeeId: true,
      joiningDate: true,
      departmentId: true,
      designationId: true,
      managerId: true,
    },
  });
}

export function listOnboardings(args: {
  where: Prisma.OnboardingRecordWhereInput;
  take: number;
  cursor?: string;
}): Promise<OnboardingRowRecord[]> {
  return prisma.onboardingRecord.findMany({
    where: args.where,
    select: onboardingRowSelect,
    orderBy: [{ joiningDate: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

/** How many tasks on each onboarding are settled — derived, never stored. */
export async function countSettledTasks(
  onboardingIds: readonly string[],
): Promise<Map<string, number>> {
  if (onboardingIds.length === 0) return new Map();

  const rows = await prisma.onboardingTask.groupBy({
    by: ['onboardingRecordId'],
    where: {
      onboardingRecordId: { in: [...onboardingIds] },
      status: { in: ['COMPLETED', 'SKIPPED'] },
    },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.onboardingRecordId, row._count._all]));
}

export function updateOnboarding(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.OnboardingRecordUncheckedUpdateInput,
): Promise<OnboardingDetailRecord> {
  return tx.onboardingRecord.update({ where: { id }, data, select: onboardingDetailSelect });
}

/**
 * Attaches the employment record, but only if one is not already attached.
 *
 * **The most important write in this module.** Without the `employeeId: null`
 * predicate, two concurrent "create employee" requests both read a null, both call
 * `allocateEmployeeId`, and the business ends up with two Employee rows and two
 * employee numbers for one person — unrecoverable by anything but hand repair, and
 * invisible until somebody notices the directory has them twice.
 *
 * With it, the second request updates nothing, gets a count of 0, and the service
 * rolls its transaction back — so the second allocated number is never committed.
 */
export async function attachEmployeeToOnboarding(
  tx: Prisma.TransactionClient,
  args: { id: string; employeeId: string; stage: string },
): Promise<number> {
  const result = await tx.onboardingRecord.updateMany({
    where: { id: args.id, employeeId: null },
    data: { employeeId: args.employeeId, stage: args.stage as never },
  });
  return result.count;
}

/** Conditional, so a completed onboarding cannot be advanced again. */
export async function transitionOnboarding(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStage: string;
    data: Prisma.OnboardingRecordUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.onboardingRecord.updateMany({
    where: { id: args.id, stage: args.fromStage as never },
    data: args.data,
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Onboarding tasks
// ---------------------------------------------------------------------------

export function createOnboardingTasks(
  tx: Prisma.TransactionClient,
  data: Prisma.OnboardingTaskUncheckedCreateInput[],
): Promise<Prisma.BatchPayload> {
  return tx.onboardingTask.createMany({ data });
}

export function createOnboardingTask(
  tx: Prisma.TransactionClient,
  data: Prisma.OnboardingTaskUncheckedCreateInput,
): Promise<OnboardingTaskRecord> {
  return tx.onboardingTask.create({ data, select: onboardingTaskSelect });
}

export function findOnboardingTaskState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  onboardingRecordId: string;
  status: string;
  assigneeId: string | null;
  title: string;
} | null> {
  return tx.onboardingTask.findUnique({
    where: { id },
    select: {
      id: true,
      onboardingRecordId: true,
      status: true,
      assigneeId: true,
      title: true,
    },
  });
}

export function updateOnboardingTask(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.OnboardingTaskUncheckedUpdateInput,
): Promise<OnboardingTaskRecord> {
  return tx.onboardingTask.update({ where: { id }, data, select: onboardingTaskSelect });
}

/**
 * One task in its presentable shape, read back after a conditional settle.
 *
 * Here rather than as an inline select in the service, which is where it used to
 * live: the duplicate drifted the moment `onboardingTaskSelect` gained a column, and
 * the service then returned a row missing a field the view type required. One
 * constant, read by everything that presents a task.
 */
export function findOnboardingTaskRecord(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<OnboardingTaskRecord | null> {
  return tx.onboardingTask.findUnique({ where: { id }, select: onboardingTaskSelect });
}

/** Conditional, so one task cannot be completed twice by two people. */
export async function settleOnboardingTask(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.OnboardingTaskUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.onboardingTask.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

/**
 * Starts a probation and schedules its four reviews together.
 *
 * One nested create, so a probation cannot exist with two of its four reviews:
 * a half-scheduled probation is worse than a failed start, because the missing
 * reviews are invisible until the date passes.
 */
export function createProbation(
  tx: Prisma.TransactionClient,
  data: Prisma.ProbationRecordUncheckedCreateInput,
): Promise<ProbationDetailRecord> {
  return tx.probationRecord.create({ data, select: probationDetailSelect });
}

export function findProbation(id: string): Promise<ProbationDetailRecord | null> {
  return prisma.probationRecord.findUnique({ where: { id }, select: probationDetailSelect });
}

export function findProbationByEmployee(
  employeeId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; status: string } | null> {
  return tx.probationRecord.findUnique({
    where: { employeeId },
    select: { id: true, status: true },
  });
}

export function findProbationState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  employeeId: string;
  managerId: string | null;
  status: string;
  startDate: Date;
  endDate: Date;
} | null> {
  return tx.probationRecord.findUnique({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      managerId: true,
      status: true,
      startDate: true,
      endDate: true,
    },
  });
}

export function listProbations(args: {
  where: Prisma.ProbationRecordWhereInput;
  take: number;
  cursor?: string;
}): Promise<ProbationRowRecord[]> {
  return prisma.probationRecord.findMany({
    where: args.where,
    select: probationRowSelect,
    orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export async function countCompletedReviews(
  probationIds: readonly string[],
): Promise<Map<string, number>> {
  if (probationIds.length === 0) return new Map();

  const rows = await prisma.probationReview.groupBy({
    by: ['probationRecordId'],
    where: { probationRecordId: { in: [...probationIds] }, status: 'COMPLETED' },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.probationRecordId, row._count._all]));
}

/**
 * Decides a probation, but only from a status that has not been decided.
 *
 * Two managers confirming at once would otherwise both write, and the second would
 * overwrite the first's name on a decision that ends or secures somebody's
 * employment. The predicate makes that impossible rather than unlikely.
 */
export async function transitionProbation(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.ProbationRecordUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.probationRecord.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

export function findProbationReviewState(
  id: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  id: string;
  probationRecordId: string;
  status: string;
  reviewType: string;
} | null> {
  return tx.probationReview.findUnique({
    where: { id },
    select: { id: true, probationRecordId: true, status: true, reviewType: true },
  });
}

/** Conditional, so one review cannot be recorded twice. */
export async function settleProbationReview(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.ProbationReviewUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.probationReview.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as never } },
    data: args.data,
  });
  return result.count;
}

export function findProbationReview(id: string): Promise<ProbationReviewRecord | null> {
  return prisma.probationReview.findUnique({ where: { id }, select: probationReviewSelect });
}
