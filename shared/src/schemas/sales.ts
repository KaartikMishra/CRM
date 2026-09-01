import { z } from 'zod';
import {
  MAX_ITEMS_PER_SALES_ORDER,
  SALES_ORDER_ID_MAX_LENGTH,
  SALES_ORDER_ID_PATTERN,
} from '../constants/index.js';
import { SALES_EFFICIENCIES, SALES_ORDER_STATUSES } from '../enums.js';
import { addAmount, compareAmount, isValidAmount, lineTotal } from '../utils/money.js';
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
export const salesOrderItemInputSchema = z.object({
  productName: z.string().trim().min(1, 'Product name is required').max(200),
  productImageAssetId: cuidSchema.optional(),
  quantity: salesQuantitySchema,
  price: salesPriceSchema,
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
    paidAmount: amountSchema.default('0.00'),
    orderDate: z.coerce.date({ invalid_type_error: 'Enter a valid order date' }),
    toBeDispatchedBy: z.coerce.date({ invalid_type_error: 'Enter a valid dispatch deadline' }),
  })
  .superRefine((value, ctx) => {
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

    const total = sumItemTotals(value.items);
    if (compareAmount(value.paidAmount, total) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paidAmount'],
        message: 'Paid amount cannot exceed the order total',
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
    productImageAssetId: cuidSchema.optional(),
    quantity: salesQuantitySchema,
    price: salesPriceSchema,
  }),
  z.object({
    type: z.literal('EDIT'),
    itemId: cuidSchema,
    productName: z.string().trim().min(1, 'Product name is required').max(200),
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
export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type ReviewChangeRequestInput = z.infer<typeof reviewChangeRequestSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type SalesOrderListQuery = z.infer<typeof salesOrderListQuerySchema>;
