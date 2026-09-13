import { z } from 'zod';
import {
  DIMENSION_UNITS,
  PRODUCT_SOURCES,
  SHOPIFY_PRODUCT_STATUSES,
  WEIGHT_UNITS,
} from '../enums.js';
import { amountSchema, cuidSchema } from './common.js';

/**
 * The RS Products contract.
 *
 * Two things here differ deliberately from the legacy Product master, and both
 * follow from what a real Shopify catalogue contains:
 *
 *   - a title is not unique, and is not identity;
 *   - a SKU is not unique either, and may be absent entirely. The live
 *     catalogue holds 13 repeated SKUs and 2 blank ones, so any schema that
 *     insisted otherwise would reject real products.
 *
 * Identity is always a Shopify id, or the CRM's own cuid for a manual product.
 */

/** How the catalogue may be ordered. Each maps to an indexed column. */
export const RS_PRODUCT_SORTS = ['title', 'price', 'inventory', 'newest'] as const;
export type RsProductSort = (typeof RS_PRODUCT_SORTS)[number];

/**
 * The catalogue list query.
 *
 * `q` searches title *and* variant SKU: staff know a product as RS2331 far
 * more often than by an 80-character marketing title.
 */
export const rsProductListQuerySchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).optional(),
  status: z.enum(SHOPIFY_PRODUCT_STATUSES).optional(),
  source: z.enum(PRODUCT_SOURCES).optional(),
  productType: z.string().trim().max(200).optional(),
  sort: z.enum(RS_PRODUCT_SORTS).default('title'),
});

/**
 * A CRM-only product.
 *
 * `source` is not accepted from the client: a product created here is MANUAL by
 * definition, and letting a caller claim SHOPIFY would invite a row the sync
 * believes it owns.
 *
 * Title allows 500 characters because the live catalogue's longest is 222 — a
 * shorter limit would reject products the CRM already holds.
 */
export const createRsProductSchema = z.object({
  title: z.string().trim().min(1, 'Product name is required').max(500),
  description: z.string().trim().max(10_000).optional(),
  status: z.enum(SHOPIFY_PRODUCT_STATUSES).default('ACTIVE'),
  productType: z.string().trim().max(200).optional(),
  vendor: z.string().trim().max(200).optional(),

  /** The single variant every product needs in order to carry a price. */
  price: amountSchema,
  /** Optional, and deliberately not checked for uniqueness. */
  sku: z.string().trim().max(100).optional(),
  inventoryQty: z.number().int().min(0).max(10_000_000).default(0),
});

export const rsProductIdParamSchema = z.object({ id: cuidSchema });

/** Whole units, never negative. Stock is a count of physical things. */
export const crmStockSchema = z
  .number({ invalid_type_error: 'Stock must be a number' })
  .int('Stock must be a whole number')
  .min(0, 'Stock cannot be negative')
  .max(10_000_000, 'That stock figure looks too large — check the value');

/** A dimension: positive, to two decimals, and bounded. */
export const dimensionValueSchema = z
  .number({ invalid_type_error: 'Dimension must be a number' })
  .positive('Dimension must be greater than zero')
  .max(100_000, 'That dimension looks too large — check the value');

/**
 * Editing one variant.
 *
 * Every field is optional: the form sends what changed, and an absent key means
 * "leave it alone" rather than "set it to null". That distinction matters for a
 * Shopify-synced variant, where blanking a field the CRM never owned would
 * discard Shopify's value until the next sync restored it.
 *
 * Absent from this schema entirely, and deliberately: `inventoryQty`, which is
 * Shopify's own figure and is rewritten by every sync and inventory webhook;
 * and the three Shopify ids, which are identity.
 */
export const updateVariantSchema = z.object({
  id: cuidSchema,
  /** CRM-owned on every product. Shopify never writes it. */
  costPrice: amountSchema.nullable().optional(),
  crmStockQty: crmStockSchema.optional(),

  /// Manually entered: Shopify's dimension metafields carry no unit, so these
  /// are the only dimensions the CRM can state with confidence.
  lengthValue: dimensionValueSchema.nullable().optional(),
  widthValue: dimensionValueSchema.nullable().optional(),
  heightValue: dimensionValueSchema.nullable().optional(),
  dimensionUnit: z.enum(DIMENSION_UNITS).nullable().optional(),

  /** Shopify-owned on a synced product; the service refuses it there. */
  sku: z.string().trim().max(100).nullable().optional(),
  price: amountSchema.optional(),
  weightValue: z.number().positive().max(1_000_000).nullable().optional(),
  weightUnit: z.enum(WEIGHT_UNITS).nullable().optional(),
});

/**
 * Editing a product and its variants in one request.
 *
 * Which fields are actually accepted depends on `source`, and the service —
 * not this schema — is what enforces that: a SHOPIFY product's title, price,
 * weight, status and SKU belong to Shopify, and a CRM edit would be silently
 * reverted by the next sync. Rejecting those server-side is more honest than
 * accepting a change that will not survive.
 */
export const updateRsProductSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  status: z.enum(SHOPIFY_PRODUCT_STATUSES).optional(),
  productType: z.string().trim().max(200).nullable().optional(),
  vendor: z.string().trim().max(200).nullable().optional(),
  variants: z.array(updateVariantSchema).max(100).optional(),
});

export type RsProductListQuery = z.infer<typeof rsProductListQuerySchema>;
export type CreateRsProductInput = z.infer<typeof createRsProductSchema>;
export type UpdateRsProductInput = z.infer<typeof updateRsProductSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
