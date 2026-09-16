import { z } from 'zod';
import { amountSchema, cuidSchema } from './common.js';

/**
 * The Vendor Invoices contract.
 *
 * Two things are kept firmly apart here, because conflating them would rewrite
 * history:
 *
 *   - a **mapping rate** is what a vendor charges *today*. It changes whenever
 *     a price is renegotiated.
 *   - a **purchase rate** is what a specific bill actually charged. It is a
 *     fact about a document somebody was handed, and nothing in this module
 *     may alter it.
 *
 * Only the first appears in these input schemas. Trade history is read from
 * existing PurchaseBill and PurchaseBillItem records and has no write path.
 */

// ---------------------------------------------------------------------------
//  Vendors
// ---------------------------------------------------------------------------

export const vendorListQuerySchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Matches name, company, phone or email — how staff actually look a vendor up. */
  q: z.string().trim().max(200).optional(),
  /** Absent means every vendor, archived included. */
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const vendorIdParamSchema = z.object({ id: cuidSchema });

// ---------------------------------------------------------------------------
//  Trade history
// ---------------------------------------------------------------------------

/**
 * One vendor's purchase history.
 *
 * Read-only by construction: there is no corresponding create or update schema,
 * because the history is the purchase records themselves.
 */
export const vendorTradeQuerySchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Matches the product name as the vendor's own bill spelled it. */
  q: z.string().trim().max(200).optional(),
  /** Bill date range, inclusive. Absent means no bound. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
//  Vendor ↔ product mapping
// ---------------------------------------------------------------------------

export const mappingListQuerySchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Matches the product title. */
  q: z.string().trim().max(200).optional(),
  vendorId: cuidSchema.optional(),
  rsProductId: cuidSchema.optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/**
 * Mapping a product to a vendor.
 *
 * `rsProductId` deliberately, not `productId`: RS Products is the canonical
 * catalogue, and this module is new enough to have no history tying it to the
 * legacy master.
 */
export const createMappingSchema = z.object({
  vendorId: cuidSchema,
  rsProductId: cuidSchema,
  /** The current agreed price per unit. Never applied to past purchases. */
  currentRate: amountSchema,
});

export const updateMappingSchema = z.object({
  currentRate: amountSchema.optional(),
  isActive: z.boolean().optional(),
});

export const mappingIdParamSchema = z.object({ id: cuidSchema });

export type VendorListQuery = z.infer<typeof vendorListQuerySchema>;
export type VendorTradeQuery = z.infer<typeof vendorTradeQuerySchema>;
export type MappingListQuery = z.infer<typeof mappingListQuerySchema>;
export type CreateMappingInput = z.infer<typeof createMappingSchema>;
export type UpdateMappingInput = z.infer<typeof updateMappingSchema>;
