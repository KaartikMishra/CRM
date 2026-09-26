/**
 * Response contracts for the Sales Order API.
 *
 * These describe what actually crosses the wire, which is not the Prisma row:
 * `DateTime` arrives as an ISO string and `Decimal` as a decimal string, never
 * a float (§7). The frontend types against these rather than against the
 * database models, so the two tiers cannot drift.
 */

import type {
  GstMode,
  GstRate,
  PaymentMethod,
  SalesChargeType,
  TaxSplit,
} from '../constants/index.js';
import type {
  SalesChangeStatus,
  SalesChangeType,
  SalesEfficiency,
  SalesItemStatus,
  SalesOrderStatus,
  SalesRefundStatus,
} from '../enums.js';
import type {
  CustomerContactRef,
  CustomerRef,
  DecimalString,
  IsoDateTime,
  MediaRef,
  UserRef,
} from './enquiry.js';

/**
 * A catalogue image, borrowed from the RS Product a line points at.
 *
 * Distinct from MediaRef on purpose. A MediaRef is an upload the order owns —
 * it has an id and a Cloudinary publicId, and the order may replace or delete
 * it. This is a URL belonging to the product, which Shopify sync may overwrite
 * at any time and which no order may alter. Keeping the two apart is what stops
 * a catalogue picture being mistaken for the order's own record of what was
 * sold.
 */
export type CatalogueImageRef = {
  url: string;
  altText: string | null;
};

/** One product line on an order. */
export type SalesOrderItemView = {
  id: string;
  lineNo: number;
  productName: string;
  image: MediaRef | null;
  /**
   * The RS Product's own image, shown only when the line carries no upload.
   * Always null when `image` is set: a manual upload is authoritative.
   */
  catalogueImage: CatalogueImageRef | null;
  /** What was ORDERED. Never reduced by a cancellation — see cancelledQty. */
  quantity: number;
  /**
   * How many of those units the customer has called off.
   *
   * Zero on every line nobody has cancelled, which is almost all of them. The
   * ordered quantity is left intact beside it so the order keeps saying what
   * was agreed; `remainingQty` below is the subtraction.
   */
  cancelledQty: number;
  /** quantity − cancelledQty: what the customer is still to receive. */
  remainingQty: number;
  price: DecimalString;
  /** quantity × price, derived by the API. GST is not part of it. */
  lineTotal: DecimalString;

  /**
   * The HSN code recorded on this line, or null where none was.
   *
   * A string, never a number. Null means nobody entered one — including every
   * line written before the field existed.
   */
  hsnCode: string | null;

  /**
   * The GST rate recorded on this line: one of GST_RATES, or null.
   *
   * Three distinct states, and the UI must not merge them: null is "not
   * recorded", 'NONE' is "no GST applies to this line", and '0' is "exempt, at
   * zero percent". Stored and displayed only — no total is derived from it.
   */
  gstRate: GstRate | null;
  /** How this line's price was read. Independent of every other line. */
  gstMode: GstMode;
  /** The value taxed. Lower than `lineTotal` when the price includes GST. */
  taxableAmount: DecimalString;
  /** The GST on this line alone, before it is split into heads. */
  gstAmount: DecimalString;

  status: SalesItemStatus;
  /** Who put this line forward. */
  proposedBy: UserRef;
  /** Set only where a proposal was actually approved; null for original lines. */
  approvedBy: UserRef | null;
  approvedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
};

/**
 * The money on an order, grouped so the UI reads one object.
 *
 * Only `paid` is stored. `total` is the sum of the order's ACTIVE line totals
 * and `pending` is total − paid, both derived by the API — they exist in no
 * database column, which is precisely why they cannot be edited. The client
 * renders them; it never computes the authoritative value, and it never parses
 * any of these back into a number for arithmetic.
 */
/** One order-level charge or adjustment, as the API reports it. */
export type SalesChargeView = {
  id: string;
  type: SalesChargeType;
  label: string | null;
  /** Always positive. DISCOUNT is what makes it subtract. */
  amount: DecimalString;
};

/** One GST slab's contribution, for the rate-by-rate table on an invoice. */
export type TaxRateBreakupView = {
  /** A whole number of percent. Never zero, and never 'NONE'. */
  rate: number;
  taxable: DecimalString;
  tax: DecimalString;
  cgst: DecimalString;
  sgst: DecimalString;
  igst: DecimalString;
};

/**
 * One instalment actually taken against an order.
 *
 * The order's `money.paid` is the sum of these. It is kept as its own column
 * because the database's money guard enforces against it, but nothing here is
 * a second copy of it: these rows are what that figure is made of.
 */
export type SalesPaymentView = {
  id: string;
  amount: DecimalString;
  /** How this instalment arrived, or null where nobody said. */
  method: PaymentMethod | null;
  /** UTR, cheque number, receipt — whatever names it elsewhere. */
  reference: string | null;
  note: string | null;
  recordedBy: UserRef;
  recordedAt: IsoDateTime;
};

/**
 * Money owed back to the customer, and whether it has actually gone.
 *
 * PENDING means agreed and not sent. COMPLETED means somebody sent it and
 * named the reference. Nothing here is implied by a cancellation: cancelling
 * says the goods are not coming, and a refund is a separate decision somebody
 * has to take and record.
 */
export type SalesRefundView = {
  id: string;
  amount: DecimalString;
  status: SalesRefundStatus;
  reason: string;
  /** How the money went back. Always present once COMPLETED. */
  reference: string | null;
  note: string | null;
  requestedBy: UserRef;
  requestedAt: IsoDateTime;
  settledBy: UserRef | null;
  settledAt: IsoDateTime | null;
};

export type SalesMoneyView = {
  /**
   * What the customer owes: taxable goods + GST + charges - discount.
   *
   * This is the figure `paid` is measured against and the one the order must
   * match to close. It was previously the bare sum of the line totals; GST
   * and charges now form part of it, and the money guard trigger enforces the
   * same definition in the database.
   */
  total: DecimalString;
  /** The goods before tax. Lower than the line sum when prices are inclusive. */
  taxableSubtotal: DecimalString;
  /** What the lines come to as typed, whichever way they are read. */
  lineSubtotal: DecimalString;

  /** Which heads the tax posts to, from the seller's and customer's states. */
  taxSplit: TaxSplit;
  taxTotal: DecimalString;
  cgstTotal: DecimalString;
  sgstTotal: DecimalString;
  igstTotal: DecimalString;
  /** Slab by slab, for the invoice table. Empty when nothing is taxed. */
  taxByRate: TaxRateBreakupView[];
  /** Everything added beyond the goods. */
  chargesTotal: DecimalString;
  /** What was taken off. Positive. */
  discountTotal: DecimalString;
  paid: DecimalString;
  /**
   * How the money is being collected, or null where nothing says.
   *
   * Not a term in any total — it states how the paid amount arrived,
   * never how much. Null on every order recorded before it existed.
   */
  paymentMethod: PaymentMethod | null;
  /**
   * What is still owed on what the customer is actually getting:
   * max(0, activeTotal − paid).
   *
   * Identical to total − paid on any order with nothing cancelled, which is
   * almost all of them. Clamped at zero because once units are cancelled the
   * customer can be *ahead* rather than behind, and that surplus is a refund
   * owed rather than a negative debt — see refundable below.
   */
  pending: DecimalString;

  /**
   * What the order is worth after cancellations: the same arithmetic as
   * `total`, run over the REMAINING quantities.
   *
   * Equal to `total` until something is cancelled. `total` deliberately keeps
   * meaning the ORDERED value, because that is the figure the money guard
   * enforces in the database and the record of what was agreed.
   */
  activeTotal: DecimalString;
  /** total − activeTotal. What the cancelled units were worth. */
  cancelledTotal: DecimalString;

  /**
   * Money the customer has paid that the remaining order no longer accounts
   * for, and that nobody has yet promised back:
   *
   *     refundable = max(0, paid − activeTotal − refunded − refundPending)
   *
   * Cancelling does NOT refund. This figure is what a cancellation produces;
   * a SalesRefund record is what answers it.
   */
  refundable: DecimalString;
  /** Sum of refunds actually settled, with a reference against each. */
  refunded: DecimalString;
  /** Sum of refunds agreed and not yet sent. The customer is still owed this. */
  refundPending: DecimalString;
  /** True once the order is settled in full. Saves the UI a string comparison. */
  fullyPaid: boolean;
  currency: string;
  activeItemCount: number;
  /** How many lines are waiting on an approver. */
  pendingApprovalCount: number;
  /** What those waiting lines would add to the total once approved. */
  pendingApprovalTotal: DecimalString;
};

/** The list row — enough to render a table, no nested collections. */
export type SalesOrderSummary = {
  /** Internal record id. This is what the row links to, never orderId. */
  id: string;
  /** The human-facing, manually entered number. */
  orderId: string;
  customer: CustomerRef;
  /** The first active line's product, for the table's description column. */
  leadProductName: string;
  thumbnail: MediaRef | null;
  /** Only set when no line on the order carries an upload of its own. */
  catalogueThumbnail: CatalogueImageRef | null;
  money: SalesMoneyView;
  status: SalesOrderStatus;
  /** Null until the order is dispatched, then frozen. */
  efficiency: SalesEfficiency | null;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  /** Derived, not stored: still open and past its dispatch deadline. */
  overdue: boolean;
  updatedAt: IsoDateTime;
};

/**
 * A proposed replacement for an order's charges, awaiting a decision.
 *
 * Carries both sides deliberately. An approver deciding whether a charge change
 * is right needs to see what the order charges now as well as what is being
 * asked for — a proposed set on its own says nothing about what it would
 * replace.
 */
export type SalesChargeChangeRequestView = {
  id: string;
  status: SalesChangeStatus;
  /** What the order charges today, and will keep charging unless approved. */
  current: SalesChargeView[];
  currentTotal: DecimalString;
  /** What was asked for. */
  proposed: { type: SalesChargeType; label: string | null; amount: DecimalString }[];
  proposedTotal: DecimalString;
  requestedBy: UserRef;
  requestedAt: IsoDateTime;
  reviewedBy: UserRef | null;
  reviewedAt: IsoDateTime | null;
  reviewNote: string | null;
};

/**
 * A proposed change to the order's products.
 *
 * Carries both sides for an EDIT — `current` is the line as it stands right
 * now, `proposed` is what was asked for — so the UI can render CURRENT →
 * PROPOSED without a second lookup, and so a reader can see what a rejected
 * request would have done.
 *
 * None of this is counted anywhere. It is a request, not a product.
 */
export type SalesChangeRequestView = {
  id: string;
  type: SalesChangeType;
  status: SalesChangeStatus;
  /** The line this acts on. Null for ADD, which has no line yet. */
  current: {
    id: string;
    lineNo: number;
    productName: string;
    image: MediaRef | null;
    quantity: number;
    price: DecimalString;
    lineTotal: DecimalString;
  } | null;
  /** What was asked for. Null for REMOVE, which proposes no values. */
  proposed: {
    productName: string;
    image: MediaRef | null;
    quantity: number;
    price: DecimalString;
    lineTotal: DecimalString;
  } | null;
  requestedBy: UserRef;
  requestedAt: IsoDateTime;
  reviewedBy: UserRef | null;
  reviewedAt: IsoDateTime | null;
  reviewNote: string | null;
};

/** The detail payload — everything the details page needs, in one call. */
export type SalesOrderDetail = {
  id: string;
  orderId: string;
  /** Detail carries the contact details; the list row deliberately does not. */
  customer: CustomerContactRef;
  /** The order's actual products, ordered by line number. All are active. */
  items: SalesOrderItemView[];
  /** Proposals against those products: pending first, then decided history. */
  changeRequests: SalesChangeRequestView[];
  /** Proposed changes to the order's charges. Empty for most orders. */
  chargeChangeRequests: SalesChargeChangeRequestView[];
  money: SalesMoneyView;
  status: SalesOrderStatus;
  efficiency: SalesEfficiency | null;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;
  dispatchedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  closedBy: UserRef | null;
  cancelledAt: IsoDateTime | null;
  cancelledBy: UserRef | null;
  cancellationReason: string | null;
  /** Every instalment taken, oldest first. Their sum is money.paid. */
  payments: SalesPaymentView[];
  /** Money owed back, and whether it has gone. Empty for most orders. */
  refunds: SalesRefundView[];
  overdue: boolean;
  createdBy: UserRef;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Order-level charges and adjustments, in the order they were entered. */
  charges: SalesChargeView[];
};
