import { z } from 'zod';
import { PRODUCT_MATCH_TYPES } from '../enums.js';
import { amountSchema, cuidSchema, dimensionSchema, weightSchema } from './common.js';

/**
 * §31–39 — one vendor's answer for one enquiry product.
 * Several of these can exist per line; that is the point of the module.
 */
export const createVendorResponseSchema = z.object({
  vendorId: cuidSchema,
  /** §32 — kept separate from the customer's own product image. */
  imageAssetId: cuidSchema.optional(),
  /** §38 — an exact match for the requested product, or an alternative. */
  matchType: z.enum(PRODUCT_MATCH_TYPES, {
    errorMap: () => ({ message: 'Choose Exact Product or Similar Product' }),
  }),
  /** Q8 — per unit. The line total is derived, never stored. */
  ratePerUnit: amountSchema,
  currency: z.string().length(3).default('INR'),
  /** §36 — structured days rather than free text. */
  deliveryWithinDays: z
    .number({ invalid_type_error: 'Delivery time must be a number of days' })
    .int('Use whole days')
    .positive('Delivery time must be at least 1 day')
    .max(365, 'Delivery time looks too long — check the value'),
  /**
   * The vendor can deliver on the day of order.
   *
   * Optional, so a response that does not mention it is recorded as "not
   * stated" rather than an explicit no — and so existing rows stay valid.
   */
  sameDay: z.boolean().optional(),
  deliveryNote: z.string().trim().max(300).optional(),
  weight: weightSchema.optional(),
  dimension: dimensionSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateVendorResponseSchema = createVendorResponseSchema.partial();

export type CreateVendorResponseInput = z.infer<typeof createVendorResponseSchema>;
export type UpdateVendorResponseInput = z.infer<typeof updateVendorResponseSchema>;
