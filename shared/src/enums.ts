/**
 * Single source of truth for every enum in the system.
 *
 * Prisma declares matching enums with identical member names; the seed and the
 * service layer rely on that alignment. Add a member here and in schema.prisma
 * together, never in one alone.
 */

export const ROLES = ['ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export const APP_MODULES = [
  'PRODUCT_ENQUIRY',
  'SALES',
  'PROCUREMENT',
  'PACKING_DISPATCH',
  'CUSTOMER_BILLING',
  'VENDOR_INVOICE',
  'POST_SALES',
] as const;
export type AppModule = (typeof APP_MODULES)[number];

export const PERMISSION_ACTIONS = ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'ASSIGN'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** §15 — customer type sits on the customer, not the enquiry line (Q1). */
export const CUSTOMER_TYPES = ['RETAIL', 'BULK', 'WEDDING_GIFTING', 'CORPORATE_GIFTING'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** §17 — OTHERS requires sourceDetail; enforced by Zod and a DB CHECK. */
export const ENQUIRY_SOURCES = [
  'WHATSAPP',
  'EMAIL',
  'CALL',
  'WEBSITE',
  'INDIAMART',
  'OTHERS',
] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];

/** §27 — coverage status. Time state is tracked separately by the SLA fields. */
export const ENQUIRY_STATUSES = ['OPEN', 'PARTIAL_CLOSED', 'CLOSED'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** §29 — frozen once at first submit, never recalculated. */
export const ENQUIRY_EFFICIENCIES = ['ON_TIME', 'DELAYED'] as const;
export type EnquiryEfficiency = (typeof ENQUIRY_EFFICIENCIES)[number];

/** Q3 — NO_VENDOR is what makes Full Submit reachable without a vendor. */
export const ENQUIRY_PRODUCT_STATUSES = ['PENDING', 'RESPONDED', 'NO_VENDOR'] as const;
export type EnquiryProductStatus = (typeof ENQUIRY_PRODUCT_STATUSES)[number];

export const WEIGHT_UNITS = ['G', 'KG', 'LB'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export const DIMENSION_UNITS = ['MM', 'CM', 'IN', 'FT'] as const;
export type DimensionUnit = (typeof DIMENSION_UNITS)[number];

/**
 * §38 — how a vendor's offering relates to the product the customer asked for.
 *
 * SIMILAR_PRODUCT stays first so it remains the backward-compatible default for
 * the responses recorded before EXACT_PRODUCT existed.
 */
export const PRODUCT_MATCH_TYPES = ['SIMILAR_PRODUCT', 'EXACT_PRODUCT'] as const;
export type ProductMatchType = (typeof PRODUCT_MATCH_TYPES)[number];

/**
 * The Sales Order lifecycle — deliberately linear.
 *
 * An order is dispatched before it is closed, so every closed order carries a
 * frozen efficiency verdict. There is no reopen.
 */
export const SALES_ORDER_STATUSES = ['OPEN', 'DISPATCHED', 'CLOSED'] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/**
 * The dispatch verdict, frozen when the order is dispatched.
 *
 * Structurally identical to EnquiryEfficiency but a separate type: the two are
 * decided by different events, and collapsing them would couple the SLA clock
 * to the dispatch deadline.
 */
export const SALES_EFFICIENCIES = ['ON_TIME', 'DELAYED'] as const;
export type SalesEfficiency = (typeof SALES_EFFICIENCIES)[number];

/**
 * Whether a product line counts toward its order.
 *
 * A line proposed during editing by someone without approval rights waits as
 * PENDING_APPROVAL and is excluded from every total, so a proposal cannot move
 * money on its own.
 */
export const SALES_ITEM_STATUSES = ['ACTIVE', 'PENDING_APPROVAL'] as const;
export type SalesItemStatus = (typeof SALES_ITEM_STATUSES)[number];

/** What a product change request is asking for. */
export const SALES_CHANGE_TYPES = ['ADD', 'EDIT', 'REMOVE'] as const;
export type SalesChangeType = (typeof SALES_CHANGE_TYPES)[number];

/**
 * A request is decided once and the decision is kept.
 *
 * REJECTED lives here rather than on the item, because rejecting a proposal
 * says nothing about the product already on the order — that line was never
 * touched.
 */
export const SALES_CHANGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SalesChangeStatus = (typeof SALES_CHANGE_STATUSES)[number];

/** §44 — the Efficiency History event vocabulary. */
export const ENQUIRY_EVENT_TYPES = [
  'CREATED',
  'ASSIGNED',
  'REASSIGNED',
  'PRODUCT_ADDED',
  'PRODUCT_UPDATED',
  'PRODUCT_REMOVED',
  'VENDOR_RESPONSE_ADDED',
  'VENDOR_RESPONSE_UPDATED',
  'DEADLINE_BREACHED',
  'DELAY_REASON_SUBMITTED',
  'PARTIAL_SUBMITTED',
  'FULL_SUBMITTED',
  'CLOSED',
  'REOPENED',
] as const;
export type EnquiryEventType = (typeof ENQUIRY_EVENT_TYPES)[number];

/** Whether a purchase bill is on credit or was settled at purchase. */
export const PURCHASE_BILL_TYPES = ['CREDIT', 'PAID_UP'] as const;
export type PurchaseBillType = (typeof PURCHASE_BILL_TYPES)[number];

/**
 * A purchase bill's progress. Linear, like the Sales lifecycle: goods are
 * received before the bill is closed, and there is no reopen.
 */
export const PURCHASE_BILL_STATUSES = ['OPEN', 'RECEIVED', 'CLOSED'] as const;
export type PurchaseBillStatus = (typeof PURCHASE_BILL_STATUSES)[number];

/**
 * How far an order line's requirement has been met.
 *
 * Derived, never stored: it is a comparison between the quantity ordered and
 * what inventory and procurement have supplied, so storing it would create a
 * second answer that could drift from the arithmetic.
 */
export const FULFILLMENT_STATUSES = ['UNFULFILLED', 'PARTIAL', 'FULFILLED'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
//  Notifications
// ---------------------------------------------------------------------------

/**
 * What a notification is about.
 *
 * One shared list rather than a type per module: the recipient's bell treats
 * them identically, and splitting them would only push the union back together
 * at every call site.
 */
export const NOTIFICATION_TYPES = ['ENQUIRY_ASSIGNED', 'SALES_ORDER_CREATED'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
