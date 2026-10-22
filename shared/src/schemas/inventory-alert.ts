/**
 * Inventory Alerts request validation.
 *
 * Every rule here is also enforced in the database — the threshold CHECK and
 * the partial unique index — so a direct write cannot produce a state the API
 * would have refused.
 */

import { z } from 'zod';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * A threshold: whole units, never negative.
 *
 * Zero is permitted and meaningful — "tell me when this runs out entirely" is a
 * legitimate choice, and `crmStockQty <= 0` is then the rule. A negative would
 * make every variant permanently alerting, so it is refused here and by the
 * `monitored_variant_threshold_non_negative` CHECK.
 *
 * The upper bound matches `crmStockSchema`, so a threshold can always express
 * any stock level the CRM can hold.
 */
export const thresholdSchema = z
  .number({ invalid_type_error: 'Threshold must be a number' })
  .int('Threshold must be a whole number')
  .min(0, 'Threshold cannot be negative')
  .max(10_000_000, 'That threshold looks too large — check the value');

/** Start watching one variant. */
export const createMonitoredVariantSchema = z.object({
  /**
   * `ShopifyVariant.id`, never a SKU. A SKU-keyed request could not say which
   * of three variants sharing `RS2525` was meant.
   */
  variantId: cuidSchema,
  threshold: thresholdSchema,
});

/**
 * Change a configuration.
 *
 * Both fields optional so a threshold edit and an enable/disable are separate
 * actions, but at least one must be present — an empty PATCH is a mistake worth
 * reporting rather than a silent no-op.
 */
export const updateMonitoredVariantSchema = z
  .object({
    threshold: thresholdSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.threshold !== undefined || v.isActive !== undefined, {
    message: 'Provide a threshold or a monitoring state to change',
  });

export const monitoredVariantIdParamSchema = z.object({ id: cuidSchema });

/** The monitored list. Paginated: hundreds of variants may be watched. */
export const listMonitoredVariantsSchema = paginationSchema.extend({
  /** Title or SKU, matching the catalogue's own search. */
  q: z.string().trim().min(1).max(100).optional(),
  /** Narrow to configurations currently holding a live alert. */
  alerting: z.coerce.boolean().optional(),
  /** Include configurations whose variant has gone. Excluded by default. */
  includeArchived: z.coerce.boolean().optional(),
});

/** Alert history. */
export const listInventoryAlertsSchema = paginationSchema.extend({
  status: z.enum(['ACTIVE', 'RESOLVED']).optional(),
  monitoredVariantId: cuidSchema.optional(),
});

/** The add-variant picker: search the catalogue for something to watch. */
export const searchMonitorCandidatesSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
});

export type CreateMonitoredVariantInput = z.infer<typeof createMonitoredVariantSchema>;
export type UpdateMonitoredVariantInput = z.infer<typeof updateMonitoredVariantSchema>;
export type ListMonitoredVariantsQuery = z.infer<typeof listMonitoredVariantsSchema>;
export type ListInventoryAlertsQuery = z.infer<typeof listInventoryAlertsSchema>;
export type SearchMonitorCandidatesQuery = z.infer<typeof searchMonitorCandidatesSchema>;
