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
  'RS_PRODUCTS',
  'PACKING_DISPATCH',
  'CUSTOMER_BILLING',
  'VENDOR_INVOICE',
  'POST_SALES',
  'LEAD_DEAL',
] as const;
export type AppModule = (typeof APP_MODULES)[number];

/**
 * Where a lead reached us from.
 *
 * Paired with the LeadSource enum in schema.prisma: add a member here and there
 * together, never in one alone. OTHER carries a written name alongside it.
 */
export const LEAD_SOURCES = [
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'ABANDONED_CART',
  'SOCIAL_MEDIA',
  'OTHER',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * What kind of business a lead is asking for.
 *
 * Deliberately not CUSTOMER_TYPES, though the words overlap: that describes who
 * somebody is on the Customer master, while this describes what one enquiry is
 * for. The same retail customer can raise a corporate gifting lead.
 */
export const REQUIREMENT_TYPES = [
  'RETAIL',
  'WHOLESALE',
  'EXPORT_RETAIL',
  'EXPORT_WHOLESALE',
  'CORPORATE_GIFTING',
  'PERSONAL_GIFTING',
] as const;
export type RequirementType = (typeof REQUIREMENT_TYPES)[number];

/**
 * Where a deal ended up.
 *
 * Paired with the DealStatus enum in schema.prisma: add a member here and there
 * together, never in one alone. INPROCESS is the default — a deal nobody has
 * decided has not been lost.
 */
export const DEAL_STATUSES = ['WON', 'LOST', 'INPROCESS'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

/**
 * What one lead activity records.
 *
 * The three stages of the workflow: reaching the customer the first time, each
 * follow-up after that, and the conversation that produced a result.
 */
export const LEAD_ACTIVITY_KINDS = ['FIRST_CONTACT', 'FOLLOW_UP', 'RESULT'] as const;
export type LeadActivityKind = (typeof LEAD_ACTIVITY_KINDS)[number];

/**
 * How closely a catalogue product answers what the customer asked for.
 *
 * Absent — not a third member — when nothing has been matched yet: the match
 * kind is nullable and travels with `rsProductId`, so "unmatched" is the absence
 * of both rather than a value of its own.
 */
export const PRODUCT_MATCH_KINDS = ['EXACT', 'SIMILAR'] as const;
export type ProductMatchKind = (typeof PRODUCT_MATCH_KINDS)[number];

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

/**
 * Where an RS Product came from, and therefore who owns its fields.
 *
 * Sync writes only SHOPIFY rows, so a MANUAL product can never be overwritten
 * or archived by a sync pass.
 */
export const PRODUCT_SOURCES = ['SHOPIFY', 'MANUAL'] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

/** Mirrors Shopify's own product status. A deleted product becomes ARCHIVED. */
export const SHOPIFY_PRODUCT_STATUSES = ['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED'] as const;
export type ShopifyProductStatus = (typeof SHOPIFY_PRODUCT_STATUSES)[number];

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
export const SALES_ORDER_STATUSES = ['OPEN', 'DISPATCHED', 'CLOSED', 'CANCELLED'] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/**
 * Where a refund has got to.
 *
 * PENDING is a decision recorded, not money moved: there is no payment gateway
 * behind this CRM, so COMPLETED means somebody sent the money and named the
 * reference it went out with. Keeping the two apart is the point — an order can
 * be cancelled, its refund agreed, and the customer still be owed.
 */
export const SALES_REFUND_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED'] as const;
export type SalesRefundStatus = (typeof SALES_REFUND_STATUSES)[number];

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

/**
 * Whether a recorded purchase bill has been signed off.
 *
 * A separate axis from PURCHASE_BILL_STATUSES above, which says how much of the
 * goods have arrived and is derived from the lines. A bill can be fully
 * RECEIVED and still PENDING approval; the two never collapse into one value.
 */
export const BILL_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type PurchaseBillStatus = (typeof PURCHASE_BILL_STATUSES)[number];
export type BillApprovalStatus = (typeof BILL_APPROVAL_STATUSES)[number];

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
//  Procurement Clock
// ---------------------------------------------------------------------------

/**
 * The factual result of procuring one order, measured against its deadline.
 *
 * Its own type rather than SalesEfficiency: that one is decided by dispatch and
 * this one by coverage, and the schema already says such verdicts "must stay
 * free to diverge".
 *
 * NOT immutable, and deliberately not described as frozen. It states what
 * happened while the order is covered; if coverage is later lost — an allocation
 * released, an active line added — it is invalidated rather than left standing as
 * a claim that is no longer true. Only the deadline itself never moves.
 */
export const PROCUREMENT_VERDICTS = ['ON_TIME', 'DELAYED'] as const;
export type ProcurementVerdict = (typeof PROCUREMENT_VERDICTS)[number];

/**
 * A delay reason somebody submitted and somebody else decided.
 *
 * One vocabulary shared by both chains — the purchase person's item-level reason
 * and procurement's order-level one — exactly as SalesChangeStatus is shared
 * across two Sales tables. Three states and no way back: a decided reason is a
 * historical fact, and a second attempt is a second reason.
 */
export const DELAY_REASON_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type DelayReasonStatus = (typeof DELAY_REASON_STATUSES)[number];

/**
 * Where one order stands on the procurement clock.
 *
 * Derived, never stored — which is why it is not a Prisma enum. Two of the four
 * are a comparison against the clock right now:
 *
 *   not covered, on or before the deadline   UNFULFILLED
 *   not covered, past the deadline           UNFULFILLED_WITH_DELAY
 *   covered, verdict ON_TIME                 FULFILLED_ON_TIME
 *   covered, verdict DELAYED                 FULFILLED_DELAYED
 *
 * The two delayed outcomes are never merged: one is an order still owed goods
 * and the other is an order that got them late, and a business reads those
 * differently. A cancelled order is not a fifth value here — it carries the
 * order's own SalesOrderStatus, and its clock state is null.
 */
export const PROCUREMENT_CLOCK_STATES = [
  'UNFULFILLED',
  'UNFULFILLED_WITH_DELAY',
  'FULFILLED_ON_TIME',
  'FULFILLED_DELAYED',
] as const;
export type ProcurementClockState = (typeof PROCUREMENT_CLOCK_STATES)[number];

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
export const NOTIFICATION_TYPES = [
  'ENQUIRY_ASSIGNED',
  'SALES_ORDER_CREATED',
  /**
   * Packing & Dispatch asking Procurement whether part of an order may go now,
   * and the four ways that question is answered.
   *
   * AUTO_ALLOWED is deliberately its own type rather than a flag on ALLOWED: a
   * shipment permitted because nobody objected within the deadline is a
   * different event from one somebody agreed to, and the person reading the
   * notice needs to be able to tell them apart at a glance.
   */
  'PARTIAL_DISPATCH_REQUESTED',
  'PARTIAL_DISPATCH_ALLOWED',
  'PARTIAL_DISPATCH_DISALLOWED',
  'PARTIAL_DISPATCH_AUTO_ALLOWED',
  'POST_SALES_CASE_ASSIGNED',
  'POST_SALES_CASE_CRITICAL',
  'POST_SALES_CASE_REOPENED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ---------------------------------------------------------------------------
//  Packing & Dispatch
// ---------------------------------------------------------------------------

/**
 * Where a shipment has reached.
 *
 * DISPATCHED is terminal: goods that have left cannot be un-sent, and the
 * record of what was sent has to stay true. CANCELLED is reachable only before
 * that, for a pack that was started and abandoned.
 */
export const DISPATCH_STATUSES = [
  'DRAFT',
  'PACKING',
  'PACKED',
  'DISPATCHED',
  'CANCELLED',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/**
 * The life of a request to ship part of an order.
 *
 * MOOT is what keeps the record honest: if the rest of the order becomes ready
 * while the request is still waiting, nobody needs to decide it any more — but
 * it was really asked, so it is resolved rather than deleted, and never
 * auto-allowed for a question that no longer applies.
 */
export const PARTIAL_DISPATCH_STATUSES = ['PENDING', 'ALLOWED', 'DISALLOWED', 'MOOT'] as const;
export type PartialDispatchStatus = (typeof PARTIAL_DISPATCH_STATUSES)[number];

// ---------------------------------------------------------------------------
//  Post Sales & Grievance
// ---------------------------------------------------------------------------

/**
 * What a case is about.
 *
 * A classification, and only that. `REFUND` means "this case concerns a refund",
 * never "process a refund" — Phase 1 ships no settlement of any kind, and the
 * money path stays with SalesRefund where it already lives. The same holds for
 * RETURN, REPLACEMENT, EXCHANGE and WARRANTY: naming the subject is not doing
 * the work, and conflating the two is how a case system starts moving goods it
 * was never authorised to move.
 */
export const POST_SALES_CASE_TYPES = [
  'COMPLAINT',
  'RETURN',
  'REPLACEMENT',
  'REFUND',
  'EXCHANGE',
  'WARRANTY',
  'DELIVERY_ISSUE',
  'PRODUCT_QUESTION',
  'BILLING_ISSUE',
  'PAYMENT_ISSUE',
  'FEEDBACK',
  'SUGGESTION',
  'REVIEW_ISSUE',
  'OTHER',
] as const;
export type PostSalesCaseType = (typeof POST_SALES_CASE_TYPES)[number];

/**
 * What actually went wrong, in the business's own words.
 *
 * One flat enum rather than a category/subcategory pair: the grouping below is
 * for the UI's benefit, and a second stored column would be free to disagree
 * with this one. A fixed vocabulary rather than a settings table, deliberately —
 * configurable categories are a later phase, and inventing the table now would
 * mean guessing at its shape.
 */
export const POST_SALES_ISSUE_CATEGORIES = [
  // Product
  'DAMAGED_PRODUCT',
  'MANUFACTURING_DEFECT',
  'FINISH_POLISH_ISSUE',
  'SIZE_ISSUE',
  'WRONG_SIZE',
  'WRONG_PRODUCT',
  'MISSING_PRODUCT',
  'MISSING_PART',
  'QUALITY_CONCERN',
  'LEAKAGE',
  'BREAKAGE',
  'DENT',
  'SCRATCH',
  'COATING_ISSUE',
  'COLOUR_DIFFERENCE',
  'PRODUCT_PERFORMANCE',
  'PRODUCT_USAGE_QUESTION',
  'PRODUCT_CARE_QUESTION',
  // Delivery
  'DELAYED_DELIVERY',
  'DELIVERY_FAILED',
  'WRONG_ADDRESS',
  'COURIER_DAMAGE',
  'PACKAGE_DAMAGED',
  'PACKAGE_MISSING',
  'WRONG_PACKAGE',
  'PARTIAL_DELIVERY',
  'TRACKING_ISSUE',
  // Order
  'WRONG_ITEM',
  'MISSING_ITEM',
  'QUANTITY_ISSUE',
  'ORDER_MODIFICATION',
  'CANCELLATION',
  'BILLING_ISSUE',
  'INVOICE_ISSUE',
  'PAYMENT_ISSUE',
  // Post sales
  'RETURN_REQUEST',
  'REPLACEMENT_REQUEST',
  'REFUND_REQUEST',
  'EXCHANGE_REQUEST',
  'WARRANTY_REQUEST',
  'SERVICE_REQUEST',
  // Customer experience
  'DISSATISFACTION',
  'NEGATIVE_FEEDBACK',
  'SUGGESTION',
  'PRODUCT_FEEDBACK',
  'SERVICE_FEEDBACK',
  // Everything else
  'OTHER',
] as const;
export type PostSalesIssueCategory = (typeof POST_SALES_ISSUE_CATEGORIES)[number];

/**
 * How urgent a case is, as a person judged it.
 *
 * Set by hand and changed by hand. Phase 1 derives nothing from order value, VIP
 * status or the words in a complaint — automatic escalation is a later phase, and
 * a rule invented now is one the business has to work around later.
 */
export const POST_SALES_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type PostSalesPriority = (typeof POST_SALES_PRIORITIES)[number];

/**
 * Where a case stands.
 *
 * The four AWAITING_* states name who the case is blocked on, which is the thing
 * somebody scanning a board actually needs: a case waiting on a courier is not
 * the same work as one waiting on the customer. They carry no timer — SLA and its
 * pause states are a later phase, and "overdue" is deliberately NOT a status
 * here, because it is a fact about a clock rather than about the case.
 *
 * REOPENED is its own state rather than a return to IN_PROGRESS, so a case that
 * came back is visibly distinguishable from one that never closed.
 */
export const POST_SALES_CASE_STATUSES = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER',
  'AWAITING_INTERNAL',
  'AWAITING_VENDOR',
  'AWAITING_COURIER',
  'RESOLUTION_IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
] as const;
export type PostSalesCaseStatus = (typeof POST_SALES_CASE_STATUSES)[number];

/**
 * What one entry on the case timeline is.
 *
 * One table discriminated by this, rather than separate tables for notes,
 * internal notes, communications and follow-ups: they share every field that
 * matters and differ only in who may read them and whether they carry a deadline.
 * Four tables would mean four queries to draw one timeline.
 *
 * SYSTEM, STATUS_CHANGE and ASSIGNMENT_CHANGE are written by the service, never
 * by a caller — which is why `performedById` is nullable.
 */
export const POST_SALES_ACTIVITY_KINDS = [
  'SYSTEM',
  'NOTE',
  'INTERNAL_NOTE',
  'CUSTOMER_COMMUNICATION',
  'FOLLOW_UP',
  'STATUS_CHANGE',
  'ASSIGNMENT_CHANGE',
] as const;
export type PostSalesActivityKind = (typeof POST_SALES_ACTIVITY_KINDS)[number];

/**
 * How a conversation with the customer happened.
 *
 * A record of what took place, not a sending mechanism. Phase 1 integrates no
 * WhatsApp, email or SMS API and does not pretend to: an activity of this kind
 * says somebody made a call or sent a message, written down afterwards by the
 * person who did it.
 */
export const POST_SALES_COMMUNICATION_CHANNELS = [
  'PHONE',
  'WHATSAPP',
  'EMAIL',
  'SMS',
  'WEBSITE',
  'INSTAGRAM',
  'FACEBOOK',
  'MARKETPLACE',
  'IN_PERSON',
  'INTERNAL',
] as const;
export type PostSalesCommunicationChannel =
  (typeof POST_SALES_COMMUNICATION_CHANNELS)[number];

/** Which way a logged communication went. */
export const POST_SALES_COMMUNICATION_DIRECTIONS = ['INCOMING', 'OUTGOING'] as const;
export type PostSalesCommunicationDirection =
  (typeof POST_SALES_COMMUNICATION_DIRECTIONS)[number];

/**
 * What a case attachment shows.
 *
 * Phase 1 accepts only what the existing uploader accepts — JPEG, PNG, WebP and
 * GIF, at the configured size cap. PDF and video are genuinely needed by the
 * business requirement and are genuinely not supported today; widening the shared
 * upload path touches four other modules, so it is a deliberate decision rather
 * than a detail of this phase.
 */
export const POST_SALES_ATTACHMENT_KINDS = [
  'PRODUCT_PHOTO',
  'PACKAGING_PHOTO',
  'SCREENSHOT',
  'PAYMENT_PROOF',
  'DELIVERY_PROOF',
  'OTHER',
] as const;
export type PostSalesAttachmentKind = (typeof POST_SALES_ATTACHMENT_KINDS)[number];
