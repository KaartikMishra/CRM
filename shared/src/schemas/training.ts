import { z } from 'zod';
import {
  ASSESSMENT_QUESTION_KINDS,
  PRACTICAL_SUBMISSION_STATUSES,
  SHADOWING_STATUSES,
  TRAINING_ASSIGNMENT_SOURCES,
  TRAINING_ENROLLMENT_STATUSES,
  TRAINING_MODULE_KINDS,
  TRAINING_OBLIGATIONS,
  TRAINING_PROGRAM_STATUSES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 4 — Training & Learning Management.
 *
 * What these deliberately do NOT accept, and why each omission matters:
 *
 *   - **`status` on any create.** A program is born DRAFT, an enrollment
 *     NOT_STARTED, an attempt IN_PROGRESS. Every move out of those runs through a
 *     named endpoint that writes the audit entry and, where relevant, the
 *     notification. Accepting a status here would let a program be born ACTIVE with
 *     no record of who published it.
 *   - **`code` on a program.** Allocated server-side from an atomic counter. A
 *     client-supplied reference is a duplicate waiting to happen.
 *   - **Any score, percentage or pass flag on an attempt submission.** The learner
 *     sends which options they chose and nothing else. Scoring happens in the
 *     service against the options' own `isCorrect`, and the threshold comes from
 *     the program. A client-supplied score would be a client-supplied
 *     qualification to do live customer work.
 *   - **`isCorrect` on anything a learner can reach.** It exists on the option and
 *     is omitted from the paper-building select. See `types/training.ts`.
 *   - **`qualifiedAt` or any "qualified" flag.** Computed server-side from the
 *     program's requirement flags and the learner's actual progress. There is no
 *     field here that could set it.
 *
 * On the pass mark: `DEFAULT_PASSING_SCORE` (80) is the column default and a UI
 * suggestion. These schemas validate the *range* a stated threshold may take;
 * nothing here or in the services compares a score against the constant. Each
 * program carries its own, and an assessment may override it.
 */

const dateSchema = z.coerce.date();

/**
 * A percentage, to two decimal places.
 *
 * Bounded above 0 rather than at it: a pass mark of 0 means everybody passes, so
 * the assessment records nothing — and it would look configured rather than
 * broken. Paired with the `training_program_passing_score_range` CHECK.
 */
const percentageSchema = z.coerce
  .number()
  .gt(0, 'A pass mark of zero would mean everybody passes')
  .max(100, 'A pass mark above 100 could never be reached');

/**
 * Points a question is worth.
 *
 * Must be positive: a zero-point question cannot affect a score, so it is either a
 * mistake or a comment pretending to be a question.
 */
const pointsSchema = z.coerce
  .number()
  .gt(0, 'A question has to be worth something')
  .max(1000, 'That is not a plausible weighting');

const attemptsSchema = z.coerce
  .number()
  .int()
  .min(1, 'Allow at least one attempt, or the assessment cannot be taken')
  .max(50, 'That is not a retake policy');

const minutesSchema = z.coerce
  .number()
  .int()
  .min(1, 'Use at least a minute')
  .max(100_000, 'That is not a plausible duration');

const sortOrderSchema = z.coerce.number().int().min(0).max(10_000);

const titleSchema = z.string().trim().min(2, 'Give it a title').max(200);
const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Say why — a decision with no reason cannot be explained later')
  .max(2000);

/** A code somebody quotes. Uppercased so two spellings cannot become two rows. */
const codeSchema = z
  .string()
  .trim()
  .min(2, 'A code needs at least two characters')
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/, 'Use letters, digits, hyphens and underscores')
  .transform((v) => v.toUpperCase());

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export const createTrainingCategorySchema = z.object({
  name: titleSchema,
  code: codeSchema,
  description: z.string().trim().max(1000).optional(),
  sortOrder: sortOrderSchema.optional(),
});

/**
 * Amending one.
 *
 * `code` is absent: it is the stable identifier programs are grouped under, and
 * re-coding is a new category plus deactivating the old one — which keeps history
 * honest. The same decision `updateLeaveTypeSchema` makes.
 */
export const updateTrainingCategorySchema = z
  .object({
    name: titleSchema.optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const trainingCategoryListQuerySchema = z.object({
  isActive: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

export const createTrainingProgramSchema = z.object({
  title: titleSchema,
  description: z.string().trim().max(10_000).optional(),
  objectives: z.string().trim().max(10_000).optional(),
  categoryId: cuidSchema.optional(),
  targetDepartmentId: cuidSchema.optional(),
  targetDesignationId: cuidSchema.optional(),
  obligation: z.enum(TRAINING_OBLIGATIONS).optional(),
  estimatedMinutes: minutesSchema.optional(),
  /*
    The qualification policy. Omitted means the column defaults apply — 80 and 3 —
    which is where the business default lives. A program that states its own is
    validated for range only; the services read whatever the program holds.
  */
  passingScore: percentageSchema.optional(),
  maxAttempts: attemptsSchema.optional(),
  requiresPractical: z.boolean().optional(),
  requiresShadowing: z.boolean().optional(),
  requiresFinalAssessment: z.boolean().optional(),
  dueWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  /**
   * Seed the program with the required learning journey.
   *
   * Creates the thirteen `REQUIRED_JOURNEY_TEMPLATE` modules in order, so a new
   * program starts from the business's sequence rather than being built a module
   * at a time. Purely a convenience: the modules are ordinary rows afterwards and
   * can be reordered, removed or added to. No service reads the template again.
   */
  seedRequiredJourney: z.boolean().optional(),
});

/**
 * Amending a program.
 *
 * `status` is absent: publishing and archiving are their own endpoints, because
 * each is a decision carrying a timestamp and an audit entry. A PATCH able to set
 * `status: 'ACTIVE'` would make a program assignable with no record of who did it.
 */
export const updateTrainingProgramSchema = z
  .object({
    title: titleSchema.optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    objectives: z.string().trim().max(10_000).nullable().optional(),
    categoryId: cuidSchema.nullable().optional(),
    targetDepartmentId: cuidSchema.nullable().optional(),
    targetDesignationId: cuidSchema.nullable().optional(),
    obligation: z.enum(TRAINING_OBLIGATIONS).optional(),
    estimatedMinutes: minutesSchema.nullable().optional(),
    passingScore: percentageSchema.optional(),
    maxAttempts: attemptsSchema.optional(),
    requiresPractical: z.boolean().optional(),
    requiresShadowing: z.boolean().optional(),
    requiresFinalAssessment: z.boolean().optional(),
    dueWithinDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const trainingProgramListQuerySchema = paginationSchema.extend({
  status: z.enum(TRAINING_PROGRAM_STATUSES).optional(),
  categoryId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  obligation: z.enum(TRAINING_OBLIGATIONS).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const archiveTrainingProgramSchema = z.object({ reason: reasonSchema });

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

/**
 * One step in a program.
 *
 * `sortOrder` is optional on create — the service appends to the end, which is
 * what somebody building a sequence actually wants. Supplying one inserts at that
 * position, and the unique index refuses a collision rather than silently
 * reordering.
 *
 * A PRACTICAL or SHADOWING module must carry instructions, enforced here and by the
 * `training_module_practical_has_instructions` CHECK: without them the learner is
 * told "complete the practical" and nothing else, and the reviewer has no stated
 * basis for approving it.
 */
export const createTrainingModuleSchema = z
  .object({
    title: titleSchema,
    kind: z.enum(TRAINING_MODULE_KINDS),
    sortOrder: sortOrderSchema.optional(),
    content: z.string().trim().max(50_000).optional(),
    /** A reference link. **Not** video integration — nothing plays or tracks media. */
    referenceUrl: z.string().trim().url('Enter a valid link').max(1000).optional(),
    secureDocumentId: cuidSchema.optional(),
    isRequired: z.boolean().optional(),
    instructions: z.string().trim().max(10_000).optional(),
    estimatedMinutes: minutesSchema.optional(),
  })
  .refine(
    (v) =>
      !['PRACTICAL', 'SHADOWING'].includes(v.kind) ||
      (v.instructions !== undefined && v.instructions.length > 0),
    {
      message: 'A practical or shadowing step has to say what the learner should do',
      path: ['instructions'],
    },
  );

export const updateTrainingModuleSchema = z
  .object({
    title: titleSchema.optional(),
    content: z.string().trim().max(50_000).nullable().optional(),
    referenceUrl: z.string().trim().url().max(1000).nullable().optional(),
    secureDocumentId: cuidSchema.nullable().optional(),
    isRequired: z.boolean().optional(),
    instructions: z.string().trim().max(10_000).nullable().optional(),
    estimatedMinutes: minutesSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Reordering the sequence.
 *
 * The whole ordered list of module ids, not a single move. Sending the list means
 * the server can write consecutive positions in one transaction; a "move item 3 up"
 * API would need to reconcile two rows against a unique index and would fail
 * halfway on a collision.
 */
export const reorderTrainingModulesSchema = z.object({
  moduleIds: z.array(cuidSchema).min(1, 'Send the modules in their new order').max(200),
});

// ---------------------------------------------------------------------------
//  Assignments and enrollments
// ---------------------------------------------------------------------------

/**
 * Assigning a program.
 *
 * Exactly one of `employeeIds`, `departmentId` or `designationId` — a refine rather
 * than three endpoints, because the three differ only in how the eligible set is
 * resolved and the rest of the operation is identical.
 *
 * The resolved set is expanded **once, at assignment time**, and each enrollment
 * records `assignedVia`. An employee who later changes department keeps the
 * enrollment they were given: re-deriving membership would rewrite history, and a
 * course somebody has half-finished must not vanish because they moved team.
 */
export const assignTrainingSchema = z
  .object({
    programId: cuidSchema,
    employeeIds: z.array(cuidSchema).min(1).max(500).optional(),
    departmentId: cuidSchema.optional(),
    designationId: cuidSchema.optional(),
    obligation: z.enum(TRAINING_OBLIGATIONS).optional(),
    /** Overrides the program's `dueWithinDays`. A calendar day, read in IST. */
    dueOn: dateSchema.optional(),
  })
  .refine(
    (v) =>
      [v.employeeIds !== undefined, v.departmentId !== undefined, v.designationId !== undefined]
        .filter(Boolean).length === 1,
    {
      message: 'Assign to specific employees, a department, or a designation — exactly one',
      path: ['employeeIds'],
    },
  );

export const trainingEnrollmentListQuerySchema = paginationSchema.extend({
  programId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  status: z.enum(TRAINING_ENROLLMENT_STATUSES).optional(),
  obligation: z.enum(TRAINING_OBLIGATIONS).optional(),
  assignedVia: z.enum(TRAINING_ASSIGNMENT_SOURCES).optional(),
  /** Only enrollments past their due date and not settled. */
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const updateEnrollmentDueDateSchema = z.object({
  dueOn: dateSchema.nullable(),
  reason: reasonSchema,
});

/** Excusing somebody. The reason is required here, by the service and by a CHECK. */
export const exemptEnrollmentSchema = z.object({ reason: reasonSchema });

/** Withdrawing an assignment that should not have been made. */
export const cancelEnrollmentSchema = z.object({ reason: reasonSchema });

// ---------------------------------------------------------------------------
//  Progress
// ---------------------------------------------------------------------------

/**
 * Marking a lesson done.
 *
 * Only a LESSON module can be completed this way — an ASSESSMENT completes by
 * being passed, a PRACTICAL by being approved, a SHADOWING by being signed off. The
 * service refuses the others, because otherwise a learner could self-certify a
 * practical by calling the lesson endpoint on it.
 *
 * `timeSpentMinutes` is informational and never a gate: a self-reported duration is
 * not evidence of anything.
 */
export const completeModuleSchema = z.object({
  timeSpentMinutes: z.coerce.number().int().min(0).max(100_000).optional(),
});

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export const createTrainingAssessmentSchema = z.object({
  programId: cuidSchema,
  /** Attaching it to a module is what lets that module complete by passing. */
  moduleId: cuidSchema.optional(),
  title: titleSchema,
  instructions: z.string().trim().max(10_000).optional(),
  /** Null/omitted inherits the program's threshold rather than copying it. */
  passingScore: percentageSchema.optional(),
  maxAttempts: attemptsSchema.optional(),
  timeLimitMinutes: minutesSchema.optional(),
  /** The one that gates live-work qualification. One per program. */
  isFinal: z.boolean().optional(),
  shuffleQuestions: z.boolean().optional(),
});

export const updateTrainingAssessmentSchema = z
  .object({
    title: titleSchema.optional(),
    instructions: z.string().trim().max(10_000).nullable().optional(),
    passingScore: percentageSchema.nullable().optional(),
    maxAttempts: attemptsSchema.nullable().optional(),
    timeLimitMinutes: minutesSchema.nullable().optional(),
    shuffleQuestions: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * One question and its options, created together.
 *
 * Together rather than separately, because a question without options is
 * unanswerable and a half-built paper is worse than none. The refines encode what
 * each kind means:
 *
 *   SINGLE_CHOICE   exactly one correct option
 *   TRUE_FALSE      exactly two options, exactly one correct
 *   MULTIPLE_CHOICE at least one correct, and not every option correct — a question
 *                   where everything is right tests nothing
 *
 * These cannot be CHECK constraints: each spans sibling rows, and a row-local
 * constraint cannot count its siblings. So they live here and in the service.
 */
export const createTrainingQuestionSchema = z
  .object({
    kind: z.enum(ASSESSMENT_QUESTION_KINDS),
    prompt: z.string().trim().min(2, 'Ask something').max(5000),
    explanation: z.string().trim().max(5000).optional(),
    points: pointsSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    options: z
      .array(
        z.object({
          label: z.string().trim().min(1, 'Give the option a label').max(1000),
          isCorrect: z.boolean().optional(),
        }),
      )
      .min(2, 'A question needs at least two options')
      .max(10, 'Ten options is already more than anybody reads'),
  })
  .refine(
    (v) => v.options.some((o) => o.isCorrect === true),
    { message: 'Mark at least one option correct', path: ['options'] },
  )
  .refine(
    (v) =>
      v.kind !== 'SINGLE_CHOICE' || v.options.filter((o) => o.isCorrect === true).length === 1,
    { message: 'A single-choice question has exactly one correct option', path: ['options'] },
  )
  .refine(
    (v) => v.kind !== 'TRUE_FALSE' || v.options.length === 2,
    { message: 'A true/false question has exactly two options', path: ['options'] },
  )
  .refine(
    (v) =>
      v.kind !== 'TRUE_FALSE' || v.options.filter((o) => o.isCorrect === true).length === 1,
    { message: 'A true/false question has exactly one correct option', path: ['options'] },
  )
  .refine(
    (v) =>
      v.kind !== 'MULTIPLE_CHOICE' ||
      v.options.filter((o) => o.isCorrect === true).length < v.options.length,
    {
      message: 'If every option is correct the question tests nothing',
      path: ['options'],
    },
  );

export const updateTrainingQuestionSchema = z
  .object({
    prompt: z.string().trim().min(2).max(5000).optional(),
    explanation: z.string().trim().max(5000).nullable().optional(),
    points: pointsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

// ---------------------------------------------------------------------------
//  Attempts
// ---------------------------------------------------------------------------

/**
 * Submitting an attempt.
 *
 * **The most security-sensitive contract in this phase.** It carries only which
 * options the learner selected. There is no `score`, no `percentage`, no `passed`,
 * and no per-question correctness — every one of those is computed server-side from
 * the options' own `isCorrect`, which never leaves the server before submission.
 *
 * A client-supplied score would be a client-supplied clearance to do live customer
 * work, which is why the field does not exist rather than being ignored.
 *
 * `selectedOptionIds` may be empty for a deliberately unanswered question: that is
 * a legitimate answer worth zero, and recording it is more honest than omitting the
 * question and letting the grader guess.
 */
export const submitTrainingAttemptSchema = z
  .object({
    answers: z
      .array(
        z.object({
          questionId: cuidSchema,
          selectedOptionIds: z.array(cuidSchema).max(10),
        }),
      )
      .min(1, 'Answer at least one question')
      .max(500),
  })
  /*
    `.strict()` — the one schema in this phase that refuses unknown keys rather than
    stripping them.

    Zod's default is to drop what it does not recognise, which is already safe here:
    the score is computed server-side from the options' own correctness, so a
    `passed: true` in the body was being discarded and changed nothing.

    But discarding it silently answers 200 to somebody who just tried to forge a
    pass. Rejecting makes the attempt visible — to the caller, and in the request log
    — and that is worth more than tolerance on the single endpoint where a forged
    field would mean a forged clearance to do live customer work.

    Deliberately not applied globally: elsewhere a stray key is a client being
    sloppy, and 422-ing a whole form over it is unkind.
  */
  .strict();

export const trainingAttemptListQuerySchema = paginationSchema.extend({
  enrollmentId: cuidSchema.optional(),
  assessmentId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  passedOnly: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Practical exercises
// ---------------------------------------------------------------------------

export const submitPracticalSchema = z.object({
  submissionNotes: z
    .string()
    .trim()
    .min(5, 'Say what you did')
    .max(10_000),
  secureDocumentId: cuidSchema.optional(),
});

export const assignPracticalReviewerSchema = z.object({ reviewerId: cuidSchema });

/**
 * Reviewing a practical.
 *
 * A rejection must say what to fix — required here and by the
 * `practical_rejection_has_notes` CHECK. "Rejected" with no note is an instruction
 * the learner cannot act on, and they would simply resubmit the same work.
 *
 * The service additionally refuses a learner reviewing their own submission. That
 * cannot be a CHECK: the comparison needs the enrollment's employee, which a
 * row-local constraint cannot reach.
 */
export const reviewPracticalSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED'] as const),
    reviewNotes: z.string().trim().max(10_000).optional(),
  })
  .refine(
    (v) =>
      v.decision === 'APPROVED' ||
      (v.reviewNotes !== undefined && v.reviewNotes.length >= 5),
    { message: 'Say what needs fixing', path: ['reviewNotes'] },
  );

export const practicalListQuerySchema = paginationSchema.extend({
  status: z.enum(PRACTICAL_SUBMISSION_STATUSES).optional(),
  reviewerId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  /** The reviewer's queue: submitted and awaiting a decision. */
  pendingOnly: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Shadowing
// ---------------------------------------------------------------------------

export const scheduleShadowingSchema = z
  .object({
    mentorId: cuidSchema.optional(),
    scheduledFrom: dateSchema.optional(),
    scheduledTo: dateSchema.optional(),
    checklist: z.string().trim().max(10_000).optional(),
  })
  .refine(
    (v) =>
      v.scheduledFrom === undefined ||
      v.scheduledTo === undefined ||
      v.scheduledTo >= v.scheduledFrom,
    { message: 'Shadowing cannot end before it starts', path: ['scheduledTo'] },
  );

/**
 * Signing off a shadowing period.
 *
 * Feedback is required — by this schema and the `shadowing_signoff_has_feedback`
 * CHECK. A sign-off is a gate on live work, so "completed" with nothing observed
 * recorded is an approval nobody can defend.
 */
export const signOffShadowingSchema = z.object({
  feedback: z
    .string()
    .trim()
    .min(5, 'Say what you observed')
    .max(10_000),
});

export const shadowingListQuerySchema = paginationSchema.extend({
  status: z.enum(SHADOWING_STATUSES).optional(),
  mentorId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  pendingOnly: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * Granting live-work qualification.
 *
 * Takes a note and nothing else. Eligibility is computed server-side from the
 * program's requirement flags against the learner's actual progress — there is
 * deliberately no field here for a date, a score or a "qualified" flag, because
 * those are the answer rather than the request.
 *
 * `certificateCode` is absent too: allocated server-side like every other reference
 * in this codebase.
 */
export const grantQualificationSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
  /** Whether to issue a certificate reference alongside the qualification. */
  issueCertificate: z.boolean().optional(),
});

/**
 * Revoking it.
 *
 * The reason is required, and the record is kept rather than deleted: that somebody
 * was cleared for live work and then was not is exactly the history worth having.
 */
export const revokeQualificationSchema = z.object({ reason: reasonSchema });

export const qualificationListQuerySchema = paginationSchema.extend({
  programId: cuidSchema.optional(),
  employeeId: cuidSchema.optional(),
  revoked: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * Linking an onboarding task to a real training enrollment.
 *
 * Phase 3 created a TRAINING task category with no course behind it, deliberately.
 * This is the explicit linking step rather than a guess: the task keeps its own
 * identity, ordering and history, and training progress then drives its status.
 *
 * Either link an existing enrollment, or name a program and let the service create
 * one for the onboarding's employee — which needs the employment record to exist,
 * so the service refuses it before the EMPLOYEE_CREATED stage.
 */
export const linkOnboardingTaskToTrainingSchema = z
  .object({
    enrollmentId: cuidSchema.optional(),
    programId: cuidSchema.optional(),
  })
  .refine(
    (v) => [v.enrollmentId !== undefined, v.programId !== undefined].filter(Boolean).length === 1,
    {
      message: 'Link an existing enrollment, or name a program to assign — exactly one',
      path: ['enrollmentId'],
    },
  );

// ---------------------------------------------------------------------------
//  Path parameters
// ---------------------------------------------------------------------------

/*
  One per resource rather than a shared `{ id }`, following the Phase 1–3
  precedent. They are identical today, which is why they are separate: the route
  table reads `attemptParamSchema` and says what it expects, so a handler wired to
  the wrong path is visible at the call site.
*/
export const trainingCategoryParamSchema = z.object({ id: cuidSchema });
export const trainingProgramParamSchema = z.object({ id: cuidSchema });
export const trainingModuleParamSchema = z.object({ id: cuidSchema });
export const trainingEnrollmentParamSchema = z.object({ id: cuidSchema });
export const trainingAssessmentParamSchema = z.object({ id: cuidSchema });
export const trainingQuestionParamSchema = z.object({ id: cuidSchema });
export const trainingAttemptParamSchema = z.object({ id: cuidSchema });
export const practicalParamSchema = z.object({ id: cuidSchema });
export const shadowingParamSchema = z.object({ id: cuidSchema });
export const qualificationParamSchema = z.object({ id: cuidSchema });
export const onboardingTaskTrainingParamSchema = z.object({ id: cuidSchema });

/** A module within a program, for the nested create and reorder routes. */
export const programModuleParamSchema = z.object({
  id: cuidSchema,
  moduleId: cuidSchema,
});

/** An enrollment's module, for progress and practical/shadowing actions. */
export const enrollmentModuleParamSchema = z.object({
  id: cuidSchema,
  moduleId: cuidSchema,
});

export type CreateTrainingCategoryInput = z.infer<typeof createTrainingCategorySchema>;
export type UpdateTrainingCategoryInput = z.infer<typeof updateTrainingCategorySchema>;
export type CreateTrainingProgramInput = z.infer<typeof createTrainingProgramSchema>;
export type UpdateTrainingProgramInput = z.infer<typeof updateTrainingProgramSchema>;
export type TrainingProgramListQuery = z.infer<typeof trainingProgramListQuerySchema>;
export type CreateTrainingModuleInput = z.infer<typeof createTrainingModuleSchema>;
export type UpdateTrainingModuleInput = z.infer<typeof updateTrainingModuleSchema>;
export type ReorderTrainingModulesInput = z.infer<typeof reorderTrainingModulesSchema>;
export type AssignTrainingInput = z.infer<typeof assignTrainingSchema>;
export type TrainingEnrollmentListQuery = z.infer<typeof trainingEnrollmentListQuerySchema>;
export type UpdateEnrollmentDueDateInput = z.infer<typeof updateEnrollmentDueDateSchema>;
export type CompleteModuleInput = z.infer<typeof completeModuleSchema>;
export type CreateTrainingAssessmentInput = z.infer<typeof createTrainingAssessmentSchema>;
export type UpdateTrainingAssessmentInput = z.infer<typeof updateTrainingAssessmentSchema>;
export type CreateTrainingQuestionInput = z.infer<typeof createTrainingQuestionSchema>;
export type UpdateTrainingQuestionInput = z.infer<typeof updateTrainingQuestionSchema>;
export type SubmitTrainingAttemptInput = z.infer<typeof submitTrainingAttemptSchema>;
export type TrainingAttemptListQuery = z.infer<typeof trainingAttemptListQuerySchema>;
export type SubmitPracticalInput = z.infer<typeof submitPracticalSchema>;
export type ReviewPracticalInput = z.infer<typeof reviewPracticalSchema>;
export type PracticalListQuery = z.infer<typeof practicalListQuerySchema>;
export type ScheduleShadowingInput = z.infer<typeof scheduleShadowingSchema>;
export type SignOffShadowingInput = z.infer<typeof signOffShadowingSchema>;
export type ShadowingListQuery = z.infer<typeof shadowingListQuerySchema>;
export type GrantQualificationInput = z.infer<typeof grantQualificationSchema>;
export type RevokeQualificationInput = z.infer<typeof revokeQualificationSchema>;
export type QualificationListQuery = z.infer<typeof qualificationListQuerySchema>;
export type LinkOnboardingTaskToTrainingInput = z.infer<
  typeof linkOnboardingTaskToTrainingSchema
>;
