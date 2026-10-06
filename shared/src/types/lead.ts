/**
 * Response contracts for Create Lead / Deal — Phase 1.
 *
 * These describe what crosses the wire, which is not the Prisma row: DateTime
 * arrives as an ISO string, and the customer travels as the existing
 * `CustomerView` rather than as copied fields, so a lead can never disagree
 * with the Customer master about who somebody is.
 */

import type { LeadChannel, LeadPromptnessRating } from '../constants/index.js';
import type {
  DealStatus,
  DimensionUnit,
  LeadActivityKind,
  LeadSource,
  ProductMatchKind,
  RequirementType,
} from '../enums.js';
import type { CustomerView } from './enquiry.js';
import type {
  DecimalString,
  DimensionView,
  IsoDateTime,
  MediaRef,
  UserRef,
  WeightView,
} from './enquiry.js';

/** How a lead came to its associate. Derived from two ids, never stored. */
export type AllocationKind = 'SELF' | 'OTHER_USER' | 'UNASSIGNED';

/** One expected action on a lead, as the API reports it. */
export type LeadActivityView = {
  id: string;
  kind: LeadActivityKind;
  /** When the action was expected. */
  dueAt: IsoDateTime;
  /** When it happened. Null while outstanding. */
  completedAt: IsoDateTime | null;
  performedBy: UserRef | null;
  note: string | null;
  createdAt: IsoDateTime;
};

/**
 * One associate's promptness on one lead.
 *
 * `score` is null exactly when `rating` is NOT_RATED — either nothing is
 * measurable yet, or there is no associate to attribute it to. The counts are
 * reported either way so a reader can see what the lead holds.
 *
 * Derived on every read. No column anywhere stores any of this.
 */
export type LeadPromptnessView = {
  expected: number;
  onTime: number;
  /**
   * Due and still not done.
   *
   * Not `expected - onTime`: that also counts actions completed late, which are
   * finished work with a bad score rather than work still owed. `promptness()`
   * has always returned this and the analytics row has always declared it —
   * declared here too so the detail read and the board describe one shape.
   */
  overdue: number;
  score: number | null;
  rating: LeadPromptnessRating;
};

/** One lead, as the API reports it. */
export type LeadView = {
  id: string;

  leadSource: LeadSource;
  /** The written name, present only when `leadSource` is OTHER. */
  leadSourceOther: string | null;
  /** Free-text reference for the source. Generic by design — see the schema. */
  sourceDetails: string | null;
  /** When the enquiry happened, which is not when the row was created. */
  sourceAt: IsoDateTime;

  requirementType: RequirementType;

  /** The existing Customer master, never a copy of it. */
  customer: CustomerView;

  channel: LeadChannel;
  channelOther: string | null;

  /** Where the deal ended up. INPROCESS until somebody decides otherwise. */
  dealStatus: DealStatus;

  /** The associate who owns it, and whose promptness it counts toward. */
  associate: UserRef | null;
  /** Who allocated it. With `associate`, this is the whole of `allocation`. */
  allocatedBy: UserRef | null;
  /** SELF, OTHER_USER or UNASSIGNED — derived from the two above. */
  allocation: AllocationKind;

  /**
   * The order this lead became, if it became one.
   *
   * An id, never a copied value: Order Value is read through the order itself,
   * so a charge changing there cannot leave a stale figure here.
   */
  salesOrderId: string | null;

  /**
   * What the linked order is actually worth, or null when there is no order.
   *
   * Derived from the SalesOrder through Sales' own `toMoney`. Null means "this
   * lead has not become an order" — **not** "worth nothing" — and is never a
   * substitute for the requirement figure below.
   */
  orderValue: DecimalString | null;

  /**
   * The sum of the requirement values on this lead — what the customer asked
   * for, as the associate priced it.
   *
   * A different fact from `orderValue` and deliberately so: this is pre-sales
   * information, an estimate against a requirement that may never become an
   * order, and the two can legitimately differ once one exists. Null when no
   * requirement carries a value at all, which is different from a requirement
   * priced at zero.
   *
   * Derived on read by summing `LeadProductRequirement.productValue`. No column
   * stores it, for the same reason none stores order value: a total is free to
   * contradict the rows it came from the moment one of them is edited.
   */
  requirementValue: DecimalString | null;

  /** Derived from the activities below; nothing is stored. */
  promptness: LeadPromptnessView;
  /**
   * The FIRST_CONTACT that happened, if one has.
   *
   * Deliberately separate from the follow-up fields: a first contact counts
   * toward promptness but is never `lastFollowUpAt`, because those two questions
   * are "has this customer been reached at all" and "when were they last chased".
   */
  firstContactAt: IsoDateTime | null;
  /** The latest FOLLOW_UP that actually happened. */
  lastFollowUpAt: IsoDateTime | null;
  /** The earliest incomplete FOLLOW_UP still in the future. */
  nextFollowUpAt: IsoDateTime | null;

  activities: LeadActivityView[];

  /**
   * "Complete the Ideal" — what the customer actually wants, in line order.
   *
   * Carried on the detail read rather than fetched separately, for the same
   * reason the activity timeline is: a page that shows them has already paid for
   * the lead, and a second round trip would buy nothing.
   */
  requirements: LeadRequirementView[];

  createdBy: UserRef;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

// ---------------------------------------------------------------------------
//  Complete the Ideal — Phase 4F
// ---------------------------------------------------------------------------

/**
 * The catalogue product a requirement was matched to, as the UI needs it.
 *
 * Four display fields and nothing else. A requirement names a product; it does
 * not need that product's vendor, its cost price, its Shopify ids or its stock,
 * and a reader of a lead has no business being handed them.
 */
export type RequirementProductRef = {
  id: string;
  title: string;
  /** The first variant's SKU, where the catalogue holds one. */
  sku: string | null;
  /** The catalogue's own image — never the customer's requirement photo. */
  imageUrl: string | null;
};

/**
 * Derived volume.
 *
 * Reported in cubic millimetres alongside the figure in the unit somebody
 * actually typed, because 1000 cm³ and 1,000,000 mm³ are the same box and the
 * first is the one a person recognises.
 *
 * Null — the whole field, not a zero — when any dimension is missing. Zero would
 * claim a flat box; null says the question was not answered.
 */
export type RequirementVolumeView = {
  /** In `unit`, the unit the dimensions were entered in. */
  value: DecimalString;
  unit: DimensionUnit;
  /** Normalised, so two requirements entered in different units compare. */
  inCubicMm: DecimalString;
};

/** One line of what the customer wants, as the API reports it. */
export type LeadRequirementView = {
  id: string;
  lineNo: number;

  /** The customer's own words. Never replaced by the catalogue's title. */
  productName: string;

  /** The associate's uploaded photo of the requirement, if there is one. */
  image: MediaRef | null;

  /** The catalogue product this was matched to, if it was matched. */
  rsProduct: RequirementProductRef | null;
  /** EXACT or SIMILAR. Null exactly when `rsProduct` is null. */
  matchKind: ProductMatchKind | null;

  quantity: number;

  weight: WeightView | null;
  dimension: DimensionView | null;
  /** Derived from `dimension` on every read. No column stores this. */
  volume: RequirementVolumeView | null;

  /** What the customer's requirement is worth. Not the catalogue's price. */
  productValue: DecimalString | null;

  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

/**
 * What a phone lookup found.
 *
 * A list rather than a single customer, deliberately. Phone is meant to be one
 * customer's identifier, but the live data carries duplicates from dummy and
 * historical rows — so the contract admits the possibility and makes the caller
 * handle it, instead of silently returning the first row and linking a lead to
 * the wrong person.
 *
 *   0 matches  the form offers Add Customer
 *   1 match    shown directly, ready to link
 *   2+ matches every one is listed and somebody has to choose
 */
export type LeadCustomerLookupResult = {
  /** The digits the search actually ran on, so the UI can show what it matched. */
  normalizedPhone: string;
  customers: CustomerView[];
};

// ---------------------------------------------------------------------------
//  The analytics table — Phase 4E
// ---------------------------------------------------------------------------

/**
 * One row of the Lead/Deal analytics table.
 *
 * Carries everything the table draws, so a row needs no follow-up request —
 * which is the whole point of the batched read behind it.
 *
 * Deliberately NOT the full `LeadView`: that embeds the whole activity timeline
 * and the complete customer record, and fifty of those is a payload nobody is
 * reading. This is the nine business columns plus what it takes to render them.
 */
export type LeadAnalyticsRow = {
  id: string;

  /** Who the deal is with. Three fields, because the table shows contact too. */
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  };

  dealStatus: DealStatus;

  channel: LeadChannel;
  /** The written name, present only when `channel` is OTHER. */
  channelOther: string | null;

  associate: UserRef | null;
  allocatedBy: UserRef | null;
  /** SELF / OTHER_USER / UNASSIGNED — derived from the two above. */
  allocation: AllocationKind;

  /**
   * What the linked order is worth, as a decimal string.
   *
   * Null means there is no linked order — distinct from '0.00', which is a real
   * order that happens to total nothing. The UI must show those differently.
   *
   * Derived through the same `toMoney` the Sales module uses, never copied onto
   * the lead.
   */
  orderValue: DecimalString | null;

  /**
   * What the customer asked for, summed across this lead's requirements.
   *
   * Shown beside Order Value rather than instead of it: a lead with a ₹20,000
   * requirement and no order is worth reporting as exactly that, and labelling
   * the estimate "Order Value" would claim a sale nobody made. Null when nothing
   * has been priced.
   */
  requirementValue: DecimalString | null;

  salesOrderId: string | null;

  /** When the enquiry happened — `Lead.sourceAt`, not the row's createdAt. */
  initiatedAt: IsoDateTime;
  /** When the lead was recorded, which is often later. */
  createdAt: IsoDateTime;

  /** The FIRST_CONTACT that happened, if one has. */
  firstContactAt: IsoDateTime | null;
  lastFollowUpAt: IsoDateTime | null;
  nextFollowUpAt: IsoDateTime | null;

  /**
   * The same derived shape the detail read reports, `overdue` included — it is
   * the actionable figure an associate scanning the board is looking for.
   */
  promptness: LeadPromptnessView;
};

/**
 * The analytics list, with its page cursor.
 *
 * `narrowedByDerivedFilter` is honest signalling rather than decoration. The
 * promptness, allocation and follow-up filters are computed from rows the
 * database cannot filter on, so when one is in use the page is assembled from a
 * bounded scan and may hold fewer rows than the limit without meaning the list
 * has ended. The flag lets the UI say so instead of implying a short page is the
 * last one.
 */
export type LeadAnalyticsPage = {
  leads: LeadAnalyticsRow[];
  nextCursor: string | null;
  narrowedByDerivedFilter: boolean;
};
