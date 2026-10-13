import { z } from 'zod';
import {
  DOCUMENT_VERIFICATION_STATUSES,
  EMPLOYEE_DOCUMENT_TYPES,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  ORG_UNIT_STATUSES,
  WORK_MODES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 1 — Employee & Organization.
 *
 * What these deliberately do NOT accept, in every case because the server is the
 * only thing entitled to decide it:
 *
 *   - **`employeeId`.** Allocated from an atomic counter inside the creating
 *     transaction. A client-supplied id would collide, and the whole point of the
 *     counter is that two simultaneous creates cannot receive the same number.
 *   - **`userId` on create.** Linking an account is its own operation with its own
 *     validation and its own history entry. Accepting it here would make "create
 *     an employee" and "give somebody a login" one indivisible action.
 *   - **`status` on create.** A new employee starts PROBATION or ACTIVE by the
 *     service's rule; moving between states goes through the status endpoint,
 *     which writes history. Accepting it here would let somebody be born EXITED.
 *   - **`exitDate`.** Stamped when the status actually reaches EXITED, so the date
 *     and the status cannot disagree. A CHECK enforces the pairing again.
 *   - **Verification fields.** `verifiedById`/`verifiedAt` come from the acting
 *     session, never from a caller claiming somebody else checked a document.
 *
 * Also absent, and worth stating: no date of birth, gender, home address or
 * emergency contact. Each needs a stated purpose, a retention rule and a narrower
 * read scope than "anybody with HR_EMPLOYEE:VIEW". Collecting them before those
 * rules exist would be the easy thing and the wrong one.
 */

// ---------------------------------------------------------------------------
//  Shared field rules
// ---------------------------------------------------------------------------

/**
 * An organizational code — "ENG", "SALES-APAC".
 *
 * Uppercased on the way in rather than merely validated, so "eng" and "ENG" cannot
 * become two departments that read as one. The unique index sees two different
 * strings; a human sees the same code.
 */
export const orgCodeSchema = z
  .string()
  .trim()
  .min(2, 'A code needs at least two characters')
  .max(20, 'Keep the code under 20 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphens and underscores only')
  .transform((value) => value.toUpperCase());

const orgNameSchema = z
  .string()
  .trim()
  .min(2, 'A name is required')
  .max(120, 'Keep the name under 120 characters');

const descriptionSchema = z
  .string()
  .trim()
  .max(500, 'Keep the description under 500 characters')
  .optional();

/** A person's name part. Permissive on script, strict on length and emptiness. */
const personNameSchema = z
  .string()
  .trim()
  .min(1, 'This name is required')
  .max(80, 'Keep each name under 80 characters');

/**
 * A date with no time component that matters.
 *
 * Coerced, so an ISO string from a form and a Date from a test both work. Joining
 * dates are allowed in the future — an accepted offer with a start date next month
 * is an ordinary thing to record.
 */
const hrDateSchema = z.coerce.date();

/**
 * Indian mobile or landline, or an international number.
 *
 * Deliberately loose: the business hires people whose numbers this codebase cannot
 * anticipate, and a strict pattern would reject real colleagues. Length and
 * character class are the real protection.
 */
const phoneSchema = z
  .string()
  .trim()
  .min(6, 'That phone number looks too short')
  .max(20, 'That phone number looks too long')
  .regex(/^[+]?[0-9 ()-]+$/, 'Use digits, spaces, brackets, hyphens and an optional +');

// ---------------------------------------------------------------------------
//  Department
// ---------------------------------------------------------------------------

export const createDepartmentSchema = z.object({
  name: orgNameSchema,
  code: orgCodeSchema,
  description: descriptionSchema,
  /** The department this one sits inside. A cycle is refused by the service. */
  parentId: cuidSchema.optional(),
  /** The employee who heads it. Validated to exist and to be employed. */
  headId: cuidSchema.optional(),
});

/**
 * Amending one.
 *
 * `code` is absent on purpose: it is the stable business identifier that people
 * quote and that other records are reconciled against. Renaming is `name`;
 * re-coding is creating a new department and archiving the old one, which keeps
 * history honest.
 */
export const updateDepartmentSchema = z
  .object({
    name: orgNameSchema.optional(),
    description: descriptionSchema,
    status: z.enum(ORG_UNIT_STATUSES).optional(),
    /** Null clears the parent, lifting the department to the top level. */
    parentId: cuidSchema.nullable().optional(),
    headId: cuidSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field');

export const departmentListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORG_UNIT_STATUSES).optional(),
  parentId: cuidSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Designation
// ---------------------------------------------------------------------------

export const createDesignationSchema = z.object({
  name: orgNameSchema,
  code: orgCodeSchema,
  description: descriptionSchema,
  departmentId: cuidSchema.optional(),
  /**
   * Seniority, for ordering a list and nothing else — explicitly not an authority
   * model. Reporting lines are `managerId`; access is the existing RBAC.
   */
  level: z.coerce.number().int().min(0, 'Level cannot be negative').max(100).optional(),
});

export const updateDesignationSchema = z
  .object({
    name: orgNameSchema.optional(),
    description: descriptionSchema,
    status: z.enum(ORG_UNIT_STATUSES).optional(),
    departmentId: cuidSchema.nullable().optional(),
    level: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field');

export const designationListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORG_UNIT_STATUSES).optional(),
  departmentId: cuidSchema.optional(),
});

// ---------------------------------------------------------------------------
//  Employee
// ---------------------------------------------------------------------------

export const createEmployeeSchema = z.object({
  firstName: personNameSchema,
  middleName: personNameSchema.optional(),
  lastName: personNameSchema,

  workEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid work email')
    .max(160, 'That email is too long'),
  phone: phoneSchema.optional(),

  departmentId: cuidSchema.optional(),
  designationId: cuidSchema.optional(),
  /** Self-reference is impossible here — the employee does not exist yet. */
  managerId: cuidSchema.optional(),

  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  location: z.string().trim().max(120).optional(),

  joiningDate: hrDateSchema,
});

export const updateEmployeeSchema = z
  .object({
    firstName: personNameSchema.optional(),
    /** Null clears it — plenty of people have no middle name. */
    middleName: personNameSchema.nullable().optional(),
    lastName: personNameSchema.optional(),
    workEmail: z.string().trim().toLowerCase().email('Enter a valid work email').max(160).optional(),
    phone: phoneSchema.nullable().optional(),
    departmentId: cuidSchema.nullable().optional(),
    designationId: cuidSchema.nullable().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    workMode: z.enum(WORK_MODES).optional(),
    location: z.string().trim().max(120).nullable().optional(),
    joiningDate: hrDateSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field');

/**
 * Moving somebody's reporting line.
 *
 * Its own endpoint rather than a field on update, because it is the one employee
 * change that can corrupt the structure: a cycle makes the hierarchy unwalkable,
 * and the check needs the whole ancestor chain rather than one row. Separating it
 * also means the history entry and the manager's notification have one obvious
 * place to live.
 *
 * `managerId: null` removes the reporting line — correct for a chief executive.
 */
export const assignManagerSchema = z.object({
  managerId: cuidSchema.nullable(),
  note: z.string().trim().max(500).optional(),
});

/**
 * Changing employment status.
 *
 * `exitDate` is accepted only here, and only because EXITED requires one: the
 * service refuses EXITED without it and ignores it otherwise, so the stored date
 * can never contradict the stored status.
 */
export const changeEmployeeStatusSchema = z
  .object({
    status: z.enum(EMPLOYEE_STATUSES),
    exitDate: hrDateSchema.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.status !== 'EXITED' || value.exitDate !== undefined, {
    message: 'An employee who has left needs a last working day',
    path: ['exitDate'],
  });

/** Tying a CRM account to an HR record. Both sides are validated server-side. */
export const linkEmployeeUserSchema = z.object({
  userId: cuidSchema,
  note: z.string().trim().max(500).optional(),
});

export const unlinkEmployeeUserSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

/**
 * The directory's filters.
 *
 * `managerId` doubles as the "my team" view, which is why no separate scope
 * parameter exists: a manager asking for their own reports is the same query an
 * HR administrator makes about somebody else's.
 */
export const employeeListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  departmentId: cuidSchema.optional(),
  designationId: cuidSchema.optional(),
  managerId: cuidSchema.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  /** Narrow to people currently employed — PROBATION, ACTIVE or ON_NOTICE. */
  employedOnly: z.coerce.boolean().optional(),
  sort: z.enum(['name', 'joiningDate', 'employeeId']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

// ---------------------------------------------------------------------------
//  Employee documents
// ---------------------------------------------------------------------------

/**
 * Recording an already-stored confidential file against an employee.
 *
 * `secureDocumentId` refers to a SecureDocument the Phase 0.5 service created.
 * There is no file content here and no URL of any kind: the bytes went through
 * that service, which stores them as authenticated Cloudinary objects and mints
 * short-lived signed links per request. This table is metadata only.
 */
export const createEmployeeDocumentSchema = z.object({
  secureDocumentId: cuidSchema,
  documentType: z.enum(EMPLOYEE_DOCUMENT_TYPES),
  title: z.string().trim().min(2, 'Give the document a title').max(160),
  issuedOn: hrDateSchema.optional(),
  /** Null means "does not expire", which is different from "unknown". */
  expiresOn: hrDateSchema.optional(),
});

export const verifyEmployeeDocumentSchema = z.object({
  verificationStatus: z.enum(DOCUMENT_VERIFICATION_STATUSES),
  note: z.string().trim().max(500).optional(),
});

export const employeeParamSchema = z.object({ id: cuidSchema });
export const departmentParamSchema = z.object({ id: cuidSchema });
export const designationParamSchema = z.object({ id: cuidSchema });
export const employeeDocumentParamSchema = z.object({
  id: cuidSchema,
  documentId: cuidSchema,
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type DepartmentListQuery = z.infer<typeof departmentListQuerySchema>;
export type CreateDesignationInput = z.infer<typeof createDesignationSchema>;
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>;
export type DesignationListQuery = z.infer<typeof designationListQuerySchema>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type AssignManagerInput = z.infer<typeof assignManagerSchema>;
export type ChangeEmployeeStatusInput = z.infer<typeof changeEmployeeStatusSchema>;
export type LinkEmployeeUserInput = z.infer<typeof linkEmployeeUserSchema>;
export type UnlinkEmployeeUserInput = z.infer<typeof unlinkEmployeeUserSchema>;
export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;
export type CreateEmployeeDocumentInput = z.infer<typeof createEmployeeDocumentSchema>;
export type VerifyEmployeeDocumentInput = z.infer<typeof verifyEmployeeDocumentSchema>;
