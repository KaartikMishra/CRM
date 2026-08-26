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
  customer: CustomerRef;
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
  customer: CustomerRef;
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
  phone: string | null;
  email: string | null;
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
