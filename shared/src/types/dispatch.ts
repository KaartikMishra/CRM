/**
 * Response contracts for the Packing & Dispatch API.
 *
 * These describe what crosses the wire, which is not the Prisma row: DateTime
 * arrives as an ISO string, and the readiness figures are computed per request
 * rather than stored. The frontend types against these rather than against the
 * database models, so the two tiers cannot drift.
 */

import type {
  DispatchCarrier,
  DispatchChannel,
} from '../constants/index.js';
import type { DispatchStatus, PartialDispatchStatus, FulfillmentStatus } from '../enums.js';
import type {
  CustomerContactRef,
  DecimalString,
  IsoDateTime,
  MediaRef,
  UserRef,
} from './enquiry.js';

/**
 * How ready one order line is to be sent.
 *
 * Derived on every read from the line's own quantities and its allocations —
 * never stored. A stored copy could disagree with the rows it summarises, and
 * the shortage board computes the same figures from the same source.
 */
export type DispatchReadinessLine = {
  salesOrderItemId: string;
  lineNo: number;
  productName: string;
  image: MediaRef | null;

  /**
   * The catalogue SKU, when the line is mapped to an RS Product.
   *
   * Null for a free-text line that names no product, and null for a mapped
   * product whose variant carries no SKU — both are real states in the data and
   * neither is filled in with a placeholder, because a fabricated SKU is worse
   * than a blank one to somebody picking goods off a shelf.
   *
   * Read from the product's first variant by position. Order lines map at
   * product level, not variant level (`SalesOrderItem.rsProductId`), so there is
   * no variant on the line to read — the first is the representative one.
   */
  sku: string | null;

  /** What was ordered, less anything the customer called off. */
  requiredQty: number;
  /** Supplied by hand plus allocated from purchases. */
  readyQty: number;
  /** What is still to come: max(0, required − ready). */
  pendingQty: number;
  /** Units already sent on earlier shipments of this order. */
  dispatchedQty: number;

  status: FulfillmentStatus;
};

/**
 * Whether an order can be sent, and what is stopping it.
 *
 * `blockers` is the list of hard refusals — a missing delivery address, a
 * missing phone — and `warnings` the things worth saying that do not stop the
 * goods, such as a customer with no email on file. Keeping them apart is what
 * lets the UI show both without implying the second kind blocks anything.
 */
export type DispatchReadiness = {
  salesOrderId: string;
  orderId: string;
  /** Every line is FULFILLED: the whole order can go. */
  fullyReady: boolean;
  /** Some lines ready, some not — the partial-dispatch case. */
  partiallyReady: boolean;
  lines: DispatchReadinessLine[];
  blockers: string[];
  warnings: string[];
};

/** One line of one shipment. */
export type DispatchItemView = {
  id: string;
  salesOrderItemId: string;
  lineNo: number;
  productName: string;
  image: MediaRef | null;
  quantity: number;
};

/** One shipment, as the API reports it. */
export type DispatchView = {
  id: string;
  salesOrderId: string;
  orderId: string;
  status: DispatchStatus;
  /** True when this shipment deliberately carries less than the whole order. */
  isPartial: boolean;

  channel: DispatchChannel | null;
  /** The written name, present only when `channel` is OTHER. */
  channelOther: string | null;
  carrier: DispatchCarrier | null;
  carrierOther: string | null;
  awb: string | null;

  items: DispatchItemView[];

  packedBy: UserRef | null;
  packedAt: IsoDateTime | null;
  dispatchedBy: UserRef | null;
  dispatchedAt: IsoDateTime | null;
  createdBy: UserRef;
  createdAt: IsoDateTime;
};

/**
 * A request to send part of an order, and how it was answered.
 *
 * Four states, and the difference between two of them matters on screen:
 * `autoDecided` is true only when the deadline passed with no answer, and in
 * that case `reason` is null and `decidedBy` is null — because nobody decided
 * it, and naming somebody would be a fabrication. MOOT means the rest of the
 * order became ready and the question stopped applying.
 */
export type PartialDispatchRequestView = {
  id: string;
  salesOrderId: string;
  orderId: string;
  status: PartialDispatchStatus;

  requestedBy: UserRef;
  requestedAt: IsoDateTime;
  /** When the answer stops being awaited. */
  deadline: IsoDateTime;

  decidedBy: UserRef | null;
  decidedAt: IsoDateTime | null;
  reason: string | null;
  poa: string | null;

  /** Allowed by the deadline rather than by a person. */
  autoDecided: boolean;
};

/**
 * One open question, as Procurement's decision queue shows it.
 *
 * The request itself plus the context somebody needs to answer it without
 * opening another screen: whose order it is, and how much of it is actually
 * ready. Procurement is deciding whether goods should wait for the rest, and
 * "6 of 12 ready" is the fact that decision turns on.
 *
 * The quantities are summed from the same derived readiness the dispatch board
 * uses — never stored, never recomputed by a second rule.
 */
export type PendingPartialDispatchRow = {
  request: PartialDispatchRequestView;

  orderId: string;
  customerName: string;
  /** When the whole order was promised to the customer. */
  toBeDispatchedBy: IsoDateTime;

  /** Units owed across the order, after cancellations. */
  requiredQty: number;
  /** Units ready now — supplied by hand plus allocated from purchases. */
  readyQty: number;
  /** Units still to come. */
  pendingQty: number;
  /** How many of the order's lines are completely covered. */
  readyLines: number;
  totalLines: number;
};

/** A row on the dispatch board. */
export type DispatchSummary = {
  salesOrderId: string;
  orderId: string;
  customerName: string;
  /**
   * The three contact fields a dispatcher needs before a parcel can leave.
   *
   * On the board as well as the detail because they decide whether an order is
   * workable at all: a missing address or phone is a hard blocker at dispatch,
   * and seeing that on the row saves opening an order that cannot go. Null
   * where the customer record has nothing — never an empty string, so "not
   * recorded" and "recorded as blank" stay distinguishable.
   *
   * Deliberately only these three. The rest of the customer record — GST
   * number, company, billing state — is not a dispatcher's business and is not
   * put on a list endpoint.
   */
  customerPhone: string | null;
  customerEmail: string | null;
  customerAddress: string | null;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;

  fullyReady: boolean;
  partiallyReady: boolean;
  /**
   * How many lines are *completely* covered, out of how many the order has.
   *
   * Worth reading carefully: a line counts here only when nothing is still
   * owed on it, so an order with seven of ten units ready contributes zero.
   * That is why `dispatchableQty` exists beside it — the two answer different
   * questions, and the board shows the second because it is the one that says
   * whether there is work to do.
   */
  readyLines: number;
  totalLines: number;
  /**
   * Units that could go in a parcel right now, across every line.
   *
   * The actionable figure. `readyLines` can be 0 on an order with goods
   * waiting to ship, which reads as "nothing to do" when the opposite is true.
   */
  dispatchableQty: number;

  /** The most recent shipment's state, or null before any pack is started. */
  latestDispatchStatus: DispatchStatus | null;
  /** An undecided request, when one is outstanding. */
  pendingPartialRequest: PartialDispatchRequestView | null;
};

/**
 * One order's full dispatch picture.
 *
 * Carries the customer's contact details because that is what the person
 * packing the parcel needs in front of them — the name, the address to write on
 * it, and a number to call if the courier cannot find it.
 */
export type DispatchDetail = {
  salesOrderId: string;
  orderId: string;
  customer: CustomerContactRef;
  orderDate: IsoDateTime;
  toBeDispatchedBy: IsoDateTime;

  /** Shown for context. Dispatch does not gate on payment. */
  orderTotal: DecimalString;
  paidAmount: DecimalString;

  readiness: DispatchReadiness;
  dispatches: DispatchView[];
  partialRequests: PartialDispatchRequestView[];
};
