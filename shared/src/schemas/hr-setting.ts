import { z } from 'zod';
import { HR_MODULES } from '../enums.js';
import { cuidSchema } from './common.js';

/**
 * Contracts for HR settings.
 *
 * A setting is policy the business owns — working hours, leave quotas, payroll
 * cycles. It is deliberately NOT the place for the contract values in
 * shared/src/constants: those are enforced again by database CHECK constraints,
 * so making them editable at runtime would let somebody set a value the schema
 * still refuses.
 *
 * `updatedById` is not accepted: it comes from the authenticated session, like
 * every other actor field in this codebase.
 */

/**
 * Only HR namespaces, not every AppModule.
 *
 * The column is an AppModule because that is the enum Postgres has, but the
 * contract is narrower than the column on purpose: nothing should be able to
 * file a setting under SALES through this table while Sales keeps its constants
 * in code. Widening this later is additive; narrowing it after rows exist is not.
 */
export const hrSettingModuleSchema = z.enum(HR_MODULES, {
  errorMap: () => ({ message: 'Choose which HR module this setting belongs to' }),
});

/**
 * A dotted key within its module: "working_hours.start", "leave.annual_quota".
 *
 * The pattern is enforced rather than suggested, because a key is an identifier
 * that code will match on. Allowing spaces or capitals would mean
 * "Working Hours" and "working_hours" are two different settings that read as
 * the same one — the unique index cannot save you from that.
 */
export const hrSettingKeySchema = z
  .string()
  .trim()
  .min(1, 'A setting needs a key')
  .max(100, 'Keep the key under 100 characters')
  .regex(
    /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/,
    'Use lowercase words separated by dots, like working_hours.start',
  );

/**
 * The value.
 *
 * A union rather than `z.unknown()`, so the four shapes a setting can actually
 * take are stated and anything else is refused at the edge. `null` is absent
 * deliberately: clearing a setting is deleting its row, not storing an absence
 * that every reader then has to treat as "use the default anyway".
 */
export const hrSettingValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  z.record(z.unknown()),
]);

export const upsertHRSettingSchema = z.object({
  module: hrSettingModuleSchema,
  key: hrSettingKeySchema,
  value: hrSettingValueSchema,
  description: z
    .string()
    .trim()
    .max(500, 'Keep the description under 500 characters')
    .optional(),
});

/** Changing a value in place. The key and module identify it and cannot move. */
export const updateHRSettingSchema = z.object({
  value: hrSettingValueSchema,
  description: z
    .string()
    .trim()
    .max(500, 'Keep the description under 500 characters')
    .optional(),
});

/**
 * Reading them.
 *
 * Not paginated, unlike every list endpoint in the CRM: settings are a bounded
 * set a business configures once, counted in dozens rather than thousands, and a
 * settings screen needs all of them at once to render.
 */
export const hrSettingListQuerySchema = z.object({
  module: hrSettingModuleSchema.optional(),
});

export const hrSettingParamSchema = z.object({ id: cuidSchema });

export type UpsertHRSettingInput = z.infer<typeof upsertHRSettingSchema>;
export type UpdateHRSettingInput = z.infer<typeof updateHRSettingSchema>;
export type HRSettingListQuery = z.infer<typeof hrSettingListQuerySchema>;
