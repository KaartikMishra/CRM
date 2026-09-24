/**
 * Response contracts for the Product Enquiry API.
 *
 * These describe what actually crosses the wire, which is not the Prisma row:
 * `DateTime` arrives as an ISO string and `Decimal` as a decimal string, never
 * a float (§7). The future frontend types against these rather than against
 * the database models, so the two tiers cannot drift.
 */

import type {
  CustomerType,
  DimensionUnit,
  EnquiryEfficiency,
  EnquiryEventType,
  EnquiryProductStatus,
  EnquirySource,
  EnquiryStatus,
  ProductMatchType,
  Role,
  WeightUnit,
} from '../enums.js';

/** ISO-8601 timestamp. */
export type IsoDateTime = string;
/** Exact decimal as a string — never parse this into a number for arithmetic. */
export type DecimalString = string;

export type UserRef = {
  id: string;
  name: string;
  employeeId: string;
  role: Role;
};

export type CustomerRef = {
  id: string;
  name: string;
  /** §3 — customer type belongs to the customer master, not to the product. */
  type: CustomerType;
};

/**
 * The customer plus the two ways to reach them.
 *
 * Kept separate from CustomerRef rather than widening it: a list row needs a
 * name and nothing more, and contact details have no business travelling with
 * every row of a table. Detail payloads use this; summaries keep CustomerRef.
 */
export type CustomerContactRef = CustomerRef & {
  /** The name the invoice is made out to, where it differs from `name`. */
  companyName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /**
   * One of `INDIA_STATES`, or null where it was never recorded.
   *
   * Carried on the detail payload beside the address for the same reason the
   * address is: whoever is looking at one enquiry or one order is the person
   * who needs to know where it is going and how it will be billed. List rows
   * still keep the bare `CustomerRef`.
   */
  state: string | null;
  /** The GSTIN, uppercase, or null where the customer has none. */
  gstNumber: string | null;
  /** One of `COUNTRIES`, or null where it was never recorded. */
  country: string | null;
};

/**
 * The customer as Product Enquiry reports them — identity that may be withheld.
 *
 * Product Enquiry carries two independent capabilities, and this one follows
 * the Raiser half:
 *
 *   Raiser    holds PRODUCT_ENQUIRY CREATE. Took the enquiry, so has to be
 *             able to ring the customer back — sees the name.
 *   Answerer  holds PRODUCT_ENQUIRY EDIT. Sources and prices the goods, which
 *             needs the product lines and not the buyer.
 *
 * Somebody may hold both, in which case they see the name: the capabilities are
 * a union, never a subtraction.
 *
 * `name` is NULLABLE here where `CustomerRef.name` is not. Nulling it — rather
 * than substituting a placeholder string — is what makes the absence visible to
 * the type checker at every render site instead of silently readable.
 *
 * Deliberately separate from `CustomerRef` rather than a widening of it: Sales
 * shows customer identity to everyone who may see an order, and widening the
 * shared type would force that module to handle an absence it never has.
 */
export type EnquiryCustomerRef = {
  id: string;
  /** Null when the viewer may not see customer identity. */
  name: string | null;
  type: CustomerType;
};

/**
 * The same, plus the ways to reach them — detail payloads only.
 *
 * EXACTLY THREE FIELDS ARE WITHHELD from somebody without Raiser access:
 * `name`, `phone` and `email` — who the customer is and how to reach them.
 *
 * Address, state, GST number and customer type are NOT withheld. An Answerer
 * is sourcing and pricing goods, and where they are going and how the sale is
 * taxed are part of that job; who the buyer is is not.
 *
 * All of these are nullable anyway, because any may genuinely be unrecorded.
 */
export type EnquiryCustomerContactRef = EnquiryCustomerRef & {
  /**
   * WITHHELD with the identity, not with the address.
   *
   * A company name says who the buyer is at least as plainly as a personal
   * name does — often more so — so it follows the same capability. Sending
   * it to somebody who may not see `name` would undo the rule rather than
   * extend it.
   */
  companyName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** One of `INDIA_STATES`, or null where it was never recorded. */
  state: string | null;
  /** The GSTIN, uppercase, or null where the customer has none. */
  gstNumber: string | null;
  /** One of `COUNTRIES`. Never withheld — where goods go is not who buys. */
  country: string | null;
};

export type VendorRef = {
  id: string;
  name: string;
};

export type MediaRef = {
  id: string;
  secureUrl: string;
  publicId: string;
};

export type WeightView = {
  value: DecimalString;
  unit: WeightUnit;
  /** Normalised for cross-unit comparison; display uses value + unit. */
  inGrams: DecimalString;
};

export type DimensionView = {
  length: DecimalString;
  width: DecimalString;
  height: DecimalString;
  unit: DimensionUnit;
};

export type VendorResponseView = {
  id: string;
  vendor: VendorRef;
  matchType: ProductMatchType;
  ratePerUnit: DecimalString;
  currency: string;
  deliveryWithinDays: number;
  /** Null when the vendor did not state whether same-day delivery is possible. */
  sameDay: boolean | null;
  deliveryNote: string | null;
  weight: WeightView | null;
  dimension: DimensionView | null;
  image: MediaRef | null;
  notes: string | null;
  createdBy: UserRef;
  createdAt: IsoDateTime;
};

export type EnquiryProductView = {
  id: string;
  lineNo: number;
  name: string;
  quantity: number;
  image: MediaRef | null;
  weight: WeightView | null;
  dimension: DimensionView | null;
  /** §6 — distinct from ProductMatchType; this is the customer's openness. */
  similarOptionNeeded: boolean;
  status: EnquiryProductStatus;
  noVendorReason: string | null;
  vendorResponses: VendorResponseView[];
};

export type EnquiryEventView = {
  id: string;
  type: EnquiryEventType;
  /** Null when the system acted rather than a person. */
  actor: UserRef | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  occurredAt: IsoDateTime;
};

export type DelayRecordView = {
  id: string;
  reason: string;
  deadlineAt: IsoDateTime;
  detectedAt: IsoDateTime;
  minutesLate: number;
  submittedBy: UserRef;
  submittedAt: IsoDateTime;
};

/** SLA state, grouped so the frontend timer reads one object. */
export type EnquirySlaView = {
  slaMinutes: number;
  createdAt: IsoDateTime;
  slaDeadlineAt: IsoDateTime;
  /** §19 — the clock stop. Null while the enquiry is still unanswered. */
  firstSubmitAt: IsoDateTime | null;
  responseSeconds: number | null;
  /** §20 — frozen at first submit and never recalculated. */
  efficiency: EnquiryEfficiency | null;
  /** Derived, not stored: past deadline with nothing submitted yet. */
  breached: boolean;
};

/** The list row (§10) — enough to render a table, no nested collections. */
export type EnquirySummary = {
  id: string;
  enquiryNo: string;
  /** Identity only, and withheld entirely from an Answerer — see the type. */
  customer: EnquiryCustomerRef;
  source: EnquirySource;
  status: EnquiryStatus;
  assignedTo: UserRef;
  createdBy: UserRef;
  productCount: number;
  respondedCount: number;
  sla: EnquirySlaView;
  /** First product image, for the listing thumbnail. */
  thumbnail: MediaRef | null;
  updatedAt: IsoDateTime;
};

/** The detail payload (§11) — everything the detail page needs, in one call. */
export type EnquiryDetail = {
  id: string;
  enquiryNo: string;
  /**
   * Contact details travel with the detail payload, not with list rows: the
   * detail page is where someone decides to ring or write to the customer.
   * Summaries keep the bare identity.
   *
   * Without Raiser access, three of these arrive null — name, phone and email —
   * withheld by the server rather than by the page. Address, state and GST are
   * sent to everybody.
   */
  customer: EnquiryCustomerContactRef;
  source: EnquirySource;
  sourceDetail: string | null;
  status: EnquiryStatus;
  assignedTo: UserRef;
  createdBy: UserRef;
  closedBy: UserRef | null;
  closedAt: IsoDateTime | null;
  partialSubmittedAt: IsoDateTime | null;
  sla: EnquirySlaView;
  products: EnquiryProductView[];
  events: EnquiryEventView[];
  delays: DelayRecordView[];
  updatedAt: IsoDateTime;
};

/** §16 — which lines are still unresolved when Full Submit is refused. */
export type FullSubmitBlocker = {
  lineNo: number;
  name: string;
  status: EnquiryProductStatus;
};

/** The customer master as the picker sees it. */
export type CustomerView = CustomerRef & {
  companyName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** One of `INDIA_STATES`, or null where it was never recorded. */
  state: string | null;
  /** The GSTIN, uppercase, or null where the customer has none. */
  gstNumber: string | null;
  /** One of `COUNTRIES`, or null where it was never recorded. */
  country: string | null;
  createdAt: IsoDateTime;
};

/** The vendor master as the picker sees it. */
export type VendorView = VendorRef & {
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  isActive: boolean;
};
