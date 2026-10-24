/**
 * What the All Customers API returns.
 *
 * Money is always a decimal string, never a number: these figures come from
 * Sales' own `toMoney`, which works in fixed-point strings precisely so a
 * binary float can never round somebody's invoice. Turning them into numbers
 * here would undo that. Counts are numbers because they count things, and dates
 * are ISO strings, matching the rest of the CRM.
 */

import type { Attribution } from '../utils/customer-attribution.js';
import type { CustomerType } from '../enums.js';

/** One row of the directory. */
export type CustomerDirectoryRow = {
  id: string;
  name: string;
  companyName: string | null;
  type: CustomerType;
  phone: string | null;
  email: string | null;
  state: string | null;
  country: string | null;

  firstTouch: Attribution;
  lastTouch: Attribution;

  /** Orders that count as purchases — every status except CANCELLED. */
  validOrderCount: number;
  /** Σ activeTotal less completed refunds. INR, like every CRM money figure. */
  verifiedPurchaseValue: string;
  /** Null when there are no valid orders, never a misleading '0.00'. */
  averageOrderValue: string | null;
  isRepeatCustomer: boolean;
  lastPurchaseAt: string | null;
  lastEnquiryAt: string | null;

  /**
   * Whether this customer appears in an open duplicate suggestion.
   *
   * A flag, not a verdict: it means a pair is waiting for somebody to look at
   * it. Nothing has been merged and no record has been changed.
   */
  hasDuplicateCandidate: boolean;

  createdAt: string;
};

export type CustomerDirectoryPage = {
  customers: CustomerDirectoryRow[];
  /**
   * Which pagination the server actually used.
   *
   * A column sort pages by keyset; an aggregate sort cannot, because no column
   * holds the value being ordered. Saying so explicitly beats returning a
   * cursor the caller cannot rely on.
   */
  pagination:
    | { mode: 'keyset'; nextCursor: string | null }
    | { mode: 'offset'; page: number; totalPages: number; total: number };
};

/** The profile header: identity plus everything derived about the journey. */
export type CustomerProfile = {
  id: string;
  name: string;
  companyName: string | null;
  type: CustomerType;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  country: string | null;
  gstNumber: string | null;
  createdAt: string;
  updatedAt: string;

  firstTouch: Attribution;
  lastTouch: Attribution;

  purchase: {
    validOrderCount: number;
    cancelledOrderCount: number;
    paidOrderCount: number;
    verifiedPurchaseValue: string;
    grossPurchaseValue: string;
    refundedValue: string;
    /** Promised, not yet settled. Deliberately outside the verified total. */
    pendingRefundValue: string;
    averageOrderValue: string | null;
    isRepeatCustomer: boolean;
    firstPurchaseAt: string | null;
    lastPurchaseAt: string | null;
    /** Always 'INR'. The CRM's money is INR throughout; Shopify's is separate. */
    currency: string;
  };

  conversion: {
    leadCount: number;
    convertedLeadCount: number;
    /** Kept apart from convertedLeadCount: the two can legitimately disagree. */
    wonLeadCount: number;
    conversionRate: number | null;
  };

  enquiryCount: number;
  lastEnquiryAt: string | null;

  /**
   * Who is responsible, per record.
   *
   * A list, never one "primary owner". Assignment lives on the enquiry and the
   * lead, and a customer can legitimately have records held by different
   * colleagues; electing one of them as the customer's owner would invent a
   * relationship the schema does not record.
   */
  assignees: { userId: string; name: string; employeeId: string; recordCount: number }[];

  hasDuplicateCandidate: boolean;
};

/** One of the customer's orders, as the profile lists it. */
export type CustomerOrderRow = {
  /** The cuid primary key, for links. */
  id: string;
  /** `SalesOrder.orderId` — the customer-facing reference, unique. */
  orderId: string;
  /** SalesOrder.orderDate — the business date, not the row's creation time. */
  orderDate: string;
  status: 'OPEN' | 'DISPATCHED' | 'CLOSED' | 'CANCELLED';
  /** From toMoney: cancelled quantities netted out, '0.00' when cancelled. */
  activeTotal: string;
  /** The ordered value before cancellations, for context beside activeTotal. */
  total: string;
  paid: string;
  refunded: string;
  refundPending: string;
  fullyPaid: boolean;
  itemCount: number;
};

export type CustomerEnquiryRow = {
  enquiryId: string;
  enquiryNo: string;
  source: string;
  sourceDetail: string | null;
  status: 'OPEN' | 'PARTIAL_CLOSED' | 'CLOSED';
  assignedTo: { userId: string; name: string } | null;
  productCount: number;
  createdAt: string;
};

export type CustomerLeadRow = {
  leadId: string;
  leadSource: string;
  leadSourceOther: string | null;
  channel: string;
  channelOther: string | null;
  requirementType: string;
  dealStatus: 'WON' | 'LOST' | 'INPROCESS';
  /** Null when the lead produced no order. */
  salesOrderId: string | null;
  /** True only when a linked order exists and is not cancelled. */
  isConverted: boolean;
  /**
   * The lead's owner — its `associate`, which is what the Lead model calls it.
   * Null is a real state: an unassigned lead, and every row predating the column.
   */
  associate: { userId: string; name: string } | null;
  sourceAt: string;
  createdAt: string;
};

/** A page of one customer's related records. */
export type CustomerHistoryPage<T> = {
  rows: T[];
  nextCursor: string | null;
};

/**
 * The merged timeline, with an honest statement of its own completeness.
 *
 * Each source is capped, so a customer with a very long history has older
 * entries of one kind omitted. `truncated` names those sources rather than
 * letting a partial view read as a full one — "no activity recorded" and "more
 * activity than this view shows" are different answers.
 */
export type CustomerTimelinePage = {
  entries: CustomerTimelineEntry[];
  truncated: string[];
};

/** One entry on the merged journey. */
export type CustomerTimelineEntry = {
  id: string;
  kind:
    | 'ENQUIRY_RAISED'
    | 'ENQUIRY_EVENT'
    | 'LEAD_CAPTURED'
    | 'LEAD_ACTIVITY'
    | 'ORDER_PLACED'
    | 'ORDER_CANCELLED'
    | 'PAYMENT_RECORDED'
    | 'REFUND_RECORDED'
    | 'DISPATCH_RECORDED'
    | 'POST_SALES_CASE';
  at: string;
  summary: string;
  /** Null for a system-generated entry with no recorded actor. */
  actor: { userId: string; name: string } | null;
  /** Where to navigate, when the entry has a destination. */
  href: string | null;
};

/** One pair awaiting or carrying a review decision. */
export type CustomerDuplicateCandidateView = {
  id: string;
  score: number;
  matchedOn: string;
  status: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED';
  customerA: DuplicateSideView;
  customerB: DuplicateSideView;
  decidedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
  createdAt: string;
};

/**
 * One side of a pair, with enough context to judge it.
 *
 * The record counts are the point: deciding whether two rows are one customer
 * means knowing what hangs off each of them. A row with eleven orders and one
 * with none are not interchangeable, whatever their phone numbers say.
 */
export type DuplicateSideView = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  gstNumber: string | null;
  state: string | null;
  orderCount: number;
  enquiryCount: number;
  leadCount: number;
  createdAt: string;
};

/** The directory-wide figures, for the header and source performance. */
export type CustomerAnalytics = {
  totalCustomers: number;
  customersWithOrders: number;
  repeatCustomers: number;
  /** Σ verified purchase value across every customer. INR. */
  totalVerifiedValue: string;
  /** Null when no customer has a valid order. */
  averageCustomerValue: string | null;
  openDuplicateCandidates: number;
  /**
   * Performance by acquisition source, first-touch and last-touch reported
   * separately because they answer different questions: which channel found
   * the customer, and which one last brought them back.
   */
  bySource: {
    source: string;
    touch: 'FIRST' | 'LAST';
    customerCount: number;
    customersWithOrders: number;
    verifiedValue: string;
    convertedLeadCount: number;
    leadCount: number;
  }[];
};
