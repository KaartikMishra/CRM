/**
 * HR Phase 6 — Payroll & Compensation request validation.
 *
 * ### Negative amounts are rejected at the boundary
 *
 * `amountSchema` from `common.js` accepts `^\d{1,10}(\.\d{1,2})?$` — no leading
 * minus — so no payroll input can carry a negative figure. That is deliberate
 * and it is the first of the two halves of "validate negative or invalid
 * amounts": a salary of -50000 or a component rate of -12% is never a
 * legitimate input and is refused with a 422 before any service sees it.
 *
 * The second half lives in the service, because a *computed* net pay can
 * legitimately come out negative — deductions exceeding earnings is a real
 * condition — and must be detected and reported rather than clamped. See
 * `isNegativeAmount` and the finalisation blocker.
 *
 * ### What is deliberately NOT validated here
 *
 * No schema in this file enforces a statutory rate, threshold or slab. A
 * component rate is validated as "a percentage between 0 and 100", not as "12%,
 * the correct provident fund rate", because this codebase does not know what is
 * correct in any jurisdiction and a validator asserting otherwise would be
 * making a legal claim. See `PAYROLL-SCOPE.md`.
 *
 * ### `.strict()` where an extra key would be dangerous
 *
 * Applied to the approval and finalisation bodies. Those endpoints commit money,
 * and a typo'd field name that silently did nothing is worse there than a 422:
 * the caller believes they sent an instruction that was discarded.
 */

import { z } from 'zod';
import {
  DAILY_RATE_BASES,
  MONETARY_ROUNDING_MODES,
  PAYROLL_ADJUSTMENT_KINDS,
  PAYROLL_PERIOD_STATUSES,
  SALARY_CALCULATION_KINDS,
  SALARY_COMPONENT_KINDS,
} from '../enums.js';
import { amountSchema, cuidSchema, paginationSchema } from './common.js';

/**
 * A percentage, as a decimal string with up to two places.
 *
 * A string rather than a number for the same reason amounts are: 0.75 parsed as
 * a float and re-serialised is not reliably "0.75", and a rate that drifts
 * changes everybody's pay by a rounding error.
 *
 * Capped at 100 because a component taking more than the whole of its base is
 * not a configuration anybody means. Zero is allowed — a component configured at
 * 0% is how a business switches one off for a period without deleting its
 * history.
 */
export const percentRateSchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v), 'Enter a percentage with up to two decimals')
  .refine((v) => Number(v) <= 100, 'A percentage cannot exceed 100')
  .transform((v) => {
    const [whole, fraction = ''] = v.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  });

/**
 * An overtime multiplier, as a decimal string.
 *
 * Allowed above 1 — double time is 2.0 — and capped at 10 as a sanity bound
 * rather than a policy. There is no default: a caller with no configured
 * multiplier must not be valuing overtime at all.
 */
export const multiplierSchema = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value.toFixed(2) : value.trim()))
  .refine((v) => /^\d{1,2}(\.\d{1,2})?$/.test(v), 'Enter a multiplier with up to two decimals')
  .refine((v) => Number(v) > 0 && Number(v) <= 10, 'A multiplier must be above 0 and at most 10')
  .transform((v) => {
    const [whole, fraction = ''] = v.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  });

/** A 3-letter ISO currency code, upper-cased. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code');

/**
 * A component code: stable, upper snake case, used as a map key everywhere.
 *
 * Validated tightly because it appears in snapshots that must stay readable
 * years later, and a code with a space or an accent in it is a code somebody
 * will mistype in a query.
 */
export const componentCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'Use 2-32 characters: letters, digits and underscores');

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

const componentShape = {
  code: componentCodeSchema,
  name: z.string().trim().min(2, 'Name is too short').max(120),
  description: z.string().trim().max(500).optional(),
  kind: z.enum(SALARY_COMPONENT_KINDS),
  calculation: z.enum(SALARY_CALCULATION_KINDS),
  rate: percentRateSchema.optional(),
  capAmount: amountSchema.optional(),
  floorAmount: amountSchema.optional(),
  isBase: z.boolean().default(false),
  prorates: z.boolean().default(true),
  isTaxable: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(999).default(100),
};

/**
 * The cross-field rule that makes a component coherent.
 *
 * A rate-based component without a rate computes nothing; a FIXED component with
 * a rate is carrying a number that will never be read. Both are configuration
 * mistakes that would otherwise surface as a silently wrong payslip, so they are
 * refused here rather than tolerated.
 *
 * `isBase` is restricted to earnings because "12% of a deduction" is not a
 * payroll concept, and allowing it would make the base ambiguous.
 */
const componentRefinement = <T extends z.ZodTypeAny>(schema: T) =>
  schema
    .refine(
      (v: z.infer<T>) =>
        !['PERCENT_OF_BASE', 'PERCENT_OF_GROSS'].includes(v.calculation) || v.rate !== undefined,
      { message: 'A percentage component needs a rate', path: ['rate'] },
    )
    .refine((v: z.infer<T>) => v.calculation !== 'FIXED' || v.rate === undefined, {
      message: 'A fixed component takes its amount from the structure, not a rate',
      path: ['rate'],
    })
    .refine((v: z.infer<T>) => !v.isBase || v.kind === 'EARNING', {
      message: 'Only an earning can be the base for percentage components',
      path: ['isBase'],
    })
    .refine((v: z.infer<T>) => !v.isBase || v.calculation === 'FIXED', {
      message: 'The base component must be a fixed amount, or percentages of it are circular',
      path: ['isBase'],
    });

export const createSalaryComponentSchema = componentRefinement(z.object(componentShape));

export const updateSalaryComponentSchema = componentRefinement(
  z.object({
    ...componentShape,
    code: componentCodeSchema.optional(),
    name: componentShape.name.optional(),
    kind: z.enum(SALARY_COMPONENT_KINDS).optional(),
    calculation: z.enum(SALARY_CALCULATION_KINDS).optional(),
    isActive: z.boolean().optional(),
  }).partial({ isBase: true, prorates: true, isTaxable: true, displayOrder: true }),
);

export const salaryComponentListQuerySchema = z.object({
  kind: z.enum(SALARY_COMPONENT_KINDS).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

export const structureComponentSchema = z.object({
  componentId: cuidSchema,
  amount: amountSchema.optional(),
  rateOverride: percentRateSchema.optional(),
  displayOrder: z.number().int().min(0).max(999).default(100),
});

export const createSalaryStructureSchema = z.object({
  code: componentCodeSchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  currency: currencyCodeSchema.optional(),
  components: z
    .array(structureComponentSchema)
    .min(1, 'A structure needs at least one component')
    .max(40, 'A structure with more than forty components is not one anybody can read')
    .refine(
      (rows) => new Set(rows.map((r) => r.componentId)).size === rows.length,
      'The same component cannot appear twice in one structure',
    ),
});

export const updateSalaryStructureSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
  components: z
    .array(structureComponentSchema)
    .min(1)
    .max(40)
    .refine(
      (rows) => new Set(rows.map((r) => r.componentId)).size === rows.length,
      'The same component cannot appear twice in one structure',
    )
    .optional(),
});

// ---------------------------------------------------------------------------
//  Employee salary assignment
// ---------------------------------------------------------------------------

/**
 * Assigning a salary, effective from a date.
 *
 * There is no update schema for an assignment, and that absence is the design.
 * An assignment is append-only: changing somebody's pay creates a new row with a
 * later `effectiveFrom`, because a historical payslip must remain explicable
 * from the assignment that produced it. An endpoint that edited one in place
 * would silently restate what somebody was paid.
 */
export const assignEmployeeSalarySchema = z.object({
  employeeId: cuidSchema,
  structureId: cuidSchema.optional(),
  monthlyGross: amountSchema,
  currency: currencyCodeSchema.optional(),
  effectiveFrom: z.coerce.date(),
  notes: z.string().trim().max(1000).optional(),
  overrides: z
    .array(
      z.object({
        componentId: cuidSchema,
        amount: amountSchema.optional(),
        rateOverride: percentRateSchema.optional(),
      }),
    )
    .max(40)
    .optional(),
});

export const employeeSalaryQuerySchema = z.object({
  employeeId: cuidSchema.optional(),
  /** Include superseded assignments, which is what makes this a history view. */
  includeHistory: z.coerce.boolean().default(false),
});

// ---------------------------------------------------------------------------
//  Payroll periods
// ---------------------------------------------------------------------------

/**
 * Opening a run for one month.
 *
 * Year and month rather than two free dates, because "the March payroll" is the
 * unit the business works in and a pair of arbitrary dates invites overlapping
 * runs. The service derives `periodStart`/`periodEnd` from them and the unique
 * constraint on `(year, month)` is what makes a duplicate run impossible rather
 * than merely unlikely.
 */
export const createPayrollPeriodSchema = z.object({
  year: z.number().int().min(2000, 'Year is out of range').max(2200),
  month: z.number().int().min(1).max(12),
  name: z.string().trim().min(2).max(120).optional(),
  currency: currencyCodeSchema.optional(),
  /** Overrides the configured defaults for this run only. */
  dailyRateBasis: z.enum(DAILY_RATE_BASES).optional(),
  roundingMode: z.enum(MONETARY_ROUNDING_MODES).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updatePayrollPeriodSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  dailyRateBasis: z.enum(DAILY_RATE_BASES).optional(),
  roundingMode: z.enum(MONETARY_ROUNDING_MODES).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const payrollPeriodListQuerySchema = paginationSchema.extend({
  status: z.enum(PAYROLL_PERIOD_STATUSES).optional(),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
});

/**
 * Running the calculation.
 *
 * Idempotent by design: calling it twice on a CALCULATED period replaces the
 * figures rather than adding to them. `employeeIds` narrows a recalculation to
 * named people, which is what makes fixing one employee's attendance cheap
 * instead of re-costing four hundred.
 */
export const calculatePayrollSchema = z.object({
  employeeIds: z.array(cuidSchema).max(500).optional(),
});

/** Excluding one employee from a run, with a reason that will be read. */
export const excludePayrollItemSchema = z.object({
  note: z.string().trim().min(3, 'Say why, so the employee can be told').max(500),
});

/**
 * Submitting for approval. `.strict()` — this commits a run to a decision.
 */
export const submitPayrollSchema = z
  .object({
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

/**
 * Approving or rejecting. `.strict()` for the same reason.
 *
 * A rejection requires a note. An approval does not: agreement needs no
 * explanation, whereas a run sent back without one leaves the HR team guessing
 * what to change.
 */
export const decidePayrollSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'REJECT' || (v.note?.length ?? 0) >= 3, {
    message: 'Say why it is being sent back',
    path: ['note'],
  });

/**
 * Finalising. `.strict()`, and the most consequential body in the module.
 *
 * `acknowledgeNotStatutory` is required to be true, and it is not
 * box-ticking theatre: this module computes what it is configured to compute and
 * makes no compliance claim, so the person locking a run that will be paid out
 * states that they know that. The service refuses finalisation without it.
 */
export const finalizePayrollSchema = z
  .object({
    acknowledgeNotStatutory: z.literal(true, {
      errorMap: () => ({
        message:
          'Finalising requires acknowledging that statutory calculations are configured, not certified',
      }),
    }),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const cancelPayrollSchema = z.object({
  reason: z.string().trim().min(3, 'Say why the run was abandoned').max(1000),
});

export const payrollItemListQuerySchema = paginationSchema.extend({
  departmentId: cuidSchema.optional(),
  status: z.enum(['PENDING', 'CALCULATED', 'EXCLUDED', 'FINALIZED']).optional(),
  search: z.string().trim().max(120).optional(),
});

// ---------------------------------------------------------------------------
//  Adjustments — the correction path for a finalised period
// ---------------------------------------------------------------------------

/**
 * An arrear, recovery, bonus or reimbursement against a later period.
 *
 * This is the *only* way a finalised figure is corrected. The amount is positive
 * and the `kind` decides its direction, for the same reason a deduction is not a
 * negative earning: a signed amount makes every sum read correctly and every
 * payslip read wrongly.
 */
export const createPayrollAdjustmentSchema = z.object({
  employeeId: cuidSchema,
  kind: z.enum(PAYROLL_ADJUSTMENT_KINDS),
  amount: amountSchema,
  reason: z.string().trim().min(3, 'An adjustment needs a reason').max(1000),
  /** The finalised period being corrected, where this corrects one. */
  correctsPeriodId: cuidSchema.optional(),
  reference: z.string().trim().max(120).optional(),
});

// ---------------------------------------------------------------------------
//  Params and exports
// ---------------------------------------------------------------------------

export const payrollPeriodParamSchema = z.object({ id: cuidSchema });
export const payrollItemParamSchema = z.object({ id: cuidSchema, itemId: cuidSchema });
export const payrollComponentParamSchema = z.object({ id: cuidSchema });
export const payslipParamSchema = z.object({ itemId: cuidSchema });

/**
 * Exporting the payroll register.
 *
 * A separate permission (EXPORT) from reading it, which is why this has its own
 * schema and its own audit entry. Reading one payslip on screen and downloading
 * every salary in the company are different risks, and only the second leaves
 * the building — the comment on the EXPORT action in `enums.ts` says exactly
 * this, and this endpoint is what it was written for.
 */
export const payrollExportQuerySchema = z.object({
  format: z.enum(['CSV']).default('CSV'),
  departmentId: cuidSchema.optional(),
});

export type CreateSalaryComponentInput = z.infer<typeof createSalaryComponentSchema>;
export type UpdateSalaryComponentInput = z.infer<typeof updateSalaryComponentSchema>;
export type SalaryComponentListQuery = z.infer<typeof salaryComponentListQuerySchema>;
export type CreateSalaryStructureInput = z.infer<typeof createSalaryStructureSchema>;
export type UpdateSalaryStructureInput = z.infer<typeof updateSalaryStructureSchema>;
export type AssignEmployeeSalaryInput = z.infer<typeof assignEmployeeSalarySchema>;
export type EmployeeSalaryQuery = z.infer<typeof employeeSalaryQuerySchema>;
export type CreatePayrollPeriodInput = z.infer<typeof createPayrollPeriodSchema>;
export type UpdatePayrollPeriodInput = z.infer<typeof updatePayrollPeriodSchema>;
export type PayrollPeriodListQuery = z.infer<typeof payrollPeriodListQuerySchema>;
export type CalculatePayrollInput = z.infer<typeof calculatePayrollSchema>;
export type ExcludePayrollItemInput = z.infer<typeof excludePayrollItemSchema>;
export type SubmitPayrollInput = z.infer<typeof submitPayrollSchema>;
export type DecidePayrollInput = z.infer<typeof decidePayrollSchema>;
export type FinalizePayrollInput = z.infer<typeof finalizePayrollSchema>;
export type CancelPayrollInput = z.infer<typeof cancelPayrollSchema>;
export type PayrollItemListQuery = z.infer<typeof payrollItemListQuerySchema>;
export type CreatePayrollAdjustmentInput = z.infer<typeof createPayrollAdjustmentSchema>;
export type PayrollExportQuery = z.infer<typeof payrollExportQuerySchema>;
