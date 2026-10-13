/**
 * Recruitment — the ATS business rules.
 *
 * Every decision lives here; the repository executes and the controller translates.
 * The three things this file is most careful about:
 *
 * ### 1. A candidate is not an employee, and never becomes one
 *
 * Nothing in this file writes `Employee`. Selection, offer and acceptance all
 * operate on `Application`; the employment record is created by
 * `onboarding.service.ts` through Phase 1's own `allocateEmployeeId`. There is no
 * second employee identity and no second employee-number scheme.
 *
 * ### 2. Stage moves go through the shared transition map
 *
 * `canMoveStage` in `@rs/shared` decides, so the browser and the API agree about
 * what is offerable. The commit points — SELECTED, OFFER_ACCEPTED, JOINED — cannot
 * be skipped forward over, because each is a point where a human commits the
 * business and a pipeline that let a misclick skip one would produce an offer
 * nobody decided to make.
 *
 * ### 3. Confidentiality is enforced on the way out, not hoped for
 *
 * Screening notes, interview concerns, verification results and compensation are
 * stripped from the response when the reader is not entitled to them — see
 * `presentApplication` and `recruitment-access.ts`. A `select` that fetched them
 * and a component that happened not to render them would be one careless change
 * away from a leak.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  ADVERSE_BACKGROUND_CHECK_STATUSES,
  ANSWERED_OFFER_STATUSES,
  type ApplicationListQuery,
  type ApplicationStage,
  type ApplicationSummary,
  type ApplicationView,
  type AssessmentView,
  type BackgroundCheckView,
  type CandidateDocumentView,
  type CandidateListQuery,
  type CandidateSummary,
  type CandidateView,
  type CreateApplicationInput,
  type CreateAssessmentInput,
  type CreateBackgroundCheckInput,
  type CreateCandidateDocumentInput,
  type CreateCandidateInput,
  type CreateJobRequisitionInput,
  type CreateOfferInput,
  type InterviewListQuery,
  type InterviewSummary,
  type InterviewView,
  type JobRequisitionListQuery,
  type JobRequisitionSummary,
  type JobRequisitionView,
  type MoveApplicationStageInput,
  type OfferListQuery,
  type OfferSummary,
  type OfferView,
  type RecordAssessmentResultInput,
  type RecordBackgroundCheckInput,
  type RespondToOfferInput,
  type ScheduleInterviewInput,
  type ScreenApplicationInput,
  type SubmitInterviewFeedbackInput,
  type UpdateCandidateInput,
  type UpdateJobRequisitionInput,
  type UpdateOfferInput,
  canMoveStage,
  nextStages,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  type RecruitmentScope,
  feedbackVisibility,
  mayDecideRecruitment,
  mayGiveInterviewFeedback,
  mayViewBackgroundChecks,
  mayViewCompensation,
  recruitmentScope,
  visibleApplicationFilter,
  visibleCandidateFilter,
  visibleJobFilter,
} from './recruitment-access.js';
import * as notifications from './recruitment.notify.js';
import * as repo from './recruitment.repository.js';

export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

/**
 * The reader's recruitment scope, resolved once per request.
 *
 * The involvement lookup is skipped entirely for somebody holding the module:
 * their scope is `all` regardless, so two queries to discover what they are
 * working on would be wasted on every request a recruiter makes.
 */
export async function scopeForRequest(actor: HrActor): Promise<RecruitmentScope> {
  if (actor.can('HR_RECRUITMENT', 'VIEW')) return { kind: 'all' };
  if (actor.employeeId === null) return { kind: 'none' };

  const involvement = await repo.findInvolvement(actor.employeeId);
  return recruitmentScope(actor, involvement);
}

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const dayKey = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/** Decimal columns cross the wire as strings; `null` stays `null`. */
const decimal = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toString();

const personName = (row: { firstName: string; lastName: string }): string =>
  `${row.firstName} ${row.lastName}`.trim();

function toEmployeeRef(row: {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
}): { id: string; employeeId: string; displayName: string } {
  return { id: row.id, employeeId: row.employeeId, displayName: personName(row) };
}

function toCandidateRef(row: {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}): { id: string; displayName: string; email: string } {
  return { id: row.id, displayName: personName(row), email: row.email };
}

function presentJobRow(
  row: repo.JobRowRecord,
  activeCount: number,
): JobRequisitionSummary {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    department: row.department,
    designation: row.designation,
    hiringManager: row.hiringManager ? toEmployeeRef(row.hiringManager) : null,
    recruiter: row.recruiter ? toEmployeeRef(row.recruiter) : null,
    employmentType: row.employmentType,
    workMode: row.workMode,
    location: row.location,
    openings: row.openings,
    status: row.status,
    priority: row.priority,
    targetJoinDate: dayKey(row.targetJoinDate),
    publishedAt: iso(row.publishedAt),
    applicationCount: row._count.applications,
    activeApplicationCount: activeCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A requisition in full.
 *
 * The salary range is nulled out rather than omitted when the reader may not see
 * it, so the shape stays stable and the UI has one thing to check. A hiring manager
 * without the module sees the role they own without seeing what it pays.
 */
function presentJob(
  row: repo.JobDetailRecord,
  activeCount: number,
  canSeePay: boolean,
): JobRequisitionView {
  return {
    ...presentJobRow(row as unknown as repo.JobRowRecord, activeCount),
    description: row.description,
    requirements: row.requirements,
    responsibilities: row.responsibilities,
    salaryRangeMin: canSeePay ? decimal(row.salaryRangeMin) : null,
    salaryRangeMax: canSeePay ? decimal(row.salaryRangeMax) : null,
    salaryCurrency: canSeePay ? row.salaryCurrency : null,
    closedAt: iso(row.closedAt),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentCandidateRow(row: repo.CandidateRowRecord): CandidateSummary {
  return {
    id: row.id,
    displayName: personName(row),
    email: row.email,
    phone: row.phone,
    location: row.location,
    source: row.source,
    currentEmployer: row.currentEmployer,
    currentDesignation: row.currentDesignation,
    totalExperienceYears: decimal(row.totalExperienceYears),
    isActive: row.isActive,
    applicationCount: row._count.applications,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentCandidateDocument(row: repo.CandidateDocumentRecord): CandidateDocumentView {
  return {
    id: row.id,
    secureDocumentId: row.secureDocumentId,
    documentType: row.documentType,
    title: row.title,
    verificationStatus: row.verificationStatus,
    verifiedBy: row.verifiedBy,
    verifiedAt: iso(row.verifiedAt),
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentAssessment(row: repo.AssessmentRecord): AssessmentView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    assessmentType: row.assessmentType,
    title: row.title,
    assignedAt: row.assignedAt.toISOString(),
    dueAt: iso(row.dueAt),
    score: decimal(row.score),
    maxScore: decimal(row.maxScore),
    status: row.status,
    reviewer: row.reviewer ? toEmployeeRef(row.reviewer) : null,
    reviewedAt: iso(row.reviewedAt),
    notes: row.notes,
  };
}

function presentBackgroundCheck(row: repo.BackgroundCheckRecord): BackgroundCheckView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    checkType: row.checkType,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: iso(row.completedAt),
    result: row.result,
    notes: row.notes,
    verifierName: row.verifierName,
    verifiedBy: row.verifiedBy,
  };
}

function presentInterviewRow(
  row: repo.InterviewRowRecord,
  viewerEmployeeId: string | null,
  viewerHasSubmitted: boolean,
): InterviewSummary {
  const participantIds = row.participants.map((p) => p.employeeId);
  const onPanel =
    viewerEmployeeId !== null &&
    (row.interviewerId === viewerEmployeeId || participantIds.includes(viewerEmployeeId));

  return {
    id: row.id,
    applicationId: row.applicationId,
    candidate: toCandidateRef(row.application.candidate),
    job: row.application.jobRequisition,
    interviewType: row.interviewType,
    round: row.round,
    scheduledAt: row.scheduledAt.toISOString(),
    durationMinutes: row.durationMinutes,
    status: row.status,
    interviewer: row.interviewer ? toEmployeeRef(row.interviewer) : null,
    participants: row.participants.map((p) => toEmployeeRef(p.employee)),
    feedbackPending: onPanel && row.status === 'SCHEDULED' && !viewerHasSubmitted,
  };
}

function presentOfferRow(row: repo.OfferRowRecord): OfferSummary {
  return {
    id: row.id,
    code: row.code,
    applicationId: row.applicationId,
    candidate: toCandidateRef(row.application.candidate),
    position: row.position,
    proposedJoiningDate: dayKey(row.proposedJoiningDate) ?? '',
    status: row.status,
    expiresOn: dayKey(row.expiresOn),
    sentAt: iso(row.sentAt),
    respondedAt: iso(row.respondedAt),
  };
}

function presentOffer(row: repo.OfferDetailRecord, canSeePay: boolean): OfferView {
  return {
    ...presentOfferRow(row as unknown as repo.OfferRowRecord),
    job: row.jobRequisition,
    department: row.department,
    designation: row.designation,
    employmentType: row.employmentType,
    workMode: row.workMode,
    location: row.location,
    annualPackage: canSeePay ? decimal(row.annualPackage) : null,
    packageCurrency: canSeePay ? row.packageCurrency : null,
    benefitsSummary: canSeePay ? row.benefitsSummary : null,
    responseNote: row.responseNote,
    secureDocumentId: row.secureDocumentId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentApplicationRow(row: repo.ApplicationRowRecord): ApplicationSummary {
  return {
    id: row.id,
    candidate: toCandidateRef(row.candidate),
    job: row.jobRequisition,
    currentStage: row.currentStage,
    status: row.status,
    appliedAt: row.appliedAt.toISOString(),
    source: row.source,
    recruiter: row.recruiter ? toEmployeeRef(row.recruiter) : null,
    hiringManager: row.hiringManager ? toEmployeeRef(row.hiringManager) : null,
    // Only a live application can move. Offering stages on a rejected one would be
    // offering buttons the service refuses.
    availableStages: row.status === 'ACTIVE' ? [...nextStages(row.currentStage)] : [],
  };
}

/**
 * An application in full, filtered to what this reader may see.
 *
 * Three separate narrowings, each protecting something different:
 *
 *   `canSeeInternal`   screening notes and the recruiter's own notes. An
 *                      interviewer reading "weak on the phone screen" has been
 *                      told the answer before forming their own view.
 *   `canSeeChecks`     verification results. "This employment claim could not be
 *                      confirmed" ends somebody's prospects, and only the people
 *                      accountable for the decision should hold it.
 *   feedback filter    other panellists' feedback, until this reader has
 *                      submitted their own — the rule that keeps a panel four
 *                      opinions rather than one repeated four times.
 */
function presentApplication(
  row: repo.ApplicationDetailRecord,
  context: {
    canSeeInternal: boolean;
    canSeeChecks: boolean;
    canSeePay: boolean;
    viewerEmployeeId: string | null;
    submittedInterviewIds: ReadonlySet<string>;
  },
): ApplicationView {
  return {
    ...presentApplicationRow(row as unknown as repo.ApplicationRowRecord),
    screeningScore: context.canSeeInternal ? row.screeningScore : null,
    screeningNotes: context.canSeeInternal ? row.screeningNotes : null,
    rejectionReason: row.rejectionReason,
    selectedBy: row.selectedBy,
    selectedAt: iso(row.selectedAt),
    notes: context.canSeeInternal ? row.notes : null,
    stageHistory: row.stageHistory.map((entry) => ({
      id: entry.id,
      fromStage: entry.fromStage,
      toStage: entry.toStage,
      reason: entry.reason,
      performedBy: entry.performedBy,
      createdAt: entry.createdAt.toISOString(),
    })),
    interviews: row.interviews.map((interview) =>
      presentInterviewRow(
        interview,
        context.viewerEmployeeId,
        context.submittedInterviewIds.has(interview.id),
      ),
    ),
    assessments: row.assessments.map(presentAssessment),
    offers: row.offers.map(presentOfferRow),
    backgroundChecks: context.canSeeChecks
      ? row.backgroundChecks.map(presentBackgroundCheck)
      : [],
    onboardingId: row.onboarding?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  Shared guards
// ---------------------------------------------------------------------------

const notFound = (): AppError =>
  new AppError('NOT_FOUND', 404, 'That record could not be found.');

/**
 * A not-found rather than a forbidden, when a reader is out of scope.
 *
 * Deliberate: telling somebody "you may not see application X" confirms that X
 * exists, which is itself a disclosure — that this business is considering
 * somebody. The same reasoning the employee directory applies to out-of-scope
 * records.
 */
async function loadVisibleApplication(
  id: string,
  scope: RecruitmentScope,
): Promise<repo.ApplicationDetailRecord> {
  const row = await repo.findApplication(id);
  if (!row) throw notFound();

  if (scope.kind === 'all') return row;
  if (scope.kind === 'none') throw notFound();

  const reachable =
    scope.applicationIds.includes(row.id) ||
    scope.jobRequisitionIds.includes(row.jobRequisition.id);
  if (!reachable) throw notFound();

  return row;
}

async function loadVisibleJob(
  id: string,
  scope: RecruitmentScope,
): Promise<repo.JobDetailRecord> {
  const row = await repo.findJob(id);
  if (!row) throw notFound();

  if (scope.kind === 'all') return row;
  if (scope.kind === 'none') throw notFound();
  if (!scope.jobRequisitionIds.includes(row.id)) throw notFound();

  return row;
}

/** Which of these interviews the viewer has already given feedback on. */
async function submittedInterviewIds(
  interviewIds: readonly string[],
  employeeId: string | null,
): Promise<Set<string>> {
  if (employeeId === null || interviewIds.length === 0) return new Set();

  const rows = await prisma.interviewFeedback.findMany({
    where: { interviewId: { in: [...interviewIds] }, employeeId },
    select: { interviewId: true },
  });
  return new Set(rows.map((r) => r.interviewId));
}

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

/**
 * Allocates a requisition reference.
 *
 * Shaped `JOB-<year>-<n>` from the database's clock rather than the server's, for
 * the reason every instant in HR comes from Postgres: a server with a wrong clock
 * would file a 2026 requisition under 2025 and the series would then contain two
 * of some numbers.
 */
async function allocateJobCode(tx: Prisma.TransactionClient): Promise<string> {
  const now = await databaseNow(tx);
  const year = now.getUTCFullYear();
  const next = await repo.allocateRecruitmentCode(tx, `JOB-${year}`);
  return `JOB-${year}-${String(next).padStart(4, '0')}`;
}

export async function createJobRequisition(
  req: Request,
  actor: HrActor,
  input: CreateJobRequisitionInput,
): Promise<JobRequisitionView> {
  await assertRangeOrdered(input.salaryRangeMin, input.salaryRangeMax);
  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);
  if (input.hiringManagerId) await assertEmployeeEmployed(input.hiringManagerId, 'hiring manager');
  if (input.recruiterId) await assertEmployeeEmployed(input.recruiterId, 'recruiter');

  const id = await prisma.$transaction(async (tx) => {
    const code = await allocateJobCode(tx);
    const created = await repo.createJobRequisition(tx, {
      code,
      title: input.title,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      hiringManagerId: input.hiringManagerId ?? null,
      recruiterId: input.recruiterId ?? null,
      employmentType: input.employmentType ?? 'FULL_TIME',
      workMode: input.workMode ?? 'ON_SITE',
      location: input.location ?? null,
      openings: input.openings ?? 1,
      description: input.description ?? null,
      requirements: input.requirements ?? null,
      responsibilities: input.responsibilities ?? null,
      salaryRangeMin: input.salaryRangeMin ?? null,
      salaryRangeMax: input.salaryRangeMax ?? null,
      salaryCurrency: input.salaryCurrency ?? 'INR',
      priority: input.priority ?? 'NORMAL',
      targetJoinDate: input.targetJoinDate ?? null,
      // Not accepted from the caller: a requisition is born DRAFT, and publishing
      // is its own endpoint so it carries a timestamp and an audit entry.
      status: 'DRAFT',
      createdById: actor.id,
    });
    return created.id;
  }, TX_OPTIONS);

  const row = await repo.findJob(id);
  if (!row) throw notFound();

  await recordAudit(req, {
    action: 'HR_JOB_REQUISITION_CREATED',
    entityType: 'JobRequisition',
    entityId: id,
    actorId: actor.id,
    // The role and its placement. No salary figure — an audit row is readable by
    // anybody with audit access, which is a wider population than HR_RECRUITMENT.
    newValue: {
      code: row.code,
      title: row.title,
      openings: row.openings,
      departmentId: row.department?.id ?? null,
      status: row.status,
    },
  });

  return presentJob(row, 0, mayViewCompensation(actor));
}

export async function listJobRequisitions(
  actor: HrActor,
  scope: RecruitmentScope,
  query: JobRequisitionListQuery,
): Promise<{ items: JobRequisitionSummary[]; nextCursor: string | null }> {
  const where: Prisma.JobRequisitionWhereInput = {
    ...(visibleJobFilter(scope) as Prisma.JobRequisitionWhereInput),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.recruiterId ? { recruiterId: query.recruiterId } : {}),
    ...(query.hiringManagerId ? { hiringManagerId: query.hiringManagerId } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { code: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // One more than asked for, so "is there another page" needs no second count —
  // the cursor convention every list in this codebase uses.
  const rows = await repo.listJobs({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);
  const activeCounts = await repo.countActiveApplications(page.map((r) => r.id));

  return {
    items: page.map((row) => presentJobRow(row, activeCounts.get(row.id) ?? 0)),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getJobRequisition(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<JobRequisitionView> {
  const row = await loadVisibleJob(id, scope);
  const activeCounts = await repo.countActiveApplications([id]);
  return presentJob(row, activeCounts.get(id) ?? 0, mayViewCompensation(actor));
}

export async function updateJobRequisition(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateJobRequisitionInput,
): Promise<JobRequisitionView> {
  const before = await repo.findJobState(id);
  if (!before) throw notFound();

  /*
    A closed or cancelled requisition is history. Amending its title or its
    openings would change what the applications on it were applications *for*,
    which is the kind of quiet rewriting that makes a record untrustworthy.
  */
  if (before.status === 'CLOSED' || before.status === 'CANCELLED') {
    throw AppError.badRequest(
      'JOB_NOT_OPEN',
      'A closed requisition cannot be changed. Raise a new one.',
    );
  }

  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);
  if (input.hiringManagerId) await assertEmployeeEmployed(input.hiringManagerId, 'hiring manager');
  if (input.recruiterId) await assertEmployeeEmployed(input.recruiterId, 'recruiter');

  await prisma.$transaction(
    (tx) => repo.updateJob(tx, id, input as Prisma.JobRequisitionUpdateInput),
    TX_OPTIONS,
  );

  const row = await repo.findJob(id);
  if (!row) throw notFound();

  await recordAudit(req, {
    action: 'HR_JOB_REQUISITION_UPDATED',
    entityType: 'JobRequisition',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  const activeCounts = await repo.countActiveApplications([id]);
  return presentJob(row, activeCounts.get(id) ?? 0, mayViewCompensation(actor));
}

/**
 * Publishing a role.
 *
 * APPROVE rather than EDIT: publishing commits the business to hiring and starts
 * accepting applications from real people, which is different in kind from
 * amending a job description.
 *
 * The transition is conditional on the current status, so two recruiters
 * publishing one draft cannot both stamp a different `publishedAt`.
 */
export async function publishJobRequisition(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<JobRequisitionView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Publishing a role needs recruitment approval rights.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionJob(tx, {
      id,
      fromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAUSED'],
      data: { status: 'PUBLISHED', publishedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    const current = await repo.findJobState(id);
    if (!current) throw notFound();
    throw AppError.conflict(
      'JOB_NOT_PUBLISHABLE',
      `This role is ${current.status.toLowerCase()} and cannot be published.`,
    );
  }

  await recordAudit(req, {
    action: 'HR_JOB_REQUISITION_PUBLISHED',
    entityType: 'JobRequisition',
    entityId: id,
    actorId: actor.id,
  });

  const row = await repo.findJob(id);
  if (!row) throw notFound();
  const activeCounts = await repo.countActiveApplications([id]);
  return presentJob(row, activeCounts.get(id) ?? 0, mayViewCompensation(actor));
}

export async function pauseJobRequisition(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<JobRequisitionView> {
  const changed = await prisma.$transaction(
    (tx) =>
      repo.transitionJob(tx, {
        id,
        fromStatuses: ['PUBLISHED'],
        data: { status: 'PAUSED' },
      }),
    TX_OPTIONS,
  );

  if (changed === 0) {
    throw AppError.conflict(
      'JOB_NOT_PAUSABLE',
      'Only a published role can be paused.',
    );
  }

  await recordAudit(req, {
    action: 'HR_JOB_REQUISITION_PAUSED',
    entityType: 'JobRequisition',
    entityId: id,
    actorId: actor.id,
  });

  const row = await repo.findJob(id);
  if (!row) throw notFound();
  const activeCounts = await repo.countActiveApplications([id]);
  return presentJob(row, activeCounts.get(id) ?? 0, mayViewCompensation(actor));
}

/**
 * Closing a role.
 *
 * The live applications on it are **not** auto-rejected, deliberately. Closing a
 * requisition is an administrative act; rejecting somebody is a decision addressed
 * to them, and each needs its own reason. Mass-rejecting on close would produce a
 * dozen rejections nobody wrote and nobody could explain.
 */
export async function closeJobRequisition(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<JobRequisitionView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Closing a role needs recruitment approval rights.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionJob(tx, {
      id,
      fromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'PAUSED'],
      data: { status: 'CLOSED', closedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('JOB_NOT_CLOSABLE', 'This role is already closed or cancelled.');
  }

  await recordAudit(req, {
    action: 'HR_JOB_REQUISITION_CLOSED',
    entityType: 'JobRequisition',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  const row = await repo.findJob(id);
  if (!row) throw notFound();
  const activeCounts = await repo.countActiveApplications([id]);
  return presentJob(row, activeCounts.get(id) ?? 0, mayViewCompensation(actor));
}

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export async function createCandidate(
  req: Request,
  actor: HrActor,
  input: CreateCandidateInput,
): Promise<CandidateView> {
  /*
    Checked before the transaction so the caller gets a useful message naming the
    existing candidate rather than a raw unique-constraint error — and again by the
    index, so a race cannot slip past. The same belt-and-braces shape
    `createEmployee` uses for work email.
  */
  const existing = await repo.findCandidateByEmail(input.email);
  if (existing) {
    throw AppError.conflict(
      'CANDIDATE_EXISTS',
      'A candidate with that email already exists. Add an application to them instead.',
    );
  }

  const id = await prisma.$transaction(async (tx) => {
    const created = await repo.createCandidate(tx, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone ?? null,
      location: input.location ?? null,
      source: input.source ?? 'DIRECT',
      sourceDetail: input.sourceDetail ?? null,
      totalExperienceYears: input.totalExperienceYears ?? null,
      currentEmployer: input.currentEmployer ?? null,
      currentDesignation: input.currentDesignation ?? null,
      skills: input.skills ?? [],
      notes: input.notes ?? null,
      createdById: actor.id,
    });
    return created.id;
  }, TX_OPTIONS);

  const row = await repo.findCandidate(id);
  if (!row) throw notFound();

  await recordAudit(req, {
    action: 'HR_CANDIDATE_CREATED',
    entityType: 'Candidate',
    entityId: id,
    actorId: actor.id,
    // Identity and source. No notes — a recruiter's private assessment does not
    // belong in a table with a wider read population than recruitment.
    newValue: { email: row.email, source: row.source },
  });

  return presentCandidateFull(row, { canSeeInternal: true });
}

function presentCandidateFull(
  row: repo.CandidateDetailRecord,
  context: { canSeeInternal: boolean },
): CandidateView {
  return {
    ...presentCandidateRow(row as unknown as repo.CandidateRowRecord),
    firstName: row.firstName,
    lastName: row.lastName,
    sourceDetail: row.sourceDetail,
    skills: row.skills,
    notes: context.canSeeInternal ? row.notes : null,
    // Applications are listed through the application endpoints, which apply their
    // own scope. Embedding them here would bypass that.
    applications: [],
    documents: row.documents.map(presentCandidateDocument),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCandidates(
  scope: RecruitmentScope,
  query: CandidateListQuery,
): Promise<{ items: CandidateSummary[]; nextCursor: string | null }> {
  const where: Prisma.CandidateWhereInput = {
    ...(visibleCandidateFilter(scope) as Prisma.CandidateWhereInput),
    ...(query.source ? { source: query.source } : {}),
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.search
      ? {
          OR: [
            { firstName: { contains: query.search, mode: 'insensitive' } },
            { lastName: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const rows = await repo.listCandidates({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);

  return {
    items: page.map(presentCandidateRow),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getCandidate(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<CandidateView> {
  const row = await repo.findCandidate(id);
  if (!row) throw notFound();

  /*
    A candidate is reachable only through an application in reach. An interviewer
    who may read one application has no business reading the profile of somebody
    they were never booked against — and a not-found rather than a forbidden,
    because confirming the record exists is itself a disclosure.
  */
  if (scope.kind !== 'all') {
    if (scope.kind === 'none') throw notFound();
    const reachable = await prisma.application.findFirst({
      where: {
        candidateId: id,
        OR: [
          { id: { in: [...scope.applicationIds] } },
          { jobRequisitionId: { in: [...scope.jobRequisitionIds] } },
        ],
      },
      select: { id: true },
    });
    if (!reachable) throw notFound();
  }

  return presentCandidateFull(row, { canSeeInternal: scope.kind === 'all' });
}

export async function updateCandidate(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateCandidateInput,
): Promise<CandidateView> {
  const row = await repo.findCandidate(id);
  if (!row) throw notFound();

  await prisma.$transaction(
    (tx) => repo.updateCandidate(tx, id, input as Prisma.CandidateUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_CANDIDATE_UPDATED',
    entityType: 'Candidate',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  const updated = await repo.findCandidate(id);
  if (!updated) throw notFound();
  return presentCandidateFull(updated, { canSeeInternal: true });
}

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export async function createApplication(
  req: Request,
  actor: HrActor,
  input: CreateApplicationInput,
): Promise<ApplicationView> {
  const job = await repo.findJobState(input.jobRequisitionId);
  if (!job) throw AppError.badRequest('JOB_NOT_FOUND', 'That role could not be found.');

  /*
    Applications are accepted only against a published role. A draft is not yet a
    vacancy, and a closed one is history — in both cases an application would be a
    record of somebody applying for something that was not open, which is unfair to
    them and misleading to whoever reads the pipeline later.
  */
  if (job.status !== 'PUBLISHED') {
    throw AppError.badRequest(
      'JOB_NOT_ACCEPTING',
      'That role is not currently accepting applications.',
    );
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id: input.candidateId },
    select: { id: true, isActive: true },
  });
  if (!candidate) {
    throw AppError.badRequest('CANDIDATE_NOT_FOUND', 'That candidate could not be found.');
  }

  const id = await prisma.$transaction(async (tx) => {
    const created = await repo.createApplication(tx, {
      candidateId: input.candidateId,
      jobRequisitionId: input.jobRequisitionId,
      source: input.source ?? 'DIRECT',
      notes: input.notes ?? null,
      // Defaulted from the requisition, which is the whole reason it holds them.
      recruiterId: job.recruiterId,
      hiringManagerId: job.hiringManagerId,
      currentStage: 'APPLICATION',
      status: 'ACTIVE',
    });

    // The first history entry has no `fromStage`: an application starts somewhere
    // rather than moving from nowhere.
    await repo.recordStageChange(tx, {
      applicationId: created.id,
      fromStage: null,
      toStage: 'APPLICATION',
      performedById: actor.id,
    });

    return created.id;
  }, TX_OPTIONS).catch((error: unknown) => {
    // The composite unique is the real guard: two concurrent applies for one role
    // cannot both land, and this turns the constraint into a sentence.
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'ALREADY_APPLIED',
        'This candidate has already applied for that role.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_APPLICATION_CREATED',
    entityType: 'Application',
    entityId: id,
    actorId: actor.id,
    newValue: { jobRequisitionId: input.jobRequisitionId, candidateId: input.candidateId },
  });

  const row = await repo.findApplication(id);
  if (!row) throw notFound();
  return presentApplication(row, {
    canSeeInternal: true,
    canSeeChecks: true,
    canSeePay: mayViewCompensation(actor),
    viewerEmployeeId: actor.employeeId,
    submittedInterviewIds: new Set(),
  });
}

export async function listApplications(
  scope: RecruitmentScope,
  query: ApplicationListQuery,
): Promise<{ items: ApplicationSummary[]; nextCursor: string | null }> {
  const where: Prisma.ApplicationWhereInput = {
    ...(visibleApplicationFilter(scope) as Prisma.ApplicationWhereInput),
    ...(query.jobRequisitionId ? { jobRequisitionId: query.jobRequisitionId } : {}),
    ...(query.candidateId ? { candidateId: query.candidateId } : {}),
    ...(query.stage ? { currentStage: query.stage } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.recruiterId ? { recruiterId: query.recruiterId } : {}),
    ...(query.search
      ? {
          candidate: {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
  };

  const rows = await repo.listApplications({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);

  return {
    items: page.map(presentApplicationRow),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getApplication(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<ApplicationView> {
  const row = await loadVisibleApplication(id, scope);
  const submitted = await submittedInterviewIds(
    row.interviews.map((i) => i.id),
    actor.employeeId,
  );

  return presentApplication(row, {
    canSeeInternal: scope.kind === 'all',
    canSeeChecks: mayViewBackgroundChecks(actor),
    canSeePay: mayViewCompensation(actor),
    viewerEmployeeId: actor.employeeId,
    submittedInterviewIds: submitted,
  });
}

/** Recording a screening judgement. Does not move the stage — that is a separate act. */
export async function screenApplication(
  req: Request,
  actor: HrActor,
  id: string,
  input: ScreenApplicationInput,
): Promise<ApplicationView> {
  const before = await repo.findApplicationState(id);
  if (!before) throw notFound();
  if (before.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'APPLICATION_NOT_ACTIVE',
      'This application is no longer active.',
    );
  }

  await prisma.$transaction(
    (tx) =>
      repo.updateApplication(tx, id, {
        screeningScore: input.screeningScore ?? null,
        screeningNotes: input.screeningNotes ?? null,
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_APPLICATION_SCREENED',
    entityType: 'Application',
    entityId: id,
    actorId: actor.id,
    // The score, not the notes: a free-text assessment of a person does not belong
    // in the audit table.
    newValue: { screeningScore: input.screeningScore ?? null },
  });

  return getApplication(actor, { kind: 'all' }, id);
}

/**
 * Moving an application through the pipeline.
 *
 * Three guards, in order:
 *
 *   1. The application must be live. A rejected application's stage is the record
 *      of how far somebody got, and moving it would rewrite that.
 *   2. The move must be in the shared transition map, so a commit point cannot be
 *      skipped forward over.
 *   3. Reaching SELECTED needs APPROVE and stamps the decider. That is the point
 *      where the business commits, and it must be attributable.
 *
 * The write is conditional on the stage *and* status it expected, so two recruiters
 * moving one application cannot both succeed and silently erase each other.
 */
export async function moveApplicationStage(
  req: Request,
  actor: HrActor,
  id: string,
  input: MoveApplicationStageInput,
): Promise<ApplicationView> {
  const before = await repo.findApplicationState(id);
  if (!before) throw notFound();

  if (before.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'APPLICATION_NOT_ACTIVE',
      'Only a live application can be moved.',
    );
  }

  const fromStage = before.currentStage as ApplicationStage;
  if (!canMoveStage(fromStage, input.toStage)) {
    throw AppError.badRequest(
      'STAGE_MOVE_NOT_ALLOWED',
      `An application at ${fromStage} cannot move to ${input.toStage}.`,
    );
  }

  const reachingSelection = input.toStage === 'SELECTED';
  if (reachingSelection && !mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Selecting a candidate needs recruitment approval rights.',
    );
  }

  /*
    JOINED is reachable only once the employment record exists. Checked here rather
    than trusted, because the whole pipeline converges on this: an application
    marked JOINED with no Employee behind it would say somebody started work who
    was never actually hired.
  */
  if (input.toStage === 'JOINED') {
    const onboarding = await repo.findOnboardingByApplication(id);
    if (!onboarding || onboarding.employeeId === null) {
      throw AppError.badRequest(
        'EMPLOYEE_NOT_CREATED',
        'The employment record has to be created before this application can be marked joined.',
      );
    }
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const count = await repo.transitionApplication(tx, {
      id,
      fromStage: before.currentStage,
      fromStatuses: ['ACTIVE'],
      data: {
        currentStage: input.toStage,
        ...(input.toStage === 'JOINED' ? { status: 'HIRED' } : {}),
        ...(reachingSelection && before.selectedAt === null
          ? { selectedById: actor.id, selectedAt: now }
          : {}),
      },
    });

    if (count > 0) {
      await repo.recordStageChange(tx, {
        applicationId: id,
        fromStage: before.currentStage as never,
        toStage: input.toStage,
        reason: input.reason ?? null,
        performedById: actor.id,
      });
    }

    return count;
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'APPLICATION_MOVED',
      'Somebody else moved this application. Reload and try again.',
    );
  }

  await recordAudit(req, {
    action: 'HR_APPLICATION_STAGE_MOVED',
    entityType: 'Application',
    entityId: id,
    actorId: actor.id,
    oldValue: { stage: before.currentStage },
    newValue: { stage: input.toStage },
  });

  /*
    The one pipeline event worth a notice: the panel is done and a named person has
    to decide. Everything else in the pipeline is read from the board.
  */
  if (input.toStage === 'FINAL_INTERVIEW' && before.hiringManagerId) {
    const managerUserId = await repo.findUserIdForEmployee(before.hiringManagerId);
    if (managerUserId) {
      await notifications.notifyApplicationDecisionRequired([managerUserId], id);
    }
  }

  return getApplication(actor, { kind: 'all' }, id);
}

export async function rejectApplication(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<ApplicationView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Rejecting an application needs approval rights.');
  }

  const before = await repo.findApplicationState(id);
  if (!before) throw notFound();

  const changed = await prisma.$transaction(
    (tx) =>
      repo.transitionApplication(tx, {
        id,
        fromStatuses: ['ACTIVE'],
        // The stage is deliberately left where it was: it records how far somebody
        // got, and a rejection should not erase that.
        data: { status: 'REJECTED', rejectionReason: reason },
      }),
    TX_OPTIONS,
  );

  if (changed === 0) {
    throw AppError.conflict(
      'APPLICATION_NOT_ACTIVE',
      'This application has already been decided.',
    );
  }

  await recordAudit(req, {
    action: 'HR_APPLICATION_REJECTED',
    entityType: 'Application',
    entityId: id,
    actorId: actor.id,
    newValue: { stage: before.currentStage, reason },
  });

  return getApplication(actor, { kind: 'all' }, id);
}

export async function withdrawApplication(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<ApplicationView> {
  const before = await repo.findApplicationState(id);
  if (!before) throw notFound();

  const changed = await prisma.$transaction(
    (tx) =>
      repo.transitionApplication(tx, {
        id,
        fromStatuses: ['ACTIVE'],
        // WITHDRAWN rather than REJECTED, because who decided matters: this was the
        // candidate's choice, and recording it as a rejection would misattribute it.
        data: { status: 'WITHDRAWN', rejectionReason: reason },
      }),
    TX_OPTIONS,
  );

  if (changed === 0) {
    throw AppError.conflict(
      'APPLICATION_NOT_ACTIVE',
      'This application has already been decided.',
    );
  }

  await recordAudit(req, {
    action: 'HR_APPLICATION_WITHDRAWN',
    entityType: 'Application',
    entityId: id,
    actorId: actor.id,
    newValue: { stage: before.currentStage, reason },
  });

  return getApplication(actor, { kind: 'all' }, id);
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

async function assertRangeOrdered(min?: number, max?: number): Promise<void> {
  if (min !== undefined && max !== undefined && max < min) {
    throw AppError.badRequest(
      'SALARY_RANGE_INVALID',
      'The top of the range cannot be below the bottom.',
    );
  }
}

async function assertDepartmentExists(id: string): Promise<void> {
  const row = await prisma.department.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw AppError.badRequest('DEPARTMENT_NOT_FOUND', 'That department does not exist.');
  if (row.status !== 'ACTIVE') {
    throw AppError.badRequest('DEPARTMENT_INACTIVE', 'That department is archived.');
  }
}

async function assertDesignationExists(id: string): Promise<void> {
  const row = await prisma.designation.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw AppError.badRequest('DESIGNATION_NOT_FOUND', 'That designation does not exist.');
  if (row.status !== 'ACTIVE') {
    throw AppError.badRequest('DESIGNATION_INACTIVE', 'That designation is archived.');
  }
}

/**
 * A departed employee cannot be given recruitment work.
 *
 * Checked rather than assumed: an exited hiring manager on an open requisition
 * means a vacancy nobody owns, and the notification would go to a disabled account.
 */
async function assertEmployeeEmployed(id: string, role: string): Promise<void> {
  const row = await prisma.employee.findUnique({ where: { id }, select: { status: true } });
  if (!row) {
    throw AppError.badRequest('EMPLOYEE_NOT_FOUND', `That ${role} could not be found.`);
  }
  if (row.status === 'EXITED') {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_EMPLOYED',
      `That person has left, so they cannot be set as ${role}.`,
    );
  }
}

export {
  ADVERSE_BACKGROUND_CHECK_STATUSES,
  ANSWERED_OFFER_STATUSES,
  presentApplication,
  presentAssessment,
  presentBackgroundCheck,
  presentInterviewRow,
  presentOffer,
  presentOfferRow,
  submittedInterviewIds,
  loadVisibleApplication,
  notFound,
  iso,
  dayKey,
  decimal,
  toEmployeeRef,
  toCandidateRef,
  isUniqueViolation,
  assertDepartmentExists,
  assertDesignationExists,
  assertEmployeeEmployed,
};
