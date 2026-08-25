import { z } from 'zod';
import { MAX_PRODUCTS_PER_ENQUIRY } from '../constants/index.js';
import {
  ENQUIRY_EFFICIENCIES,
  ENQUIRY_PRODUCT_STATUSES,
  ENQUIRY_SOURCES,
  ENQUIRY_STATUSES,
} from '../enums.js';
import {
  cuidSchema,
  dateRangeSchema,
  dimensionSchema,
  paginationSchema,
  weightSchema,
} from './common.js';
import { customerSelectionSchema } from './customer.js';

/** §12 — one requested product line. Fields map 1:1 to the field components. */
export const enquiryProductInputSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(200),
  imageAssetId: cuidSchema.optional(),
  quantity: z
    .number({ invalid_type_error: 'Quantity must be a number' })
    .int('Quantity must be a whole number')
    .positive('Quantity must be at least 1')
    .max(1_000_000, 'Quantity looks too large — check the value'),
  weight: weightSchema.optional(),
  dimension: dimensionSchema.optional(),
  /** §21 — flags that the customer will accept alternatives. */
  similarOptionNeeded: z.boolean().default(false),
});

/**
 * §11 / §62.1 — the 20-product cap.
 * Enforced here, again in the service transaction, and finally by a Postgres
 * CHECK constraint so concurrent requests cannot slip past it.
 */
export const createEnquirySchema = z
  .object({
    customer: customerSelectionSchema,
    source: z.enum(ENQUIRY_SOURCES, {
      errorMap: () => ({ message: 'Choose where this enquiry came from' }),
    }),
    sourceDetail: z.string().trim().max(160).optional(),
    /** §28 — "Towards": the employee whose SLA clock this is. */
    assignedToId: cuidSchema,
    products: z
      .array(enquiryProductInputSchema)
      .min(1, 'Add at least one product')
      .max(
        MAX_PRODUCTS_PER_ENQUIRY,
        `An enquiry can hold at most ${MAX_PRODUCTS_PER_ENQUIRY} products`,
      ),
  })
  .superRefine((value, ctx) => {
    // §17 — "Others" is only meaningful with the actual source written down.
    if (value.source === 'OTHERS' && !value.sourceDetail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceDetail'],
        message: 'Specify the source',
      });
    }
  });

export const updateEnquirySchema = z.object({
  source: z.enum(ENQUIRY_SOURCES).optional(),
  sourceDetail: z.string().trim().max(160).optional(),
});

export const reassignEnquirySchema = z.object({
  assignedToId: cuidSchema,
  note: z.string().trim().max(500).optional(),
});

/** Adding a line to an existing enquiry — the same cap applies server-side. */
export const addEnquiryProductSchema = enquiryProductInputSchema;

/** Q3 — a line reaches a terminal state either by response or by NO_VENDOR. */
export const updateEnquiryProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    imageAssetId: cuidSchema.nullable().optional(),
    quantity: z.number().int().positive().max(1_000_000).optional(),
    weight: weightSchema.nullable().optional(),
    dimension: dimensionSchema.nullable().optional(),
    similarOptionNeeded: z.boolean().optional(),
    status: z.enum(ENQUIRY_PRODUCT_STATUSES).optional(),
    noVendorReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'NO_VENDOR' && !value.noVendorReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['noVendorReason'],
        message: 'Give a reason before marking this product as having no vendor',
      });
    }
  });

/** §42 — required before a breached enquiry can be submitted. */
export const delayReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Explain the delay in a few words')
    .max(1000, 'Keep the reason under 1000 characters'),
});

/** §24 — reopening a closed enquiry is deliberate and always explains itself. */
export const reopenEnquirySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Say why this enquiry is being reopened')
    .max(1000, 'Keep the reason under 1000 characters'),
});

/**
 * Sortable columns, as an allowlist.
 *
 * A raw column name from the client would be an injection surface and would
 * also let callers sort by unindexed columns; only these four are offered, and
 * each is backed by an index on ProductEnquiry.
 */
export const ENQUIRY_SORT_FIELDS = [
  'createdAt',
  'slaDeadlineAt',
  'status',
  'efficiency',
] as const;
export type EnquirySortField = (typeof ENQUIRY_SORT_FIELDS)[number];

/** §49 — every filter round-trips to the server. */
export const enquiryListQuerySchema = paginationSchema.merge(dateRangeSchema).extend({
  q: z.string().trim().max(160).optional(),
  status: z.enum(ENQUIRY_STATUSES).optional(),
  assignedToId: cuidSchema.optional(),
  customerId: cuidSchema.optional(),
  efficiency: z.enum(ENQUIRY_EFFICIENCIES).optional(),
  /** §46 — breached with no submit at all; distinct from DELAYED. */
  neverResponded: z.coerce.boolean().optional(),
  sortBy: z.enum(ENQUIRY_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type EnquiryProductInput = z.infer<typeof enquiryProductInputSchema>;
export type CreateEnquiryInput = z.infer<typeof createEnquirySchema>;
export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;
export type ReassignEnquiryInput = z.infer<typeof reassignEnquirySchema>;
export type AddEnquiryProductInput = z.infer<typeof addEnquiryProductSchema>;
export type UpdateEnquiryProductInput = z.infer<typeof updateEnquiryProductSchema>;
export type DelayReasonInput = z.infer<typeof delayReasonSchema>;
export type ReopenEnquiryInput = z.infer<typeof reopenEnquirySchema>;
export type EnquiryListQuery = z.infer<typeof enquiryListQuerySchema>;
