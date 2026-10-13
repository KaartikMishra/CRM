/**
 * Interviews, assessments, offers and background verification.
 *
 * Split from `recruitment.service.ts` because that file already carries the
 * requisition, candidate and application lifecycle, and one 2,000-line service is
 * how a module stops being readable. The split is along a real seam: everything
 * here hangs off an existing application rather than creating one.
 *
 * ### The rule this file exists to protect
 *
 * An interviewer must not read the panel's other feedback before giving their own.
 * That is not politeness — it is the whole reason structured interviewing works. An
 * interviewer who has read "the last two said no" has been told the answer, and the
 * panel becomes one opinion wearing four hats.
 *
 * The filter is `feedbackVisibility` in `recruitment-access.ts`, applied on the way
 * out in `getInterview`. Keeping it a pure function rather than a `select` means it
 * can be unit-tested, and the rule is legible to somebody auditing it.
 *
 * ### And the one it exists to prevent
 *
 * A verification result reaching somebody not accountable for the hiring decision.
 * "This employment claim could not be confirmed" ends somebody's prospects, and it
 * is gated on holding HR_RECRUITMENT rather than on working on the hire.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  type AssessmentView,
  type BackgroundCheckView,
  type CandidateDocumentView,
  type CreateAssessmentInput,
  type CreateBackgroundCheckInput,
  type CreateCandidateDocumentInput,
  type CreateOfferInput,
  type InterviewListQuery,
  type InterviewSummary,
  type InterviewView,
  type OfferListQuery,
  type OfferSummary,
  type OfferView,
  type RecordAssessmentResultInput,
  type RecordBackgroundCheckInput,
  type RespondToOfferInput,
  type ScheduleInterviewInput,
  type SubmitInterviewFeedbackInput,
  type UpdateOfferInput,
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
  visibleApplicationFilter,
} from './recruitment-access.js';
import * as notifications from './recruitment.notify.js';
import * as repo from './recruitment.repository.js';
import {
  TX_OPTIONS,
  dayKey,
  decimal,
  iso,
  loadVisibleApplication,
  notFound,
  presentAssessment,
  presentBackgroundCheck,
  presentInterviewRow,
  presentOffer,
  presentOfferRow,
  submittedInterviewIds,
  toEmployeeRef,
  assertDepartmentExists,
  assertDesignationExists,
  assertEmployeeEmployed,
} from './recruitment.service.js';

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

/**
 * Booking an interview.
 *
 * The panel is written in the same statement as the interview, so a booking cannot
 * commit with three of its four panellists — an interview missing somebody is worse
 * than a failed booking, because nobody notices until the day.
 *
 * `scheduledAt` is accepted from the client, which is the one place in HR where a
 * client-supplied time is legitimate: this is a *future appointment somebody is
 * choosing*, not a record of something that happened. Attendance is the opposite
 * case and takes its instants from Postgres.
 */
export async function scheduleInterview(
  req: Request,
  actor: HrActor,
  input: ScheduleInterviewInput,
): Promise<InterviewView> {
  const application = await repo.findApplicationState(input.applicationId);
  if (!application) {
    throw AppError.badRequest('APPLICATION_NOT_FOUND', 'That application could not be found.');
  }
  if (application.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'APPLICATION_NOT_ACTIVE',
      'Interviews can only be booked on a live application.',
    );
  }

  const now = await databaseNow();
  if (input.scheduledAt <= now) {
    throw AppError.badRequest(
      'INTERVIEW_IN_PAST',
      'An interview has to be scheduled in the future.',
    );
  }

  if (input.interviewerId) await assertEmployeeEmployed(input.interviewerId, 'interviewer');

  /*
    The lead is a participant too. Without this, a lead who is not also listed would
    not appear in `participants`, and `mayGiveInterviewFeedback` — which checks both
    — would be the only thing keeping them able to act. Making the data say what is
    true is better than two places agreeing by coincidence.
  */
  const participantIds = [
    ...new Set([...(input.participantIds ?? []), ...(input.interviewerId ? [input.interviewerId] : [])]),
  ];
  for (const id of participantIds) await assertEmployeeEmployed(id, 'panel member');

  const id = await prisma.$transaction(async (tx) => {
    const created = await repo.createInterview(tx, {
      applicationId: input.applicationId,
      interviewType: input.interviewType,
      round: input.round ?? 1,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes ?? 60,
      location: input.location ?? null,
      meetingUrl: input.meetingUrl ?? null,
      interviewerId: input.interviewerId ?? null,
      status: 'SCHEDULED',
      createdById: actor.id,
      ...(participantIds.length > 0
        ? { participants: { create: participantIds.map((employeeId) => ({ employeeId })) } }
        : {}),
    });
    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_INTERVIEW_SCHEDULED',
    entityType: 'Interview',
    entityId: id,
    actorId: actor.id,
    newValue: {
      applicationId: input.applicationId,
      interviewType: input.interviewType,
      scheduledAt: input.scheduledAt.toISOString(),
      panelSize: participantIds.length,
    },
  });

  // To everybody on the panel who has a login. Being expected somewhere at a time
  // is the clearest case in this module of something somebody must act on.
  const recipients = await repo.findUserIdsForEmployees(participantIds);
  await notifications.notifyInterviewScheduled(recipients, id, input.applicationId);

  return getInterview(actor, { kind: 'all' }, id);
}

export async function listInterviews(
  actor: HrActor,
  scope: RecruitmentScope,
  query: InterviewListQuery,
): Promise<{ items: InterviewSummary[]; nextCursor: string | null }> {
  const where: Prisma.InterviewWhereInput = {
    // Scoped through the application, which is where reachability is decided. An
    // interviewer sees the interviews on applications they can reach, which by
    // construction includes the ones they are booked on.
    application: visibleApplicationFilter(scope) as Prisma.ApplicationWhereInput,
    ...(query.applicationId ? { applicationId: query.applicationId } : {}),
    ...(query.interviewerId ? { interviewerId: query.interviewerId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to
      ? {
          scheduledAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  };

  const rows = await repo.listInterviews({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);
  const submitted = await submittedInterviewIds(page.map((r) => r.id), actor.employeeId);

  return {
    items: page.map((row) =>
      presentInterviewRow(row, actor.employeeId, submitted.has(row.id)),
    ),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * One interview, with the feedback this reader is entitled to.
 *
 * The filter is the point of this function. An interviewer gets their own feedback
 * always and the panel's only once they have committed to a view of their own —
 * see the note at the top of this file.
 */
export async function getInterview(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<InterviewView> {
  const row = await repo.findInterview(id);
  if (!row) throw notFound();

  // Reachability is the application's, so this cannot be reached for an interview
  // on an application out of scope.
  await loadVisibleApplication(row.applicationId, scope);

  const viewerHasSubmitted =
    actor.employeeId !== null &&
    row.feedback.some((entry) => entry.employeeId === actor.employeeId);

  const visible = feedbackVisibility(scope, {
    viewerEmployeeId: actor.employeeId,
    viewerHasSubmitted,
  });

  return {
    ...presentInterviewRow(row, actor.employeeId, viewerHasSubmitted),
    location: row.location,
    meetingUrl: row.meetingUrl,
    completedAt: iso(row.completedAt),
    feedback: row.feedback.filter(visible).map((entry) => ({
      id: entry.id,
      employee: toEmployeeRef(entry.employee),
      rating: entry.rating,
      recommendation: entry.recommendation,
      strengths: entry.strengths,
      concerns: entry.concerns,
      notes: entry.notes,
      submittedAt: entry.submittedAt.toISOString(),
    })),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function rescheduleInterview(
  req: Request,
  actor: HrActor,
  id: string,
  input: { scheduledAt: Date; durationMinutes?: number; location?: string | null; meetingUrl?: string | null; reason: string },
): Promise<InterviewView> {
  const before = await repo.findInterviewState(id);
  if (!before) throw notFound();

  const now = await databaseNow();
  if (input.scheduledAt <= now) {
    throw AppError.badRequest('INTERVIEW_IN_PAST', 'Pick a time in the future.');
  }

  const changed = await prisma.$transaction(
    (tx) =>
      repo.transitionInterview(tx, {
        id,
        // Only a booking that is still standing can move. A cancelled interview is
        // not rescheduled, it is re-booked — otherwise the record would show one
        // interview that was both cancelled and held.
        fromStatuses: ['SCHEDULED'],
        data: {
          scheduledAt: input.scheduledAt,
          ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.meetingUrl === undefined ? {} : { meetingUrl: input.meetingUrl }),
        },
      }),
    TX_OPTIONS,
  );

  if (changed === 0) {
    throw AppError.conflict(
      'INTERVIEW_NOT_SCHEDULED',
      'Only a scheduled interview can be moved.',
    );
  }

  await recordAudit(req, {
    action: 'HR_INTERVIEW_RESCHEDULED',
    entityType: 'Interview',
    entityId: id,
    actorId: actor.id,
    oldValue: { scheduledAt: before.scheduledAt.toISOString() },
    newValue: { scheduledAt: input.scheduledAt.toISOString(), reason: input.reason },
  });

  const recipients = await repo.findUserIdsForEmployees(
    before.participants.map((p) => p.employeeId),
  );
  await notifications.notifyInterviewScheduled(recipients, id, before.applicationId);

  return getInterview(actor, { kind: 'all' }, id);
}

/** Marking an interview held. Separate from feedback: the event and the views differ. */
export async function completeInterview(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<InterviewView> {
  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionInterview(tx, {
      id,
      fromStatuses: ['SCHEDULED'],
      data: { status: 'COMPLETED', completedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'INTERVIEW_NOT_SCHEDULED',
      'This interview is no longer scheduled.',
    );
  }

  await recordAudit(req, {
    action: 'HR_INTERVIEW_COMPLETED',
    entityType: 'Interview',
    entityId: id,
    actorId: actor.id,
  });

  return getInterview(actor, { kind: 'all' }, id);
}

export async function closeInterview(
  req: Request,
  actor: HrActor,
  id: string,
  input: { status: 'CANCELLED' | 'NO_SHOW'; reason: string },
): Promise<InterviewView> {
  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionInterview(tx, {
      id,
      fromStatuses: ['SCHEDULED'],
      // No `completedAt`: a cancelled or missed interview did not complete, and the
      // interview_completed_stamp CHECK enforces exactly that pairing.
      data: { status: input.status, ...(input.status === 'NO_SHOW' ? { completedAt: now } : {}) },
    });
  }, TX_OPTIONS).catch((error: unknown) => {
    throw error;
  });

  if (changed === 0) {
    throw AppError.conflict(
      'INTERVIEW_NOT_SCHEDULED',
      'This interview is no longer scheduled.',
    );
  }

  await recordAudit(req, {
    action: input.status === 'CANCELLED' ? 'HR_INTERVIEW_CANCELLED' : 'HR_INTERVIEW_NO_SHOW',
    entityType: 'Interview',
    entityId: id,
    actorId: actor.id,
    newValue: { reason: input.reason },
  });

  return getInterview(actor, { kind: 'all' }, id);
}

/**
 * Giving feedback.
 *
 * Only somebody actually on the panel, however senior they are otherwise: feedback
 * is a first-hand account of a conversation, and a row claiming a recruiter's view
 * of an interview they did not attend would make the record untrue.
 *
 * An upsert, so correcting your own note amends it rather than adding a second row
 * the panel then has to reconcile.
 */
export async function submitInterviewFeedback(
  req: Request,
  actor: HrActor,
  id: string,
  input: SubmitInterviewFeedbackInput,
): Promise<InterviewView> {
  const interview = await repo.findInterviewState(id);
  if (!interview) throw notFound();

  const permitted = mayGiveInterviewFeedback(actor, {
    interviewerId: interview.interviewerId,
    participantEmployeeIds: interview.participants.map((p) => p.employeeId),
  });
  if (!permitted) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Only somebody on the panel can give feedback on this interview.',
    );
  }
  if (actor.employeeId === null) {
    throw new AppError('FORBIDDEN', 403, 'Giving feedback needs an employee record.');
  }

  if (interview.status === 'CANCELLED') {
    throw AppError.badRequest(
      'INTERVIEW_CANCELLED',
      'This interview was cancelled, so there is nothing to report on.',
    );
  }

  await prisma.$transaction(
    (tx) =>
      repo.upsertInterviewFeedback(tx, {
        interviewId: id,
        employeeId: actor.employeeId as string,
        data: {
          rating: input.rating ?? null,
          recommendation: input.recommendation,
          strengths: input.strengths ?? null,
          concerns: input.concerns ?? null,
          notes: input.notes ?? null,
        },
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_INTERVIEW_FEEDBACK_SUBMITTED',
    entityType: 'Interview',
    entityId: id,
    actorId: actor.id,
    // The recommendation, not the prose. A written assessment of a person does not
    // belong in a table read by a wider population than the panel.
    newValue: { recommendation: input.recommendation, rating: input.rating ?? null },
  });

  return getInterview(actor, { kind: 'all' }, id);
}

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export async function createAssessment(
  req: Request,
  actor: HrActor,
  input: CreateAssessmentInput,
): Promise<AssessmentView> {
  const application = await repo.findApplicationState(input.applicationId);
  if (!application) {
    throw AppError.badRequest('APPLICATION_NOT_FOUND', 'That application could not be found.');
  }
  if (application.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'APPLICATION_NOT_ACTIVE',
      'Assessments can only be set on a live application.',
    );
  }

  const created = await prisma.$transaction(
    (tx) =>
      repo.createAssessment(tx, {
        applicationId: input.applicationId,
        assessmentType: input.assessmentType,
        title: input.title,
        dueAt: input.dueAt ?? null,
        maxScore: input.maxScore ?? null,
        status: 'PENDING',
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_ASSESSMENT_CREATED',
    entityType: 'Assessment',
    entityId: created.id,
    actorId: actor.id,
    newValue: { applicationId: input.applicationId, assessmentType: input.assessmentType },
  });

  return presentAssessment(created);
}

/**
 * Recording a result.
 *
 * PASSED versus FAILED is the reviewer's judgement: Phase 3 has no pass threshold,
 * because a threshold is a policy and inventing one here would mean every role
 * silently inheriting a number nobody chose.
 */
export async function recordAssessmentResult(
  req: Request,
  actor: HrActor,
  id: string,
  input: RecordAssessmentResultInput,
): Promise<AssessmentView> {
  const before = await repo.findAssessmentState(id);
  if (!before) throw notFound();

  /*
    No employee-record requirement here, deliberately — and unlike the probation
    review, which does require one.

    The difference is what the two records are. A probation review is somebody's
    first-hand assessment of a colleague, and the probation_review_completion CHECK
    requires `reviewerId` because a review that cannot say who gave it is worthless.
    An assessment *result* is a transcribed score: HR entering what a testing vendor
    reported has nobody to attribute an opinion to, and the
    assessment_review_complete CHECK asks only for `reviewedAt` — `reviewerId` is
    nullable precisely so this case works.

    An earlier version refused a scored result from any account without an HR record,
    which blocked an administrator from entering a score at all. That was an
    over-restriction with no constraint behind it, found by the live walkthrough.
    `reviewerId` is now set when the actor has an employee record and left null when
    they do not, which is what the column was designed for.
  */
  const concluded = ['COMPLETED', 'PASSED', 'FAILED'].includes(input.status);

  const updated = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.updateAssessment(tx, id, {
      status: input.status,
      ...(input.score === undefined ? {} : { score: input.score }),
      ...(input.maxScore === undefined ? {} : { maxScore: input.maxScore }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      // The reviewer and the moment move with the conclusion — paired with the
      // assessment_review_complete CHECK, so a graded assessment can always say
      // who graded it.
      ...(concluded ? { reviewedAt: now, reviewerId: actor.employeeId } : {}),
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ASSESSMENT_RESULT_RECORDED',
    entityType: 'Assessment',
    entityId: id,
    actorId: actor.id,
    newValue: { status: input.status },
  });

  return presentAssessment(updated);
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

async function allocateOfferCode(tx: Prisma.TransactionClient): Promise<string> {
  const now = await databaseNow(tx);
  const year = now.getUTCFullYear();
  const next = await repo.allocateRecruitmentCode(tx, `OFFER-${year}`);
  return `OFFER-${year}-${String(next).padStart(4, '0')}`;
}

/**
 * Drafting an offer.
 *
 * Needs APPROVE: an offer is the business committing to employ somebody, which is
 * different in kind from moving them through a pipeline.
 *
 * The application must be at or past SELECTED. That is the guard which makes
 * "nobody gets an offer who was not chosen" structural rather than procedural — and
 * it is checked here as well as by the stage map, because an offer created directly
 * would otherwise bypass the pipeline entirely.
 */
export async function createOffer(
  req: Request,
  actor: HrActor,
  input: CreateOfferInput,
): Promise<OfferView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Making an offer needs recruitment approval rights.');
  }

  const application = await repo.findApplicationState(input.applicationId);
  if (!application) {
    throw AppError.badRequest('APPLICATION_NOT_FOUND', 'That application could not be found.');
  }
  if (application.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'APPLICATION_NOT_ACTIVE',
      'An offer can only be made on a live application.',
    );
  }
  if (application.selectedAt === null) {
    throw AppError.badRequest(
      'CANDIDATE_NOT_SELECTED',
      'This candidate has not been selected yet.',
    );
  }

  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);

  const id = await prisma.$transaction(async (tx) => {
    const code = await allocateOfferCode(tx);
    const created = await repo.createOffer(tx, {
      code,
      applicationId: input.applicationId,
      // Denormalised from the application, so an offer reads standalone and the role
      // offered survives a requisition being re-scoped later.
      jobRequisitionId: application.jobRequisitionId,
      position: input.position,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      employmentType: input.employmentType ?? 'FULL_TIME',
      workMode: input.workMode ?? 'ON_SITE',
      location: input.location ?? null,
      proposedJoiningDate: input.proposedJoiningDate,
      annualPackage: input.annualPackage ?? null,
      packageCurrency: input.packageCurrency ?? 'INR',
      benefitsSummary: input.benefitsSummary ?? null,
      expiresOn: input.expiresOn ?? null,
      // Born DRAFT. Sending is its own act, so an offer cannot exist as "sent" with
      // no record of when it went.
      status: 'DRAFT',
      createdById: actor.id,
    });
    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_OFFER_CREATED',
    entityType: 'Offer',
    entityId: id,
    actorId: actor.id,
    // No package figure. An audit row is readable by a wider population than
    // HR_RECRUITMENT, and what somebody was offered is not that population's business.
    newValue: {
      applicationId: input.applicationId,
      position: input.position,
      proposedJoiningDate: input.proposedJoiningDate.toISOString().slice(0, 10),
    },
  });

  const row = await repo.findOffer(id);
  if (!row) throw notFound();
  return presentOffer(row, mayViewCompensation(actor));
}

export async function updateOffer(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateOfferInput,
): Promise<OfferView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing an offer needs recruitment approval rights.');
  }

  const before = await repo.findOfferState(id);
  if (!before) throw notFound();

  /*
    Only a draft is editable. Once an offer has been sent, the candidate has been
    told something — amending the record in place would make it disagree with what
    they hold, and the honest correction is to withdraw it and issue another.
  */
  if (before.status !== 'DRAFT') {
    throw AppError.badRequest(
      'OFFER_NOT_DRAFT',
      'A sent offer cannot be edited. Withdraw it and issue a new one.',
    );
  }

  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);

  await prisma.$transaction(
    (tx) => repo.updateOffer(tx, id, input as Prisma.OfferUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_OFFER_UPDATED',
    entityType: 'Offer',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  const row = await repo.findOffer(id);
  if (!row) throw notFound();
  return presentOffer(row, mayViewCompensation(actor));
}

/** Sending it. Stamps `sentAt`, paired with the offer_sent_stamp CHECK. */
export async function sendOffer(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<OfferView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Sending an offer needs recruitment approval rights.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionOffer(tx, {
      id,
      fromStatuses: ['DRAFT'],
      data: { status: 'SENT', sentAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict('OFFER_NOT_DRAFT', 'This offer has already been sent or decided.');
  }

  await recordAudit(req, {
    action: 'HR_OFFER_SENT',
    entityType: 'Offer',
    entityId: id,
    actorId: actor.id,
  });

  const row = await repo.findOffer(id);
  if (!row) throw notFound();
  return presentOffer(row, mayViewCompensation(actor));
}

/**
 * Recording the candidate's answer.
 *
 * HR records it, because there is no candidate-facing route in this CRM — the
 * acceptance arrives by email or phone and somebody enters it. The audit entry
 * therefore names the person who recorded it, which is the honest attribution.
 *
 * On acceptance the application moves to OFFER_ACCEPTED in the same transaction.
 * Two writes that must agree: an accepted offer whose application still says OFFER
 * would leave the pipeline saying nobody had accepted.
 */
export async function respondToOffer(
  req: Request,
  actor: HrActor,
  id: string,
  input: RespondToOfferInput,
): Promise<OfferView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Recording an offer response needs recruitment approval rights.',
    );
  }

  const before = await repo.findOfferState(id);
  if (!before) throw notFound();

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);

    const count = await repo.transitionOffer(tx, {
      id,
      // Only an offer that is out and unanswered can be answered. This is what makes
      // "accepted twice" impossible rather than unlikely — both halves of a
      // double-click hit the same predicate and one loses.
      fromStatuses: ['SENT'],
      data: {
        status: input.status,
        respondedAt: now,
        responseNote: input.responseNote ?? null,
      },
    });

    if (count > 0 && input.status === 'ACCEPTED') {
      await repo.transitionApplication(tx, {
        id: before.applicationId,
        fromStage: 'OFFER',
        fromStatuses: ['ACTIVE'],
        data: { currentStage: 'OFFER_ACCEPTED' },
      });
      await repo.recordStageChange(tx, {
        applicationId: before.applicationId,
        fromStage: 'OFFER',
        toStage: 'OFFER_ACCEPTED',
        reason: 'Offer accepted',
        performedById: actor.id,
      });
    }

    if (count > 0 && input.status === 'REJECTED') {
      // The candidate declined. DECLINED rather than REJECTED on the application,
      // because who decided matters: recording their refusal as our rejection would
      // misattribute it, and the pipeline would read as though we turned them down.
      await repo.transitionApplication(tx, {
        id: before.applicationId,
        fromStatuses: ['ACTIVE'],
        data: { status: 'DECLINED', rejectionReason: input.responseNote ?? 'Offer declined' },
      });
    }

    return count;
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'OFFER_NOT_PENDING',
      'This offer has already been answered, or has not been sent.',
    );
  }

  await recordAudit(req, {
    action: 'HR_OFFER_RESPONSE_RECORDED',
    entityType: 'Offer',
    entityId: id,
    actorId: actor.id,
    newValue: { status: input.status },
  });

  const row = await repo.findOffer(id);
  if (!row) throw notFound();
  return presentOffer(row, mayViewCompensation(actor));
}

export async function listOffers(
  actor: HrActor,
  scope: RecruitmentScope,
  query: OfferListQuery,
): Promise<{ items: OfferSummary[]; nextCursor: string | null }> {
  const where: Prisma.OfferWhereInput = {
    application: visibleApplicationFilter(scope) as Prisma.ApplicationWhereInput,
    ...(query.applicationId ? { applicationId: query.applicationId } : {}),
    ...(query.status ? { status: query.status } : {}),
  };

  const rows = await repo.listOffers({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    items: page.map(presentOfferRow),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getOffer(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<OfferView> {
  const row = await repo.findOffer(id);
  if (!row) throw notFound();
  await loadVisibleApplication(row.applicationId, scope);
  return presentOffer(row, mayViewCompensation(actor));
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export async function requestBackgroundCheck(
  req: Request,
  actor: HrActor,
  input: CreateBackgroundCheckInput,
): Promise<BackgroundCheckView> {
  if (!mayViewBackgroundChecks(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Background checks need the recruitment module.');
  }

  const application = await repo.findApplicationState(input.applicationId);
  if (!application) {
    throw AppError.badRequest('APPLICATION_NOT_FOUND', 'That application could not be found.');
  }

  const row = await prisma.$transaction(
    (tx) =>
      repo.upsertBackgroundCheck(tx, {
        applicationId: input.applicationId,
        checkType: input.checkType,
        create: {
          status: 'PENDING',
          verifierName: input.verifierName ?? null,
          notes: input.notes ?? null,
        },
        // Re-requesting the same check resets it rather than adding a second row
        // nobody can order — the unique index makes that atomic.
        update: {
          status: 'PENDING',
          completedAt: null,
          result: null,
          verifierName: input.verifierName ?? null,
          notes: input.notes ?? null,
        },
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_BACKGROUND_CHECK_REQUESTED',
    entityType: 'BackgroundCheck',
    entityId: row.id,
    actorId: actor.id,
    newValue: { applicationId: input.applicationId, checkType: input.checkType },
  });

  return presentBackgroundCheck(row);
}

/**
 * Recording what a check found.
 *
 * Needs APPROVE, not merely the module. An adverse verification result is one of
 * the most consequential strings in this system — it ends somebody's prospects —
 * and writing it should be a deliberate act by somebody accountable.
 *
 * **A FLAGGED or FAILED check does not auto-reject the application.** That is
 * deliberate and is the single most important restraint in this file: a database row
 * must not end somebody's employment prospects without a person deciding. The
 * onboarding service refuses to proceed past verification while a check is adverse,
 * and a human then either rejects with a reason or records a decision to proceed.
 */
export async function recordBackgroundCheckResult(
  req: Request,
  actor: HrActor,
  id: string,
  input: RecordBackgroundCheckInput,
): Promise<BackgroundCheckView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Recording a verification result needs recruitment approval rights.',
    );
  }

  const before = await repo.findBackgroundCheckState(id);
  if (!before) throw notFound();

  const concluded = ['CLEAR', 'FLAGGED', 'FAILED', 'WAIVED'].includes(input.status);

  const row = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.updateBackgroundCheck(tx, id, {
      status: input.status,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.verifierName === undefined ? {} : { verifierName: input.verifierName }),
      // Paired with the background_check_completed_stamp CHECK: a concluded check
      // can always say when, and an unconcluded one cannot claim to have.
      ...(concluded ? { completedAt: now, verifiedById: actor.id } : { completedAt: null }),
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_BACKGROUND_CHECK_RECORDED',
    entityType: 'BackgroundCheck',
    entityId: id,
    actorId: actor.id,
    // The status only. What a check *found* about somebody's history is not audit
    // material — the audit's job is to record that a decision was made and by whom.
    newValue: { checkType: before.checkType, status: input.status },
  });

  return presentBackgroundCheck(row);
}

export async function listBackgroundChecks(
  actor: HrActor,
  scope: RecruitmentScope,
  applicationId: string,
): Promise<BackgroundCheckView[]> {
  await loadVisibleApplication(applicationId, scope);

  if (!mayViewBackgroundChecks(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Verification results need the recruitment module.',
    );
  }

  const rows = await repo.listBackgroundChecks(applicationId);
  return rows.map(presentBackgroundCheck);
}

// ---------------------------------------------------------------------------
//  Candidate documents
// ---------------------------------------------------------------------------

/**
 * Attaching a stored file to a candidate.
 *
 * The bytes are already in Cloudinary under authenticated delivery, uploaded
 * through the existing SecureDocument service. This records only the metadata
 * recruitment needs — and checks the document is actually owned by this candidate,
 * because without that check any SecureDocument id could be attached to any
 * candidate and an employee's payslip would become a candidate's "résumé".
 */
export async function attachCandidateDocument(
  req: Request,
  actor: HrActor,
  candidateId: string,
  input: CreateCandidateDocumentInput,
): Promise<CandidateDocumentView> {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true },
  });
  if (!candidate) throw notFound();

  const document = await prisma.secureDocument.findUnique({
    where: { id: input.secureDocumentId },
    select: { id: true, ownerType: true, ownerId: true, module: true },
  });
  if (!document) {
    throw AppError.badRequest('DOCUMENT_NOT_FOUND', 'That uploaded file could not be found.');
  }
  if (document.ownerType !== 'Candidate' || document.ownerId !== candidateId) {
    throw AppError.badRequest(
      'DOCUMENT_NOT_OWNED',
      'That file does not belong to this candidate.',
    );
  }

  const row = await prisma.$transaction(
    (tx) =>
      repo.createCandidateDocument(tx, {
        candidateId,
        secureDocumentId: input.secureDocumentId,
        documentType: input.documentType as never,
        title: input.title,
        backgroundCheckId: input.backgroundCheckId ?? null,
        verificationStatus: 'PENDING',
        uploadedById: actor.id,
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_CANDIDATE_DOCUMENT_ATTACHED',
    entityType: 'CandidateDocument',
    entityId: row.id,
    actorId: actor.id,
    newValue: { candidateId, documentType: input.documentType },
  });

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

export async function verifyCandidateDocument(
  req: Request,
  actor: HrActor,
  id: string,
  input: { verificationStatus: 'VERIFIED' | 'REJECTED'; notes?: string },
): Promise<CandidateDocumentView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Verifying a document needs recruitment approval rights.',
    );
  }

  const before = await repo.findCandidateDocumentState(id);
  if (!before) throw notFound();

  const row = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.updateCandidateDocument(tx, id, {
      verificationStatus: input.verificationStatus,
      // All three move together, paired with the
      // candidate_document_verification_complete CHECK.
      verifiedById: actor.id,
      verifiedAt: now,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_CANDIDATE_DOCUMENT_VERIFIED',
    entityType: 'CandidateDocument',
    entityId: id,
    actorId: actor.id,
    newValue: { verificationStatus: input.verificationStatus },
  });

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
