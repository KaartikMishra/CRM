import { z } from 'zod';
import {
  APPLICATION_STAGES,
  APPLICATION_STATUSES,
  ASSESSMENT_STATUSES,
  BACKGROUND_CHECK_STATUSES,
  BACKGROUND_CHECK_TYPES,
  CANDIDATE_SOURCES,
  EMPLOYMENT_TYPES,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_STATUSES,
  INTERVIEW_TYPES,
  JOB_PRIORITIES,
  JOB_REQUISITION_STATUSES,
  OFFER_STATUSES,
  WORK_MODES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 3 — Recruitment / ATS.
 *
 * What these deliberately do NOT accept, and why each omission matters:
 *
 *   - **`status` on any create.** A requisition is born DRAFT, an application
 *     ACTIVE, an offer DRAFT, a check PENDING. Every move out of those runs
 *     through a named endpoint that writes the stage history, the audit entry and
 *     the notification in one transaction. Accepting a status here would let a
 *     requisition be born PUBLISHED with no record of who published it, or an
 *     offer be born ACCEPTED with nobody having accepted it.
 *   - **`currentStage` on apply.** An application starts at APPLICATION. Stage
 *     moves go through the transition map in `utils/ats-pipeline.ts`, which is
 *     what stops a misclick skipping the points where a human commits the
 *     business to something.
 *   - **`code` on requisition or offer.** Allocated server-side. A
 *     client-supplied reference is a duplicate waiting to happen, and both are
 *     quoted in correspondence.
 *   - **`candidateId` on an offer or an interview.** Both hang off the
 *     application, which already names the candidate. Taking it again would let
 *     the two disagree.
 *   - **Any verification result from the candidate's side.** There is no
 *     candidate-facing route in this CRM at all, which is the simplest way to
 *     guarantee that screening notes, interview concerns and flagged checks
 *     cannot reach their subject.
 *
 * Money note: `salaryRangeMin/Max` and `annualPackage` are **informational** —
 * what was advertised and what was communicated. Phase 3 computes nothing from
 * them, and there is no payroll, bank or tax field anywhere in this file.
 */

const dateSchema = z.coerce.date();

/** A business reference somebody quotes: "ENG-2026-004". */
const codeSchema = z
  .string()
  .trim()
  .min(2, 'A code needs at least two characters')
  .max(40, 'Keep the code under 40 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/, 'Use letters, digits, hyphens, slashes and underscores')
  // Uppercased on the way in, so "eng-1" and "ENG-1" cannot become two references
  // that read as one to a human and as two to the unique index.
  .transform((v) => v.toUpperCase());

/**
 * An advertised or communicated figure.
 *
 * A plain bounded number rather than the shared `amountSchema`, which normalises
 * to a canonical decimal *string* for arithmetic. Nothing here is arithmetic: no
 * total is computed, no balance moves. Reusing the money pipeline would imply a
 * precision guarantee this column does not need and a calculation that does not
 * exist.
 */
const packageSchema = z.coerce
  .number()
  .min(0, 'A figure cannot be negative')
  .max(1_000_000_000, 'That is not a plausible figure');

const noteSchema = z.string().trim().min(1).max(4000);
const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Say why — a decision with no reason cannot be explained later')
  .max(2000);

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export const createJobRequisitionSchema = z.object({
  title: z.string().trim().min(2, 'Name the role').max(200),
  departmentId: cuidSchema.optional(),
  designationId: cuidSchema.optional(),
  hiringManagerId: cuidSchema.optional(),
  recruiterId: cuidSchema.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  location: z.string().trim().max(200).optional(),
  openings: z.coerce.number().int().min(1, 'A role hires at least one person').max(1000).optional(),
  description: z.string().trim().max(10_000).optional(),
  requirements: z.string().trim().max(10_000).optional(),
  responsibilities: z.string().trim().max(10_000).optional(),
  salaryRangeMin: packageSchema.optional(),
  salaryRangeMax: packageSchema.optional(),
  salaryCurrency: z.string().trim().length(3).toUpperCase().optional(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  targetJoinDate: dateSchema.optional(),
});

/**
 * Amending a requisition.
 *
 * `status` is absent: publishing, pausing and closing are their own endpoints
 * because each is a decision with a timestamp and an audit entry. A PATCH that
 * could set `status: 'PUBLISHED'` would publish a role with no record of who did.
 */
export const updateJobRequisitionSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    departmentId: cuidSchema.nullable().optional(),
    designationId: cuidSchema.nullable().optional(),
    hiringManagerId: cuidSchema.nullable().optional(),
    recruiterId: cuidSchema.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    workMode: z.enum(WORK_MODES).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    openings: z.coerce.number().int().min(1).max(1000).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    requirements: z.string().trim().max(10_000).nullable().optional(),
    responsibilities: z.string().trim().max(10_000).nullable().optional(),
    salaryRangeMin: packageSchema.nullable().optional(),
    salaryRangeMax: packageSchema.nullable().optional(),
    salaryCurrency: z.string().trim().length(3).toUpperCase().optional(),
    priority: z.enum(JOB_PRIORITIES).optional(),
    targetJoinDate: dateSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const jobRequisitionListQuerySchema = paginationSchema.extend({
  status: z.enum(JOB_REQUISITION_STATUSES).optional(),
  priority: z.enum(JOB_PRIORITIES).optional(),
  departmentId: cuidSchema.optional(),
  recruiterId: cuidSchema.optional(),
  hiringManagerId: cuidSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

/** Closing a role says why — filled, abandoned or re-scoped are different facts. */
export const closeJobRequisitionSchema = z.object({ reason: reasonSchema });

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export const createCandidateSchema = z.object({
  firstName: z.string().trim().min(1, 'A first name is needed').max(100),
  lastName: z.string().trim().min(1, 'A last name is needed').max(100),
  /*
    Lower-cased on the way in, which is what makes the unique index a real
    duplicate guard rather than a case-sensitive one: without this, A@x.com and
    a@x.com are two candidates and the same person applies twice.
  */
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  phone: z.string().trim().max(30).optional(),
  location: z.string().trim().max(200).optional(),
  source: z.enum(CANDIDATE_SOURCES).optional(),
  sourceDetail: z.string().trim().max(200).optional(),
  totalExperienceYears: z.coerce.number().min(0).max(70).optional(),
  currentEmployer: z.string().trim().max(200).optional(),
  currentDesignation: z.string().trim().max(200).optional(),
  skills: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  notes: z.string().trim().max(4000).optional(),
});

/**
 * Amending a candidate.
 *
 * `email` is absent. It is the identity key — the unique column that makes one
 * person one candidate across several applications — and changing it would either
 * merge two people or split one. A genuine correction is an HR operation with its
 * own audit trail, not a field on a form.
 */
export const updateCandidateSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    source: z.enum(CANDIDATE_SOURCES).optional(),
    sourceDetail: z.string().trim().max(200).nullable().optional(),
    totalExperienceYears: z.coerce.number().min(0).max(70).nullable().optional(),
    currentEmployer: z.string().trim().max(200).nullable().optional(),
    currentDesignation: z.string().trim().max(200).nullable().optional(),
    skills: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const candidateListQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  source: z.enum(CANDIDATE_SOURCES).optional(),
  isActive: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

/**
 * A candidate pursuing a role.
 *
 * Both ids are required and nothing else about the pairing is: the recruiter and
 * hiring manager default from the requisition, which is the whole reason they are
 * stored on it.
 */
export const createApplicationSchema = z.object({
  candidateId: cuidSchema,
  jobRequisitionId: cuidSchema,
  source: z.enum(CANDIDATE_SOURCES).optional(),
  notes: z.string().trim().max(4000).optional(),
});

/** Screening — a judgement about this application, not about the candidate. */
export const screenApplicationSchema = z.object({
  screeningScore: z.coerce.number().int().min(0).max(100).optional(),
  screeningNotes: z.string().trim().max(4000).optional(),
});

/**
 * Moving an application through the pipeline.
 *
 * The target stage is checked against the transition map, not against this
 * schema: whether SHORTLISTED may become OFFER is a business rule with reasons,
 * and burying it in a Zod enum would hide them.
 */
export const moveApplicationStageSchema = z.object({
  toStage: z.enum(APPLICATION_STAGES),
  reason: z.string().trim().max(2000).optional(),
});

/** Rejecting. The reason is required here, by the API, and by a CHECK. */
export const rejectApplicationSchema = z.object({ reason: reasonSchema });

/** Withdrawing on the candidate's behalf — recorded as their decision, not ours. */
export const withdrawApplicationSchema = z.object({ reason: reasonSchema });

export const applicationListQuerySchema = paginationSchema.extend({
  jobRequisitionId: cuidSchema.optional(),
  candidateId: cuidSchema.optional(),
  stage: z.enum(APPLICATION_STAGES).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  recruiterId: cuidSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export const scheduleInterviewSchema = z.object({
  applicationId: cuidSchema,
  interviewType: z.enum(INTERVIEW_TYPES),
  round: z.coerce.number().int().min(1).max(20).optional(),
  /*
    A real moment, not a calendar day — an interview happens at a time, and
    "Tuesday" is not something anybody can attend. The client sends an instant
    with an explicit offset; the server stores it as given. This is a *future*
    appointment rather than a record of something that happened, which is why a
    client-supplied time is legitimate here and never is for attendance.
  */
  scheduledAt: dateSchema,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  location: z.string().trim().max(300).optional(),
  meetingUrl: z.string().trim().url('Enter a valid meeting link').max(1000).optional(),
  interviewerId: cuidSchema.optional(),
  /** Everybody else attending. Each becomes a participant row so they can be reached. */
  participantIds: z.array(cuidSchema).max(20).optional(),
});

export const rescheduleInterviewSchema = z.object({
  scheduledAt: dateSchema,
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  meetingUrl: z.string().trim().url().max(1000).nullable().optional(),
  reason: reasonSchema,
});

/** Cancelling or marking a no-show. Both say why; both are facts about somebody. */
export const closeInterviewSchema = z.object({
  status: z.enum(['CANCELLED', 'NO_SHOW'] as const),
  reason: reasonSchema,
});

/**
 * One interviewer's view.
 *
 * `recommendation` is required and `rating` optional, which is deliberate: a
 * number with no position is not feedback, while a clear "no" with no score is.
 */
export const submitInterviewFeedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS),
  strengths: z.string().trim().max(4000).optional(),
  concerns: z.string().trim().max(4000).optional(),
  notes: z.string().trim().max(4000).optional(),
});

export const interviewListQuerySchema = paginationSchema.extend({
  applicationId: cuidSchema.optional(),
  interviewerId: cuidSchema.optional(),
  status: z.enum(INTERVIEW_STATUSES).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export const createAssessmentSchema = z.object({
  applicationId: cuidSchema,
  /** Free text: the set of exercises a business uses is its own. */
  assessmentType: z.string().trim().min(2).max(100),
  title: z.string().trim().min(2).max(200),
  dueAt: dateSchema.optional(),
  maxScore: z.coerce.number().min(0.01).max(10_000).optional(),
});

/**
 * Recording a result.
 *
 * A score needs a maximum to be read against — enforced here and by a CHECK.
 * `status` is accepted because PASSED versus FAILED is a reviewer's judgement
 * that no score threshold in this phase can make for them.
 */
export const recordAssessmentResultSchema = z
  .object({
    score: z.coerce.number().min(0).max(10_000).optional(),
    maxScore: z.coerce.number().min(0.01).max(10_000).optional(),
    status: z.enum(ASSESSMENT_STATUSES),
    notes: z.string().trim().max(4000).optional(),
  })
  .refine(
    (v) => v.score === undefined || v.maxScore === undefined || v.score <= v.maxScore,
    { message: 'A score cannot exceed its maximum', path: ['score'] },
  );

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export const createOfferSchema = z
  .object({
    applicationId: cuidSchema,
    position: z.string().trim().min(2, 'Name the position').max(200),
    departmentId: cuidSchema.optional(),
    designationId: cuidSchema.optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    workMode: z.enum(WORK_MODES).optional(),
    location: z.string().trim().max(200).optional(),
    proposedJoiningDate: dateSchema,
    annualPackage: packageSchema.optional(),
    packageCurrency: z.string().trim().length(3).toUpperCase().optional(),
    benefitsSummary: z.string().trim().max(4000).optional(),
    expiresOn: dateSchema.optional(),
  })
  .refine(
    (v) => v.expiresOn === undefined || v.expiresOn <= v.proposedJoiningDate,
    {
      message: 'An offer cannot expire after the day it is meant to start',
      path: ['expiresOn'],
    },
  );

/** Amending a draft. Once sent, an offer is revised by issuing another. */
export const updateOfferSchema = z
  .object({
    position: z.string().trim().min(2).max(200).optional(),
    departmentId: cuidSchema.nullable().optional(),
    designationId: cuidSchema.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    workMode: z.enum(WORK_MODES).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    proposedJoiningDate: dateSchema.optional(),
    annualPackage: packageSchema.nullable().optional(),
    packageCurrency: z.string().trim().length(3).toUpperCase().optional(),
    benefitsSummary: z.string().trim().max(4000).nullable().optional(),
    expiresOn: dateSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Recording the candidate's answer.
 *
 * HR records it, because there is no candidate-facing route — the acceptance
 * arrives by email or phone and somebody enters it. That makes the audit entry
 * name the person who recorded it, which is the honest attribution.
 */
export const respondToOfferSchema = z
  .object({
    status: z.enum(['ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const),
    responseNote: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) => v.status === 'ACCEPTED' || (v.responseNote !== undefined && v.responseNote.length >= 5),
    { message: 'Say why the offer was declined or withdrawn', path: ['responseNote'] },
  );

export const offerListQuerySchema = paginationSchema.extend({
  applicationId: cuidSchema.optional(),
  status: z.enum(OFFER_STATUSES).optional(),
});

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export const createBackgroundCheckSchema = z.object({
  applicationId: cuidSchema,
  checkType: z.enum(BACKGROUND_CHECK_TYPES),
  verifierName: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(4000).optional(),
});

/**
 * Recording what a check found.
 *
 * An adverse result must say what was found, and a waiver must say why it was
 * waived. Both are enforced here and by a CHECK, because "failed" with no
 * evidence is an accusation nobody can answer, and this is somebody's livelihood.
 */
export const recordBackgroundCheckSchema = z
  .object({
    status: z.enum(BACKGROUND_CHECK_STATUSES),
    result: z.string().trim().max(4000).optional(),
    notes: z.string().trim().max(4000).optional(),
    verifierName: z.string().trim().max(200).optional(),
  })
  .refine(
    (v) =>
      !['FLAGGED', 'FAILED'].includes(v.status) ||
      (v.result !== undefined && v.result.length > 0),
    { message: 'Say what the check found', path: ['result'] },
  )
  .refine(
    (v) => v.status !== 'WAIVED' || (v.notes !== undefined && v.notes.length > 0),
    { message: 'Say why this check is being waived', path: ['notes'] },
  );

// ---------------------------------------------------------------------------
//  Candidate documents
// ---------------------------------------------------------------------------

/**
 * Metadata for an uploaded candidate file.
 *
 * The bytes go through the existing SecureDocument service — authenticated
 * delivery, no stored URL, short-lived signed links. This records only what
 * recruitment needs to find it again.
 */
export const createCandidateDocumentSchema = z.object({
  secureDocumentId: cuidSchema,
  documentType: z.string().trim().min(2).max(60),
  title: z.string().trim().min(2).max(200),
  backgroundCheckId: cuidSchema.optional(),
});

export const verifyCandidateDocumentSchema = z.object({
  verificationStatus: z.enum(['VERIFIED', 'REJECTED'] as const),
  notes: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------------------
//  Path parameters
// ---------------------------------------------------------------------------

/*
  One schema per resource rather than a shared `{ id }`, following the Phase 1
  precedent. They are identical today, which is exactly why they are separate: the
  route table reads `interviewParamSchema` and says what it expects, so a handler
  wired to the wrong path is visible at the call site rather than silently accepting
  any cuid.
*/
export const jobParamSchema = z.object({ id: cuidSchema });
export const candidateParamSchema = z.object({ id: cuidSchema });
export const applicationParamSchema = z.object({ id: cuidSchema });
export const interviewParamSchema = z.object({ id: cuidSchema });
export const assessmentParamSchema = z.object({ id: cuidSchema });
export const offerParamSchema = z.object({ id: cuidSchema });
export const backgroundCheckParamSchema = z.object({ id: cuidSchema });
export const candidateDocumentParamSchema = z.object({ id: cuidSchema });

export type CreateJobRequisitionInput = z.infer<typeof createJobRequisitionSchema>;
export type UpdateJobRequisitionInput = z.infer<typeof updateJobRequisitionSchema>;
export type JobRequisitionListQuery = z.infer<typeof jobRequisitionListQuerySchema>;
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;
export type CandidateListQuery = z.infer<typeof candidateListQuerySchema>;
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type ScreenApplicationInput = z.infer<typeof screenApplicationSchema>;
export type MoveApplicationStageInput = z.infer<typeof moveApplicationStageSchema>;
export type ApplicationListQuery = z.infer<typeof applicationListQuerySchema>;
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;
export type RescheduleInterviewInput = z.infer<typeof rescheduleInterviewSchema>;
export type SubmitInterviewFeedbackInput = z.infer<typeof submitInterviewFeedbackSchema>;
export type InterviewListQuery = z.infer<typeof interviewListQuerySchema>;
export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;
export type RecordAssessmentResultInput = z.infer<typeof recordAssessmentResultSchema>;
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;
export type RespondToOfferInput = z.infer<typeof respondToOfferSchema>;
export type OfferListQuery = z.infer<typeof offerListQuerySchema>;
export type CreateBackgroundCheckInput = z.infer<typeof createBackgroundCheckSchema>;
export type RecordBackgroundCheckInput = z.infer<typeof recordBackgroundCheckSchema>;
export type CreateCandidateDocumentInput = z.infer<typeof createCandidateDocumentSchema>;
