import { z } from 'zod';
import { BILL_APPROVAL_STATUSES, PURCHASE_BILL_TYPES, PURCHASE_BILL_STATUSES } from '../enums.js';
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

/*
 * The legacy product master has no contract here at all any more.
 *
 * Listing it, creating one, editing one and correcting its stock by hand have
 * all gone. RS Products is the catalogue: a product that is not in it is
 * created there, and Procurement identifies goods by `RsProduct.id` alone.
 */

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
     * The vendor's own description, as it appears on the document.
     *
     * OPTIONAL, and that is the change. The field itself stays — a purchase
     * bill is a record of a piece of paper, and the supplier's wording is what
     * makes the recorded entry checkable against it, so historical rows keep
     * theirs and nothing is dropped. What went is its role in *mapping*: no UI
     * asks a person to type a product name any more, because a typed name is
     * not an identity and treating it as one is what let a line mean whatever
     * its spelling happened to match.
     *
     * When it is omitted the server takes the chosen RS Product's title. So a
     * line still always has a readable description; it simply comes from the
     * catalogue entry somebody deliberately picked rather than from free text.
     * Omitting both this and `rsProductId` is refused — that line would name
     * nothing at all.
     */
    productName: z.string().trim().min(1, 'Product name is required').max(200).optional(),
    /**
     * The RS Product this line is for — Procurement's canonical identity.
     *
     * An `RsProduct.id`, chosen from the RS Products picker. Never a
     * ShopifyVariant id and never a SKU: Procurement maps at product level, and
     * a SKU is nullable and legitimately duplicated, so it identifies nothing.
     *
     * Optional, because a bill is typed up from a piece of paper and the person
     * recording it may not yet have decided what a line refers to. An unmapped
     * line is recorded and received exactly as before; it is simply shown as
     * unmapped until somebody picks the product.
     */
    rsProductId: cuidSchema.optional(),
    orderedQty: procurementQuantitySchema,
    receivedQty: receivedQuantitySchema.default(0),
    rate: amountSchema,
    productImageAssetId: cuidSchema.optional(),
  })
  .refine((v) => v.receivedQty <= v.orderedQty, {
    path: ['receivedQty'],
    message: 'Received quantity cannot exceed the quantity ordered',
  })
  /*
    A line has to name its goods somehow. With the free-text mapping input gone
    the normal answer is the RS Product, and the server takes the title from it;
    a caller may still send a bare `productName` instead, which is what a
    historical import does. Sending neither leaves a line that describes nothing
    and can never be allocated, so it is refused at the edge.
  */
  .refine((v) => Boolean(v.rsProductId) || Boolean(v.productName), {
    path: ['rsProductId'],
    message: 'Choose the RS Product this line is for',
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

/**
 * Signing a bill off, or refusing it.
 *
 * The note is optional on an approval and expected on a rejection, where it is
 * the only thing telling the person who recorded the bill what to correct.
 * Deliberately the same shape as `reviewProductChangeSchema`, because it is the
 * same kind of act — but a separate endpoint and a separate decision: that one
 * decides a proposed edit to one line, this one decides the bill itself.
 */
export const reviewPurchaseBillSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const purchaseBillListQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    vendorId: cuidSchema.optional(),
    status: z.enum(PURCHASE_BILL_STATUSES).optional(),
    /** Filter the list to one approval state — the queue an approver works. */
    approvalStatus: z.enum(BILL_APPROVAL_STATUSES).optional(),
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
 * Mapping an existing order line to an RS Product.
 *
 * For lines written as free text, which is most of them — an order records what
 * a customer asked for, and that is not always something in the catalogue at
 * the time. Only `rsProductId` is settable: the line's name, quantity, price
 * and status are the order's own record of what was agreed, and saying what the
 * goods are is not a licence to edit any of them.
 */
export const linkOrderLineSchema = z.object({
  salesOrderItemId: cuidSchema,
  rsProductId: cuidSchema,
});

/**
 * Mapping a purchase line to an RS Product — the canonical identity.
 *
 * An `RsProduct.id` and nothing else. Not a variant id, not a SKU, not a title:
 * RS SKUs are nullable and repeat across products, so a SKU cannot decide which
 * product a line means. The person picks the exact product; the server never
 * infers one from the vendor's wording or from a matching SKU.
 *
 * Recording a bill needs no such decision; allocating from it does, since stock
 * is matched to a requirement by identity and never by spelling.
 */
export const mapPurchaseItemSchema = z.object({ rsProductId: cuidSchema });

/**
 * Asking to move an already-mapped purchase line to a different RS Product.
 *
 * The separate endpoint is the whole point. `mapPurchaseItemSchema` above gives
 * an unmapped line its first product and applies immediately; this one records a
 * request and applies nothing. Which of the two a caller reaches is decided by
 * the server from the line's current state, never by the caller — so there is no
 * shape of request that maps straight over an existing mapping.
 *
 * The reason is mandatory. An approver is judging whether goods were
 * misidentified on a document they did not see, and two product titles are not
 * enough to decide that on.
 */
export const requestProductChangeSchema = z.object({
  rsProductId: cuidSchema,
  reason: z
    .string()
    .trim()
    .min(10, 'Explain why this line should be re-mapped — at least a sentence')
    .max(1000),
});

/**
 * Deciding one. The note is optional on an approval and expected on a rejection,
 * where it is the only thing telling the requester what to do differently.
 */
export const reviewProductChangeSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const productChangeListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  billId: cuidSchema.optional(),
});

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
export const salesRequirementQuerySchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form')
    .optional(),
});

export type PurchaseBillItemInput = z.infer<typeof purchaseBillItemInputSchema>;
export type CreatePurchaseBillInput = z.infer<typeof createPurchaseBillSchema>;
export type UpdatePurchaseBillInput = z.infer<typeof updatePurchaseBillSchema>;
export type ReceiveItemInput = z.infer<typeof receiveItemSchema>;
export type PurchaseDelayInput = z.infer<typeof purchaseDelaySchema>;
export type PurchaseBillListQuery = z.infer<typeof purchaseBillListQuerySchema>;
export type ReviewPurchaseBillInput = z.infer<typeof reviewPurchaseBillSchema>;
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;
export type UpdateAllocationInput = z.infer<typeof updateAllocationSchema>;
export type OrderRequirementQuery = z.infer<typeof orderRequirementQuerySchema>;
export type SalesRequirementQuery = z.infer<typeof salesRequirementQuerySchema>;
export type LinkOrderLineInput = z.infer<typeof linkOrderLineSchema>;
export type MapPurchaseItemInput = z.infer<typeof mapPurchaseItemSchema>;
export type RequestProductChangeInput = z.infer<typeof requestProductChangeSchema>;
export type ReviewProductChangeInput = z.infer<typeof reviewProductChangeSchema>;
export type ProductChangeListQuery = z.infer<typeof productChangeListQuerySchema>;
export type RecordFulfillmentInput = z.infer<typeof recordFulfillmentSchema>;
