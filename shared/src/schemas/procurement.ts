import { z } from 'zod';
import { PURCHASE_BILL_TYPES, PURCHASE_BILL_STATUSES } from '../enums.js';
import { amountSchema, cuidSchema, paginationSchema } from './common.js';

/**
 * The Purchase & Procurement contract.
 *
 * Three families of number appear in this module and are easy to confuse, so
 * they are named once here and never re-derived by a caller:
 *
 *   required   what an order line asked for
 *   pending    how much of that is still unmet
 *   standing   purchased stock that has arrived and is not yet spoken for
 *
 * Pending is a property of an *order line*; standing is a property of a
 * *purchase bill line*. They answer different questions and are never summed
 * together. Both are computed on the server: every one of them is absent from
 * the input schemas below, because a client that could send them could
 * disagree with the ledger.
 */

/** Whole units, at least one. Quantities here are counts of physical things. */
export const procurementQuantitySchema = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(1_000_000, 'Quantity looks too large — check the value');

/** Received may legitimately be zero: ordered today, arriving next week. */
export const receivedQuantitySchema = z
  .number({ invalid_type_error: 'Received quantity must be a number' })
  .int('Received quantity must be a whole number')
  .min(0, 'Received quantity cannot be negative')
  .max(1_000_000, 'Received quantity looks too large — check the value');

// ---------------------------------------------------------------------------
//  Product master
// ---------------------------------------------------------------------------

export const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(200),
  description: z.string().trim().max(1000).optional(),
  /** Opening stock. Absent means zero — an uncounted shelf is not a guess. */
  onHand: z.number().int().min(0).max(10_000_000).optional(),
});

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/**
 * Stock correction, as a signed delta rather than an absolute value.
 *
 * Two people counting the same shelf minutes apart would otherwise overwrite
 * each other with stale totals; a delta composes, and the row lock makes it
 * exact.
 */
export const adjustInventorySchema = z.object({
  delta: z
    .number({ invalid_type_error: 'Adjustment must be a number' })
    .int('Adjustment must be a whole number')
    .refine((v) => v !== 0, 'Adjustment cannot be zero'),
  reason: z.string().trim().min(1, 'Give a reason for the adjustment').max(500),
});

export const productListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
//  Purchase bills
// ---------------------------------------------------------------------------

/**
 * One product line on a bill.
 *
 * `receivedQty` cannot exceed `orderedQty`: ordering ten and receiving four
 * must never make ten allocatable. The database enforces the same rule, so a
 * racing write cannot slip past it either.
 */
export const purchaseBillItemInputSchema = z
  .object({
    /**
     * The vendor's own description, typed from the bill. Free text on purpose:
     * a bill is a record of a document, and the supplier's wording is what
     * makes the entry checkable against the paper.
     */
    productName: z.string().trim().min(1, 'Product name is required').max(200),
    /**
     * Optional catalogue link. Usually absent at entry — the goods are matched
     * to a catalogue entry later, when stock is allocated to an order, because
     * that is the point at which product identity actually matters.
     */
    productId: cuidSchema.optional(),
    orderedQty: procurementQuantitySchema,
    receivedQty: receivedQuantitySchema.default(0),
    rate: amountSchema,
    productImageAssetId: cuidSchema.optional(),
  })
  .refine((v) => v.receivedQty <= v.orderedQty, {
    path: ['receivedQty'],
    message: 'Received quantity cannot exceed the quantity ordered',
  });

/**
 * A bill is from exactly one vendor, because that is how the paperwork
 * arrives. Procuring from three vendors is three bills against the same
 * shortage — not one bill pretending to have three suppliers.
 */
export const createPurchaseBillSchema = z
  .object({
    billNumber: z.string().trim().min(1, 'Bill number is required').max(64),
    vendorId: cuidSchema,
    billType: z.enum(PURCHASE_BILL_TYPES, {
      errorMap: () => ({ message: 'Choose Credit or Paid Up' }),
    }),
    billDate: z.coerce.date(),
    expectedBy: z.coerce.date().optional(),
    billImageAssetId: cuidSchema.optional(),
    notes: z.string().trim().max(2000).optional(),
    items: z
      .array(purchaseBillItemInputSchema)
      .min(1, 'Add at least one product line')
      .max(100, 'A bill can carry at most 100 lines'),
  })
  .refine((v) => !v.expectedBy || v.expectedBy >= v.billDate, {
    path: ['expectedBy'],
    message: 'The expected date cannot be before the bill date',
  });

export const updatePurchaseBillSchema = z
  .object({
    billType: z.enum(PURCHASE_BILL_TYPES).optional(),
    expectedBy: z.coerce.date().nullable().optional(),
    billImageAssetId: cuidSchema.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** Recording arrival. Raising this is what creates allocatable stock. */
export const receiveItemSchema = z.object({
  receivedQty: receivedQuantitySchema,
});

/**
 * Flagging a late delivery. The reason is mandatory when the flag is set —
 * the same rule the enquiry module applies to a NO_VENDOR line, and a database
 * CHECK enforces it rather than trusting this schema alone.
 */
export const purchaseDelaySchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason for the delay').max(1000),
});

export const purchaseBillListQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    vendorId: cuidSchema.optional(),
    status: z.enum(PURCHASE_BILL_STATUSES).optional(),
    billType: z.enum(PURCHASE_BILL_TYPES).optional(),
    isDelayed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .merge(paginationSchema);

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

/**
 * Assigning received stock to one order line.
 *
 * The target is a line id, never a product name: a name can match two lines on
 * two orders, and an allocation that drifts onto the wrong requirement is
 * silent corruption. Quantity is checked twice on the server — against the
 * line's remaining requirement and against the bill item's standing quantity —
 * with both rows locked.
 */
export const createAllocationSchema = z.object({
  salesOrderItemId: cuidSchema,
  quantity: procurementQuantitySchema,
});

/** Zero is allowed here, and means "release this allocation entirely". */
export const updateAllocationSchema = z.object({
  quantity: z
    .number({ invalid_type_error: 'Quantity must be a number' })
    .int('Quantity must be a whole number')
    .min(0, 'Quantity cannot be negative')
    .max(1_000_000),
});

/**
 * Attaching an existing order line to a catalogue product.
 *
 * For lines written before the Product master existed, or typed as free text.
 * Only `productId` is settable: the line's name, quantity, price and status are
 * the order's own record of what was agreed, and a catalogue link is not a
 * licence to edit any of them.
 */
export const linkOrderLineSchema = z.object({
  salesOrderItemId: cuidSchema,
  productId: cuidSchema,
});

/**
 * Attaching a purchase line to a catalogue product.
 *
 * Recording a bill needs no catalogue decision; allocating from it does, since
 * stock is matched to a requirement by identity and never by spelling.
 */
export const linkPurchaseItemSchema = z.object({ productId: cuidSchema });

/**
 * Recording fulfilment that happened outside procurement.
 *
 * An absolute figure rather than a delta: this is a correction of the record
 * ("we have actually sent four"), not an event to accumulate. The service
 * refuses a value above the line's quantity, and a database CHECK refuses it
 * again.
 */
export const recordFulfillmentSchema = z.object({
  alreadyFulfilled: z
    .number({ invalid_type_error: 'Fulfilled quantity must be a number' })
    .int('Fulfilled quantity must be a whole number')
    .min(0, 'Fulfilled quantity cannot be negative')
    .max(1_000_000),
});

/** Looking up an order by the number a human typed, to see its requirements. */
export const orderRequirementQuerySchema = z.object({
  orderId: z.string().trim().min(1, 'Enter an order ID').max(64),
});

/**
 * One IST calendar day of Sales history.
 *
 * A plain YYYY-MM-DD rather than a coerced Date: the value names a day in the
 * timezone the business works in, and `z.coerce.date()` would read it as UTC
 * midnight and silently shift the boundary by five and a half hours. The
 * server pairs this string with the IST offset itself.
 */
/**
 * Cataloguing an order line's product. Only the line is named: its own
 * productName becomes the catalogue entry, so the two cannot disagree.
 */
export const putInCatalogueSchema = z.object({
  salesOrderItemId: cuidSchema,
});

export const salesRequirementQuerySchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form')
    .optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type PurchaseBillItemInput = z.infer<typeof purchaseBillItemInputSchema>;
export type CreatePurchaseBillInput = z.infer<typeof createPurchaseBillSchema>;
export type UpdatePurchaseBillInput = z.infer<typeof updatePurchaseBillSchema>;
export type ReceiveItemInput = z.infer<typeof receiveItemSchema>;
export type PurchaseDelayInput = z.infer<typeof purchaseDelaySchema>;
export type PurchaseBillListQuery = z.infer<typeof purchaseBillListQuerySchema>;
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;
export type UpdateAllocationInput = z.infer<typeof updateAllocationSchema>;
export type OrderRequirementQuery = z.infer<typeof orderRequirementQuerySchema>;
export type SalesRequirementQuery = z.infer<typeof salesRequirementQuerySchema>;
export type PutInCatalogueInput = z.infer<typeof putInCatalogueSchema>;
export type LinkOrderLineInput = z.infer<typeof linkOrderLineSchema>;
export type LinkPurchaseItemInput = z.infer<typeof linkPurchaseItemSchema>;
export type RecordFulfillmentInput = z.infer<typeof recordFulfillmentSchema>;
