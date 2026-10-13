import { z } from 'zod';
import {
  ONBOARDING_STAGES,
  ONBOARDING_TASK_CATEGORIES,
  ONBOARDING_TASK_STATUSES,
  PROBATION_DECISIONS,
  PROBATION_REVIEW_TYPES,
  PROBATION_STATUSES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 3 — Onboarding & Probation.
 *
 * ### The one contract that matters most
 *
 * `createEmployeeFromOnboardingSchema` takes **no `employeeId`**. The employee
 * number is allocated by `allocateEmployeeId` — Phase 1's atomic counter — inside
 * the creating transaction. Accepting one here would be a second employee-id
 * scheme, and two recruiters onboarding two hires at once would be handed the same
 * number.
 *
 * It also takes no name, email or joining date. All four come from the candidate,
 * the offer and the onboarding record, which already hold them. Re-accepting them
 * would let the employment record disagree with the offer somebody signed.
 *
 * ### What onboarding does NOT do
 *
 * **It does not create a login.** There is no secure invitation flow in this
 * codebase — no token table, no expiry, no first-password journey — and inventing
 * one here would mean inventing a credential-delivery mechanism with no threat
 * model. The ACCOUNT stage therefore surfaces the *existing* employee↔user link
 * operation as a task somebody completes deliberately. Reported as a limitation
 * rather than papered over with a generated password.
 *
 * **It creates no assets, courses or policy records.** ASSETS, TRAINING and
 * POLICIES are task categories, not modules. A laptop owed is a task; an asset
 * register is Phase 5's problem, and a fake one here would have to be migrated
 * away later.
 */

const dateSchema = z.coerce.date();
const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Say why — a decision with no reason cannot be explained later')
  .max(2000);

// ---------------------------------------------------------------------------
//  Onboarding records
// ---------------------------------------------------------------------------

/**
 * Starting an onboarding.
 *
 * Only the application and the agreed start date. Everything else about the hire
 * is already recorded on the accepted offer, and the service reads it from there.
 */
export const createOnboardingSchema = z.object({
  applicationId: cuidSchema,
  /** The agreed start. A calendar day, like every other HR date. */
  joiningDate: dateSchema,
  departmentId: cuidSchema.optional(),
  designationId: cuidSchema.optional(),
  managerId: cuidSchema.optional(),
  notes: z.string().trim().max(4000).optional(),
});

/**
 * Amending an onboarding in flight.
 *
 * `stage` is absent: advancing is its own endpoint, because each stage change
 * writes an audit entry and some of them have preconditions a PATCH could not
 * check. Department, designation and manager legitimately change during
 * onboarding, which is why they are here rather than fixed at offer.
 */
export const updateOnboardingSchema = z
  .object({
    joiningDate: dateSchema.optional(),
    actualJoiningDate: dateSchema.nullable().optional(),
    departmentId: cuidSchema.nullable().optional(),
    designationId: cuidSchema.nullable().optional(),
    managerId: cuidSchema.nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Advancing the checklist.
 *
 * The target stage is validated against `ONBOARDING_STAGES` order and the
 * pre-employee boundary by the service, not by this schema: "you cannot reach
 * ACCOUNT before the employment record exists" is a business rule with a reason,
 * and a Zod enum would state it without explaining it.
 */
export const advanceOnboardingStageSchema = z.object({
  toStage: z.enum(ONBOARDING_STAGES),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * Creating the employment record — the hinge of the whole onboarding.
 *
 * Takes work contact details and nothing else, because those are the only facts
 * not already on the candidate or the offer. No employee number (allocated), no
 * name (candidate's), no joining date (the onboarding record's), no salary
 * (Phase 3 stores no pay), and no login (see the note at the top of this file).
 */
export const createEmployeeFromOnboardingSchema = z.object({
  /*
    Unique on Employee, and the one detail a candidate cannot supply: their
    personal address is how they were reached as a candidate, and their work
    address is issued by the business.
  */
  workEmail: z.string().trim().toLowerCase().email('Enter a valid work email').max(200),
  phone: z.string().trim().max(30).optional(),
  location: z.string().trim().max(200).optional(),
});

export const onboardingListQuerySchema = paginationSchema.extend({
  stage: z.enum(ONBOARDING_STAGES).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
//  Onboarding tasks
// ---------------------------------------------------------------------------

export const createOnboardingTaskSchema = z.object({
  title: z.string().trim().min(2, 'Name the task').max(200),
  category: z.enum(ONBOARDING_TASK_CATEGORIES),
  detail: z.string().trim().max(4000).optional(),
  assigneeId: cuidSchema.optional(),
  dueOn: dateSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const updateOnboardingTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    detail: z.string().trim().max(4000).nullable().optional(),
    assigneeId: cuidSchema.nullable().optional(),
    dueOn: dateSchema.nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Settling a task.
 *
 * A skipped task says why. Deciding not to do something is a decision somebody is
 * accountable for, and the CHECK requires the note just as this does — otherwise
 * "skipped" becomes the quiet way to close a checklist nobody worked through.
 */
export const completeOnboardingTaskSchema = z
  .object({
    status: z.enum(ONBOARDING_TASK_STATUSES),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) => v.status !== 'SKIPPED' || (v.notes !== undefined && v.notes.length >= 5),
    { message: 'Say why this task is being skipped', path: ['notes'] },
  )
  .refine(
    (v) => v.status !== 'BLOCKED' || (v.notes !== undefined && v.notes.length >= 5),
    { message: 'Say what this task is waiting on', path: ['notes'] },
  );

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

/**
 * Starting a probation.
 *
 * The service schedules all four reviews from the start date using
 * `PROBATION_REVIEW_OFFSET_DAYS`, so the schedule is not a thing anybody types.
 */
export const startProbationSchema = z.object({
  employeeId: cuidSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  managerId: cuidSchema.optional(),
}).refine((v) => v.endDate > v.startDate, {
  message: 'Probation has to end after it starts',
  path: ['endDate'],
});

/**
 * Recording a review.
 *
 * A completed review must say something: a rating with no comment is a number
 * somebody is expected to act on with no explanation, and this record is what a
 * confirmation or a termination will later rest on.
 */
export const recordProbationReviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  comments: z
    .string()
    .trim()
    .min(5, 'Say what this review found')
    .max(4000),
  recommendation: z
    .enum(['STRONG_YES', 'YES', 'MAYBE', 'NO', 'STRONG_NO'] as const)
    .optional(),
});

/**
 * The probation decision.
 *
 * An extension needs a new end date; confirming and terminating do not. All three
 * need a reason — this is the record an employment dispute turns on, and "we
 * terminated" with no grounds is indefensible.
 */
export const decideProbationSchema = z
  .object({
    decision: z.enum(PROBATION_DECISIONS),
    reason: reasonSchema,
    /** Required for EXTEND, refused otherwise. */
    newEndDate: dateSchema.optional(),
  })
  .refine((v) => v.decision !== 'EXTEND' || v.newEndDate !== undefined, {
    message: 'An extension needs a new end date',
    path: ['newEndDate'],
  })
  .refine((v) => v.decision === 'EXTEND' || v.newEndDate === undefined, {
    message: 'A new end date applies only to an extension',
    path: ['newEndDate'],
  });

export const probationListQuerySchema = paginationSchema.extend({
  status: z.enum(PROBATION_STATUSES).optional(),
  employeeId: cuidSchema.optional(),
  managerId: cuidSchema.optional(),
  /** Probations ending within the window — what a manager's queue defaults to. */
  endingBefore: dateSchema.optional(),
});

export const probationReviewListQuerySchema = z.object({
  reviewType: z.enum(PROBATION_REVIEW_TYPES).optional(),
});

export const onboardingParamSchema = z.object({ id: cuidSchema });
export const onboardingTaskParamSchema = z.object({ id: cuidSchema });
export const probationParamSchema = z.object({ id: cuidSchema });
export const probationReviewParamSchema = z.object({ id: cuidSchema });

export type CreateOnboardingInput = z.infer<typeof createOnboardingSchema>;
export type UpdateOnboardingInput = z.infer<typeof updateOnboardingSchema>;
export type AdvanceOnboardingStageInput = z.infer<typeof advanceOnboardingStageSchema>;
export type CreateEmployeeFromOnboardingInput = z.infer<
  typeof createEmployeeFromOnboardingSchema
>;
export type OnboardingListQuery = z.infer<typeof onboardingListQuerySchema>;
export type CreateOnboardingTaskInput = z.infer<typeof createOnboardingTaskSchema>;
export type UpdateOnboardingTaskInput = z.infer<typeof updateOnboardingTaskSchema>;
export type CompleteOnboardingTaskInput = z.infer<typeof completeOnboardingTaskSchema>;
export type StartProbationInput = z.infer<typeof startProbationSchema>;
export type RecordProbationReviewInput = z.infer<typeof recordProbationReviewSchema>;
export type DecideProbationInput = z.infer<typeof decideProbationSchema>;
export type ProbationListQuery = z.infer<typeof probationListQuerySchema>;
