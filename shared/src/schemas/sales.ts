import { z } from 'zod';
import {
  PAYMENT_METHODS,
  GST_MODES,
  GST_RATES,
  HSN_CODE_MAX_LENGTH,
  MAX_ITEMS_PER_SALES_ORDER,
  SALES_CHARGE_LABEL_MAX_LENGTH,
  SALES_CHARGE_MAX,
  SALES_CHARGE_TYPES,
  SALES_CANCELLATION_REASON_MAX_LENGTH,
  SALES_ORDER_ID_MAX_LENGTH,
  SALES_ORDER_ID_PATTERN,
  SALES_PAYMENT_REFERENCE_MAX_LENGTH,
} from '../constants/index.js';
import { SALES_EFFICIENCIES, SALES_ORDER_STATUSES } from '../enums.js';
import { addAmount, compareAmount, isValidAmount, lineTotal } from '../utils/money.js';
import { computeSalesTotals } from '../utils/sales-total.js';
import { amountSchema, cuidSchema, dateRangeSchema, paginationSchema } from './common.js';

/**
 * The Sales Order contract.
 *
 * Four things are deliberately absent from every input schema below: the order
 * total, the pending amount, the order status and the efficiency verdict. Two
 * are derived and two are decided by the workflow, so accepting any of them —
 * even to ignore it — would imply a caller could set it. Making them
 * unrepresentable in the input type is what makes "read-only" a guarantee
 * rather than a UI habit.
 *
 * A line's approval status is absent for the same reason: whether a proposed
 * line counts is decided by the server from the proposer's permissions, never
 * by the request.
 */

/**
 * Manually entered, never generated (order ids arrive from Shopify too).
 * Trimmed before the pattern runs, so trailing whitespace is a fixable typo
 * rather than a rejection.
 */
export const salesOrderIdSchema = z
  .string()
  .trim()
  .min(1, 'Order ID is required')
  .max(SALES_ORDER_ID_MAX_LENGTH, `Keep the order ID under ${SALES_ORDER_ID_MAX_LENGTH} characters`)
  .regex(SALES_ORDER_ID_PATTERN, 'Use letters, numbers, # - _ or / only');

/** Manual, whole numbers only, minimum 1. */
export const salesQuantitySchema = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(1_000_000, 'Quantity looks too large — check the value');

/** Manual, decimals allowed, strictly positive. */
export const salesPriceSchema = amountSchema.refine(
  (value) => compareAmount(value, '0.00') > 0,
  'Price must be greater than zero',
);

/** One product line, as it arrives from a form. */
/**
 * How a price is to be read. Line level: one order may carry 5% exclusive
 * beside 18% inclusive.
 *
 * Defaulted rather than optional: a price cannot be totalled until it is read
 * one way or the other, so there is no honest 'unset' to represent.
 */
export const gstModeSchema = z.enum(GST_MODES, {
  errorMap: () => ({ message: 'Choose whether the price includes GST' }),
});

export const salesOrderItemInputSchema = z.object({
  productName: z.string().trim().min(1, 'Product name is required').max(200),
  /**
   * The RS Product this line is for — the CRM's one product identity.
   *
   * An `RsProduct.id`, chosen from the RS Products picker. Never a
   * ShopifyVariant id and never a SKU: mapping is product level, and an RS SKU
   * is nullable and legitimately duplicated across products, so it identifies
   * nothing and is search and display only.
   *
   * Optional on purpose, and it must stay that way: an order line is written
   * from whatever the customer asked for, which is not always something in the
   * catalogue yet. `productName` remains the label on the order either way.
   *
   * When it *is* supplied, procurement can match purchased stock to this line
   * by identity rather than by spelling — which is the whole reason the field
   * exists. Matching by name would let "Bottle" and "bottle " become two
   * different requirements, or worse, silently the same one.
   */
  rsProductId: cuidSchema.optional(),
  productImageAssetId: cuidSchema.optional(),
  quantity: salesQuantitySchema,
  price: salesPriceSchema,

  /**
   * The HSN code for this line, as typed.
   *
   * A string, and only ever a string: codes carry leading zeros and
   * alphanumeric forms, so any numeric coercion would corrupt them. Length is
   * the sole constraint — no format pattern, because a stricter rule would
   * reject legitimate entries nobody has enumerated.
   *
   * Optional, and trimmed like every other text field here. An empty string
   * therefore arrives as '' and is stored as such rather than being rejected;
   * a caller that means "not recorded" omits the field.
   */
  hsnCode: z.string().trim().max(HSN_CODE_MAX_LENGTH).optional(),

  /**
   * The GST rate for this line — one of the six in GST_RATES.
   *
   * z.enum, so a seventh value cannot be introduced by a caller: anything
   * outside the list fails validation on both tiers rather than reaching the
   * column. 'NONE' and '0' are distinct members and neither is converted to a
   * number.
   *
   * Optional. Omitting it leaves the line's rate unrecorded (null), which is
   * distinct again from an explicit 'NONE'.
   */
  gstRate: z.enum(GST_RATES).optional(),
  /**
   * How THIS line's price is to be read, independent of every other line.
   *
   * Defaulted rather than optional: a price cannot be totalled until it is
   * read one way or the other, so there is no honest 'unset' to represent.
   * One order may carry 5% exclusive beside 18% inclusive — goods bought on
   * different terms are still one document.
   */
  gstMode: gstModeSchema.default('EXCLUSIVE'),
});

/** Exact sum of a set of line totals, in paise. Never a float. */
export function sumItemTotals(
  items: { quantity: number; price: string }[],
): string {
  return items.reduce(
    (running, item) => addAmount(running, lineTotal(item.price, item.quantity)),
    '0.00',
  );
}

/** True when every line is individually well-formed enough to price. */
const itemsPriceable = (items: { quantity: number; price: string }[]): boolean =>
  items.every(
    (item) => Number.isInteger(item.quantity) && item.quantity >= 1 && isValidAmount(item.price),
  );


/**
 * An order-level charge or adjustment.
 *
 * `amount` is always positive. DISCOUNT is what makes a row subtract, and the
 * sign lives in `type` rather than in the number, so no reader of this data
 * has to remember a convention to add it up.
 */
export const salesChargeInputSchema = z.object({
  type: z.enum(SALES_CHARGE_TYPES, {
    errorMap: () => ({ message: 'Choose a charge type' }),
  }),
  label: z.string().trim().max(SALES_CHARGE_LABEL_MAX_LENGTH).optional(),
  amount: amountSchema.refine((v) => compareAmount(v, '0.00') > 0, {
    message: 'Enter an amount greater than zero',
  }),
});

export const salesChargesSchema = z
  .array(salesChargeInputSchema)
  .max(SALES_CHARGE_MAX, 'Too many charges on one order')
  .default([]);

/** Replaces the whole set of charges on an order, as the editor sends them. */
export const setSalesChargesSchema = z.object({ charges: salesChargesSchema });
export const createSalesOrderSchema = z
  .object({
    orderId: salesOrderIdSchema,
    /** The order points at the customer master, never a copied name. */
    customerId: cuidSchema,
    items: z
      .array(salesOrderItemInputSchema)
      .min(1, 'Add at least one product')
      .max(
        MAX_ITEMS_PER_SALES_ORDER,
        `An order can hold at most ${MAX_ITEMS_PER_SALES_ORDER} products`,
      ),
    /** Partial payments are allowed, including none at all. */
    charges: salesChargesSchema,
    paidAmount: amountSchema.default('0.00'),
    /**
     * Optional on the wire, and required below exactly when money is recorded.
     *
     * Optional rather than defaulted, because COD with nothing paid yet and "no
     * payment arrangement recorded" are different statements and an order may
     * legitimately be either.
     */
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    orderDate: z.coerce.date({ invalid_type_error: 'Enter a valid order date' }),
    toBeDispatchedBy: z.coerce.date({ invalid_type_error: 'Enter a valid dispatch deadline' }),
  })
  .superRefine((value, ctx) => {
    /*
      A payment taken at creation has to say how it arrived.

      Only when money actually changes hands: an order created with nothing paid
      needs no method, which is what keeps this from becoming a field everybody
      has to answer for no reason. The service enforces the same rule, because a
      request need not come from the form.
    */
    if (
      isValidAmount(value.paidAmount) &&
      compareAmount(value.paidAmount, '0.00') > 0 &&
      !value.paymentMethod
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentMethod'],
        message: 'Choose how this payment was made',
      });
    }

    // Same-day dispatch is legitimate, so this is >= rather than >.
    if (value.toBeDispatchedBy < value.orderDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toBeDispatchedBy'],
        message: 'The dispatch deadline cannot fall before the order date',
      });
    }

    // Zod keeps going after a failed field check, so this can be reached with a
    // negative quantity or a malformed price still in hand. Deriving a total
    // from those throws rather than returning a message, so the cross-field rule
    // stands down and lets each field's own error speak instead.
    if (!itemsPriceable(value.items) || !isValidAmount(value.paidAmount)) return;

    /*
      Measured against the payable, not the line sum: with GST added on top
      and shipping beyond that, the amount a customer hands over is routinely
      larger than the goods came to, and refusing it here would reject a
      perfectly ordinary order.

      The split is assumed intra-state. This check exists to catch an obvious
      typo at the edge, and CGST+SGST versus IGST changes only which heads
      the tax is posted to, never the payable it is being compared against.
    */
    const { payable } = computeSalesTotals({
      split: 'CGST_SGST',
      items: value.items.map((item) => ({
        quantity: item.quantity,
        price: item.price,
        gstRate: item.gstRate ?? null,
        gstMode: item.gstMode,
      })),
      charges: value.charges,
    });
    if (compareAmount(value.paidAmount, payable) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paidAmount'],
        message: 'Paid amount cannot exceed the amount payable',
      });
    }
  });

/**
 * Order-header edit. Deliberately narrow: the product lines have their own
 * endpoints, and status, efficiency and the derived amounts are unreachable
 * here — they move through the explicit business actions.
 */
export const updateSalesOrderSchema = z.object({
  orderDate: z.coerce.date().optional(),
  toBeDispatchedBy: z.coerce.date().optional(),
});

/**
 * A proposed change to an order's products.
 *
 * Discriminated on `type`, so the shape enforces what each kind of request
 * actually needs: ADD invents a line and carries values but no target; EDIT
 * targets a line and carries the proposed values; REMOVE targets a line and
 * proposes nothing. The old updateSalesOrderItemSchema is deliberately gone —
 * there is no longer a request shape that edits a live line in place.
 */
export const createChangeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ADD'),
    productName: z.string().trim().min(1, 'Product name is required').max(200),
    /** The RS Product, exactly as on a line created with the order. */
    rsProductId: cuidSchema.optional(),
    productImageAssetId: cuidSchema.optional(),
    quantity: salesQuantitySchema,
    price: salesPriceSchema,
  }),
  z.object({
    type: z.literal('EDIT'),
    itemId: cuidSchema,
    productName: z.string().trim().min(1, 'Product name is required').max(200),
    rsProductId: cuidSchema.optional(),
    productImageAssetId: cuidSchema.nullable().optional(),
    quantity: salesQuantitySchema,
    price: salesPriceSchema,
  }),
  z.object({
    type: z.literal('REMOVE'),
    itemId: cuidSchema,
  }),
  /**
   * A change to the order's dates rather than its products.
   *
   * Both dates are optional individually, but at least one must be present —
   * a request that proposes nothing is not a request. Ordering between the two
   * is checked at approval against whichever value the order will actually end
   * up with, since a request may move only one of them.
   */
])

/** A reviewer's decision. The note is optional on both outcomes. */
export const reviewChangeRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const recordPaymentSchema = z.object({
  amount: amountSchema.refine(
    (value) => compareAmount(value, '0.00') > 0,
    'Enter a payment greater than zero',
  ),
  /**
   * Optional, and that is deliberate.
   *
   * The form always sends one — the control is required as soon as an amount is
   * entered — but making it required *on the wire* would change more than it
   * fixes. Validation runs before authorization, so a caller with no right to
   * the order would start getting 422 where they used to get 403, which leaks
   * that the order exists. Every payment recorded before this field existed
   * would also have been refused on replay.
   *
   * Omitted means "the arrangement is unchanged": the order keeps the method it
   * already had, which is the truthful reading for a second instalment on an
   * order already marked COD. Given, it is checked against the list like
   * anything else.
   */
  method: z.enum(PAYMENT_METHODS).optional(),

  /**
   * What names this payment in somebody else's system — a UTR for UPI or a
   * bank transfer, a cheque number, a cash receipt.
   *
   * Free text and deliberately unpatterned: the shape differs per method and
   * per bank, and a regex that rejected a valid reference would stop a real
   * payment being recorded, which is worse than storing an odd-looking one.
   * Trimmed, bounded, and optional because cash often has none.
   */
  reference: z.string().trim().min(1).max(SALES_PAYMENT_REFERENCE_MAX_LENGTH).optional(),

  /** Anything else worth saying about this instalment. */
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
//  Cancellation
// ---------------------------------------------------------------------------

/**
 * Calling off a whole order.
 *
 * The reason is required, not optional. A cancellation is a financial event —
 * it can make money refundable — and one with no stated reason is unauditable
 * six months later when somebody asks why the customer was owed.
 */
export const cancelSalesOrderSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this order is being cancelled')
    .max(SALES_CANCELLATION_REASON_MAX_LENGTH),
});

/**
 * Calling off part of an order: some units of some lines.
 *
 * Quantities rather than line ids alone, because a customer cancels one of
 * three rather than the row. Each entry names a line and how many more of it
 * to cancel; the service adds that to what is already cancelled and refuses
 * anything that would take the total past what was ordered.
 */
export const cancelSalesItemsSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why these units are being cancelled')
    .max(SALES_CANCELLATION_REASON_MAX_LENGTH),
  lines: z
    .array(
      z.object({
        itemId: cuidSchema,
        /** How many MORE units to cancel, never the new cancelled total. */
        quantity: z.coerce.number().int().min(1, 'Cancel at least one unit'),
      }),
    )
    .min(1, 'Choose at least one product to cancel')
    .max(MAX_ITEMS_PER_SALES_ORDER)
    .superRefine((lines, ctx) => {
      // Two entries for one line would have to be added together to be
      // checked, and the caller almost certainly means one of them.
      const seen = new Set<string>();
      for (const line of lines) {
        if (seen.has(line.itemId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Each product may appear only once',
          });
          return;
        }
        seen.add(line.itemId);
      }
    }),
});

// ---------------------------------------------------------------------------
//  Refunds
// ---------------------------------------------------------------------------

/**
 * Recording that money is owed back. It does not move any.
 *
 * The amount is stated rather than derived from the cancellation: a business
 * may refund less than the cancelled value (a restocking fee) or settle in
 * instalments. What it may never do is exceed what is actually refundable,
 * which the service computes and enforces.
 */
export const createSalesRefundSchema = z.object({
  amount: amountSchema.refine(
    (value) => compareAmount(value, '0.00') > 0,
    'Enter a refund greater than zero',
  ),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this money is being returned')
    .max(SALES_CANCELLATION_REASON_MAX_LENGTH),
  note: z.string().trim().max(500).optional(),
});

/**
 * Marking a refund as actually sent.
 *
 * The reference is required here and nowhere else. Saying the money has gone
 * without saying how it went is the one claim this system cannot check, so it
 * is the one the database refuses — see sales_refund_completed_has_reference.
 */
export const settleSalesRefundSchema = z.object({
  reference: z
    .string()
    .trim()
    .min(1, 'Enter the reference the money went out with')
    .max(SALES_PAYMENT_REFERENCE_MAX_LENGTH),
  note: z.string().trim().max(500).optional(),
});

/** Refusing a refund. The note is the only record of why. */
export const rejectSalesRefundSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

/**
 * Sortable columns, as an allowlist.
 *
 * A raw column name from the client would be an injection surface and would let
 * callers sort by unindexed columns. Each of these is backed by an index on
 * SalesOrder. The derived amounts are absent because they are not columns —
 * there is nothing for Postgres to sort on.
 */
export const SALES_ORDER_SORT_FIELDS = [
  'orderDate',
  'toBeDispatchedBy',
  'status',
  'efficiency',
] as const;
export type SalesOrderSortField = (typeof SALES_ORDER_SORT_FIELDS)[number];

/** Every filter round-trips to the server; nothing is filtered client-side. */
export const salesOrderListQuerySchema = paginationSchema.merge(dateRangeSchema).extend({
  /** Matches the order id, any line's product name, or the customer's name. */
  q: z.string().trim().max(160).optional(),
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  efficiency: z.enum(SALES_EFFICIENCIES).optional(),
  customerId: cuidSchema.optional(),
  sortBy: z.enum(SALES_ORDER_SORT_FIELDS).default('orderDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type SalesOrderItemInput = z.infer<typeof salesOrderItemInputSchema>;
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderSchema>;
export type SalesChargeInput = z.infer<typeof salesChargeInputSchema>;
export type SetSalesChargesInput = z.infer<typeof setSalesChargesSchema>;
export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type ReviewChangeRequestInput = z.infer<typeof reviewChangeRequestSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type CancelSalesOrderInput = z.infer<typeof cancelSalesOrderSchema>;
export type CancelSalesItemsInput = z.infer<typeof cancelSalesItemsSchema>;
export type CreateSalesRefundInput = z.infer<typeof createSalesRefundSchema>;
export type SettleSalesRefundInput = z.infer<typeof settleSalesRefundSchema>;
export type RejectSalesRefundInput = z.infer<typeof rejectSalesRefundSchema>;
export type SalesOrderListQuery = z.infer<typeof salesOrderListQuerySchema>;
