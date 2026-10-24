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
  /*
    All Customers — the CRM customer directory.

    A namespace of its own rather than a reuse of PRODUCT_ENQUIRY, which is what
    currently gates customer creation. The two are different grants: the people
    who may raise an enquiry are not necessarily the people who may read every
    customer's purchase history, phone number and GSTIN. Folding the directory
    into PRODUCT_ENQUIRY would hand that history to everyone who can file an
    enquiry, which is exactly the conflation these namespaces exist to prevent.

    The existing customer picker keeps its own gating, so this changes nothing
    about who can attach a customer to an enquiry, lead or order.
  */
  'CUSTOMERS',
  // --- HR & Workforce Management -------------------------------------------
  //
  // Seven namespaces rather than one HR module, because HR is the first area
  // where the people who may do one thing must not be able to do another: the
  // manager who approves leave has no business reading salaries, and the
  // recruiter has no business reading appraisals. A single HR grant would make
  // every one of those the same grant.
  //
  // Registered here before any HR page exists. That is deliberate and is now an
  // asserted property rather than an accident — see HR_MODULES below and the
  // navigation test: an AppModule is a permission namespace, and a namespace
  // may exist before the screen that uses it. Phase 0.5 ships the vocabulary so
  // Phase 1 can be built against a permission model that is already real.
  'HR_EMPLOYEE',
  'HR_ATTENDANCE',
  'HR_LEAVE',
  'HR_PAYROLL',
  'HR_RECRUITMENT',
  'HR_PERFORMANCE',
  'HR_ADMIN',
  /*
    Training & Learning Management, Phase 4.

    A namespace of its own rather than a reuse of HR_PERFORMANCE, and that is the
    access model rather than tidiness: a trainer who builds a course and signs off a
    practical has no business reading appraisals, and an appraiser has no reason to
    edit the catalogue. Folding them together would recreate exactly the conflation
    these namespaces exist to prevent — and could not be undone later without
    re-granting every user.
  */
  'HR_TRAINING',
] as const;
export type AppModule = (typeof APP_MODULES)[number];

/**
 * The HR namespaces, named as a set so code and tests can speak about them.
 *
 * Every member is an AppModule — `satisfies` proves it, so a typo here is a
 * compile error rather than a module that silently gates nothing.
 */
export const HR_MODULES = [
  'HR_EMPLOYEE',
  'HR_ATTENDANCE',
  'HR_LEAVE',
  'HR_PAYROLL',
  'HR_RECRUITMENT',
  'HR_PERFORMANCE',
  'HR_ADMIN',
  'HR_TRAINING',
] as const satisfies readonly AppModule[];
export type HrModule = (typeof HR_MODULES)[number];

/**
 * Modules deliberately registered without navigation, and why.
 *
 * The navigation test asserts this list exactly, so a module cannot sit here
 * unnoticed: either it gets a page and leaves this list, or its absence is a
 * recorded decision. Without it, "no nav item" and "forgot the nav item" would
 * be indistinguishable.
 */
export const MODULES_WITHOUT_NAVIGATION = [
  /*
    HR_EMPLOYEE left this list in Phase 1, which is the point of the list existing:
    it now has pages — the employee directory and profile — so a namespace with no
    screen remains only ever a deliberate entry here.

    HR_ADMIN stays, and that is a real decision rather than an oversight. It governs
    the department and designation masters, which do have pages, but no *sidebar
    row*: they are reached from the HR overview, because the navigation table's own
    invariant requires every child to share its parent's module and HR_ADMIN is a
    different grant from HR_EMPLOYEE. Giving the masters a top-level row would put
    structural administration beside the directory and imply one grant covers both.

    HR_ATTENDANCE and HR_LEAVE stayed through Phase 2, and HR_RECRUITMENT stays
    through Phase 3, despite all three now having working pages. That is not an
    oversight: this list tracks **top-level** navigation, and all of those are
    *children* of the HR row. The same is true of HR_ADMIN's masters.

    So "no navigation" here means "no sidebar row of its own", which is the thing
    worth asserting — a module with no top-level row is reachable only through its
    parent, and that should be a recorded decision rather than something somebody
    notices later.

    HR_TRAINING joins them in Phase 4, with the same justification: Training is a
    child row under HR & Workforce, not a top-level entry.

    HR_PERFORMANCE joined them in Phase 5 on the same child-row basis. As of Phase 5
    every member of this list has working pages: the list now records only "reachable
    through its parent, not from a top-level row", which is its durable meaning.
    Registrations are kept regardless so an administrator's grant matrix stays stable
    across phases rather than growing a column each time a module ships.
  */
  'HR_ADMIN',
  'HR_ATTENDANCE',
  'HR_LEAVE',
  'HR_PAYROLL',
  'HR_RECRUITMENT',
  'HR_PERFORMANCE',
  /*
    HR_TRAINING joins this list in Phase 4 *despite* having pages, for the same
    reason HR_ATTENDANCE and HR_RECRUITMENT are here: Training is a child row under
    HR & Workforce, and this list tracks top-level navigation. A namespace reachable
    only through its parent should be a recorded decision rather than something
    somebody notices later.
  */
  'HR_TRAINING',
] as const satisfies readonly AppModule[];

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

/**
 * What somebody may do to a module.
 *
 * The first five are the original vocabulary and their meaning is unchanged.
 * The last three arrive with HR, and arrive **denied**: no existing module
 * grants any of them to anybody, by role default or by the grant UI, so the
 * nine shipped modules keep exactly the effective permissions they had before
 * these values existed. They are granted only where something explicitly needs
 * them.
 *
 *   APPROVE  deciding somebody else's request — the thing requiresApproval()
 *            could previously only answer with "are you an administrator".
 *   EXPORT   taking data out of the system. Separate from VIEW because reading
 *            one payslip on screen and downloading the payroll register are
 *            different risks, and only the second leaves the building.
 *   SELF     acting on one's own record only. The narrowest action there is:
 *            an employee applying for their own leave holds SELF on HR_LEAVE
 *            and nothing else, so the same endpoint serves them and their
 *            manager without a second route or a second table.
 */
export const PERMISSION_ACTIONS = [
  'VIEW',
  'CREATE',
  'EDIT',
  'DELETE',
  'ASSIGN',
  'APPROVE',
  'EXPORT',
  'SELF',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * The original five, kept nameable.
 *
 * `ActionSet` is a Partial, so adding the three above compiled without touching
 * one existing entry — which is precisely the danger: a set literally named ALL
 * would have gone on claiming to be all while silently excluding them. This is
 * what that constant is now called instead, and the name is the documentation.
 */
export const CRUD_ASSIGN_ACTIONS = [
  'VIEW',
  'CREATE',
  'EDIT',
  'DELETE',
  'ASSIGN',
] as const satisfies readonly PermissionAction[];

// ---------------------------------------------------------------------------
//  Cross-cutting foundation — approvals, settings, secure documents
// ---------------------------------------------------------------------------

/**
 * Where one approval request stands. PENDING is the only state that can change.
 *
 * CANCELLED exists so a requester can withdraw. Deleting the row would destroy
 * the evidence that the request was ever made, and a withdrawn request is a
 * historical fact like any other decision — it is grouped with PENDING by the
 * database's consistency CHECK, because withdrawing is not deciding and so
 * carries no decider.
 */
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The two states an approver can put a request into. */
export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * What a secure document is, so access can be decided by kind.
 *
 * Every member is something that must not be publicly fetchable — which is the
 * whole reason SecureDocument exists beside MediaAsset rather than inside it.
 * Deliberately short and HR-shaped; this is not a general file taxonomy.
 */
export const SECURE_DOCUMENT_KINDS = [
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'EDUCATION_CERTIFICATE',
  'EXPERIENCE_LETTER',
  'OFFER_LETTER',
  'APPOINTMENT_LETTER',
  'CONTRACT',
  'PAYSLIP',
  'TAX_DOCUMENT',
  'BANK_DETAIL',
  'MEDICAL_RECORD',
  'DISCIPLINARY_RECORD',
  'APPRAISAL',
  'RESUME',
  'OTHER',
] as const;
export type SecureDocumentKind = (typeof SECURE_DOCUMENT_KINDS)[number];

/**
 * Cloudinary's two non-public delivery types.
 *
 * Paired with the secure_document_delivery_type CHECK. 'upload' — Cloudinary's
 * public default, and what every MediaAsset uses — is deliberately absent: a
 * SecureDocument delivered publicly is the one failure this table exists to
 * prevent, so the value that would cause it is not expressible.
 */
export const SECURE_DELIVERY_TYPES = ['authenticated', 'private'] as const;
export type SecureDeliveryType = (typeof SECURE_DELIVERY_TYPES)[number];

/**
 * Whose a secure document is.
 *
 * Polymorphic until Employee exists in Phase 1, which is why this is a named set
 * rather than a free string: 'User' is the only pair Phase 0.5 can write, and
 * 'Employee' is added here the moment that model is real. A free string would let
 * a typo file a payslip under an owner type nothing will ever query.
 *
 * 'Candidate' is Phase 3, added through the same extension point and for the same
 * reason the other two exist. It is a *third* owner type rather than a reuse of
 * 'Employee' because a candidate is not an employee: their résumé must not be
 * reachable by an employee-document query, and their files have a different
 * retention story — somebody who was never hired should not be carried in the
 * employee record forever.
 */
export const SECURE_DOCUMENT_OWNER_TYPES = ['User', 'Employee', 'Candidate'] as const;
export type SecureDocumentOwnerType = (typeof SECURE_DOCUMENT_OWNER_TYPES)[number];

// ---------------------------------------------------------------------------
//  HR & Workforce — Phase 1: Employee & Organization
// ---------------------------------------------------------------------------

/**
 * Whether an organizational record is still in use.
 *
 * Shared by Department and Designation rather than one enum each: they are the
 * same question about the same kind of record. Neither is ever deleted once
 * employees reference it — ARCHIVED stops it being offered to new employees while
 * its history stays readable.
 */
export const ORG_UNIT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type OrgUnitStatus = (typeof ORG_UNIT_STATUSES)[number];

/**
 * Where an employee stands in their employment.
 *
 * Deliberately short: the full offboarding lifecycle is Phase 7. ON_NOTICE is its
 * own state rather than a flag because somebody serving notice is still employed
 * and still assignable, but not for work that outlives their leaving date.
 *
 * EXITED does not record *why*. Resignation, termination and redundancy carry
 * different process and different confidentiality, and one enum value pretending
 * to capture all three would be less honest than naming only the fact of leaving.
 */
export const EMPLOYEE_STATUSES = [
  'PROBATION',
  'ACTIVE',
  'ON_NOTICE',
  'EXITED',
  'INACTIVE',
] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** Statuses that count as currently employed, for headcount and filtering. */
export const EMPLOYED_STATUSES = [
  'PROBATION',
  'ACTIVE',
  'ON_NOTICE',
] as const satisfies readonly EmployeeStatus[];

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'CONSULTANT',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODES = ['ON_SITE', 'REMOTE', 'HYBRID'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/**
 * What one EmployeeHistory row records.
 *
 * A fixed vocabulary rather than free text, so the timeline can be filtered and a
 * reader can tell a transfer from a promotion without parsing prose. There is
 * deliberately no generic PROFILE_UPDATED: a changed phone number is not an event
 * in somebody's employment, and recording it as one would bury the ones that are.
 */
export const EMPLOYEE_EVENT_TYPES = [
  'JOINED',
  'DEPARTMENT_CHANGED',
  'DESIGNATION_CHANGED',
  'MANAGER_CHANGED',
  'STATUS_CHANGED',
  'EMPLOYMENT_TYPE_CHANGED',
  'WORK_MODE_CHANGED',
  'USER_LINKED',
  'USER_UNLINKED',
] as const;
export type EmployeeEventType = (typeof EMPLOYEE_EVENT_TYPES)[number];

/**
 * What an employee document is.
 *
 * Narrower than SECURE_DOCUMENT_KINDS, which covers every confidential file the
 * CRM might hold: these are the ones an employee record carries. The split keeps
 * an HR document picker from offering a payslip category Phase 1 does not produce.
 */
export const EMPLOYEE_DOCUMENT_TYPES = [
  'IDENTITY_PROOF',
  'ADDRESS_PROOF',
  'EDUCATION_CERTIFICATE',
  'EXPERIENCE_LETTER',
  'OFFER_LETTER',
  'APPOINTMENT_LETTER',
  'CONTRACT',
  'RESUME',
  'OTHER',
] as const;
export type EmployeeDocumentType = (typeof EMPLOYEE_DOCUMENT_TYPES)[number];

export const DOCUMENT_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

/** The employee-id prefix, matching the existing RS001 convention on User. */
export const EMPLOYEE_ID_PREFIX = 'RS';

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
  /**
   * HR Phase 1 — three events, and deliberately only three.
   *
   * Each one tells somebody something they must act on or could not otherwise
   * know: a manager gains a report, a person's CRM account is now tied to their
   * HR record, or somebody they manage is leaving. Creating an employee raises
   * nothing by itself — the HR team already knows, having just done it, and a
   * notice nobody needs is how a bell stops being read.
   */
  'HR_EMPLOYEE_ASSIGNED_TO_MANAGER',
  'HR_EMPLOYEE_ACCOUNT_LINKED',
  'HR_EMPLOYEE_STATUS_CHANGED',
  /**
   * HR Phase 3 — recruitment, onboarding and probation. Five, on the same test
   * the Phase 1 three had to pass: does this tell somebody something they must
   * act on and could not otherwise know?
   *
   * Each one has a named recipient with a deadline attached. An interviewer is
   * expected somewhere at a time; a hiring manager is being asked to decide; an
   * onboarding task is owed by a date; a probation review falls due; a probation
   * period is ending and somebody must confirm, extend or terminate before it
   * does.
   *
   * What is deliberately absent is the larger half of the pipeline. Creating a
   * requisition, receiving an application, moving a candidate from SCREENING to
   * SHORTLISTED, sending an offer — the recruiter doing it already knows, and the
   * ATS board is where that state is read. A notification per stage change would
   * put twelve notices behind every hire and teach everybody to ignore the bell,
   * which costs the five above their whole value.
   */
  'HR_INTERVIEW_SCHEDULED',
  'HR_APPLICATION_DECISION_REQUIRED',
  'HR_ONBOARDING_TASK_ASSIGNED',
  'HR_PROBATION_REVIEW_DUE',
  'HR_PROBATION_ENDING',
  /**
   * HR Phase 4 — training. Five, on the same test as every notice before them:
   * does this tell somebody something they must act on and could not otherwise
   * know?
   *
   * A learner is given mandatory work with a deadline; a deadline passes; a
   * reviewer owes a decision on a practical; a mentor owes a sign-off; somebody has
   * been cleared for live work.
   *
   * What is deliberately absent is the bulk of the module. Completing a lesson,
   * starting an attempt, passing one test of thirteen — the learner did it and can
   * see it on their own page. A notice per module would put a dozen behind every
   * induction and teach everybody to ignore the bell, which costs these five their
   * entire value.
   *
   * Failing an assessment raises nothing either, and that is a deliberate kindness:
   * the learner already knows, and a row in a notification table saying so is a
   * record of their failure sitting where a colleague might glance at it.
   */
  'HR_TRAINING_ASSIGNED',
  'HR_TRAINING_OVERDUE',
  'HR_TRAINING_PRACTICAL_REVIEW_DUE',
  'HR_TRAINING_SHADOWING_SIGNOFF_DUE',
  'HR_TRAINING_QUALIFIED',
  /*
    HR Phase 5 — performance. Five events, on the same test: does this tell
    somebody something they must act on and could not otherwise know?

    HR_REVIEW_FINALIZED is the one worth defending. An employee is told their
    appraisal is locked precisely because they can no longer influence it — a
    decision made about somebody that they learn about by chance is worse than one
    they are told about plainly.

    Deliberately absent: saving a draft assessment, submitting one, rating a
    competency, recording KPI progress. Each is an author acting on their own work,
    so the person already knows, and a notice nobody needs is how a bell stops
    being read.
  */
  'HR_REVIEW_CYCLE_OPENED',
  'HR_SELF_ASSESSMENT_DUE',
  'HR_MANAGER_REVIEW_DUE',
  'HR_REVIEW_FINALIZED',
  'HR_IMPROVEMENT_PLAN_OPENED',
  /*
    HR Phase 6 — payroll. Four, and the restraint here matters more than in any
    earlier phase, because salary is the most sensitive data in the system and a
    notification is the one part of it that arrives unasked.

    **No notification in this module ever carries an amount.** Not a gross, not a
    net, not a deduction. A notice lands in a bell that a colleague may glance at
    over a shoulder, is often mirrored to email, and is retained in a table that
    more people can read than can read a payslip. "Your payslip for March is
    available" tells the employee exactly what they need; "Your net pay is
    42,318.50" tells the room. `payroll.notify.ts` enforces this and the tests
    assert it.

    HR_PAYROLL_APPROVAL_REQUIRED goes to the approvers: a run is costed and
    waiting, and nobody is paid until somebody decides.
    HR_PAYSLIP_AVAILABLE goes to the employee, naming the period only.
    HR_PAYROLL_FINALIZED goes to the HR team that ran it — the period is locked
    and no longer theirs to change.
    HR_PAYROLL_ADJUSTMENT_RECORDED goes to the affected employee, because an
    arrear or a recovery against a closed period changes what they are about to
    be paid and they would otherwise discover it from the figure alone.

    Deliberately absent: a notice per calculation, per recalculation, per
    employee line. The HR user running the payroll is watching the screen that
    reports it.
  */
  'HR_PAYROLL_APPROVAL_REQUIRED',
  'HR_PAYSLIP_AVAILABLE',
  'HR_PAYROLL_FINALIZED',
  'HR_PAYROLL_ADJUSTMENT_RECORDED',
  /*
    Inventory Alerts. A notice carries the product, the SKU and the two
    numbers that matter — stock and threshold — and never a cost price: a
    bell is read by more colleagues than may read what stock cost.
  */
  'INVENTORY_LOW_STOCK',
  'INVENTORY_STOCK_RECOVERED',
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

// ---------------------------------------------------------------------------
//  HR Phase 2 — Attendance & Leave
// ---------------------------------------------------------------------------

/**
 * What an employee's day was.
 *
 * Deliberately separate from ATTENDANCE_WORK_MODES below: "present" and "worked
 * from home" are different questions, and one enum carrying both would make
 * "present in the office" and "present at home" different statuses — so every
 * query about presence would have to enumerate work modes.
 */
export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'HALF_DAY',
  /** Covered by an approved leave. Set by resolution, never by a clock-in. */
  'LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Statuses that count as the employee having worked, for summaries. */
export const WORKED_ATTENDANCE_STATUSES = [
  'PRESENT',
  'HALF_DAY',
] as const satisfies readonly AttendanceStatus[];

/**
 * Where the work actually happened on one day.
 *
 * NOT the Phase 1 `WorkMode` (ON_SITE / REMOTE / HYBRID), which is the
 * employee's contractual arrangement. A HYBRID employee works some days in the
 * office and some at home, so a HYBRID value on an attendance row would say
 * nothing about that day.
 */
export const ATTENDANCE_WORK_MODES = ['OFFICE', 'WFH', 'REMOTE'] as const;
export type AttendanceWorkMode = (typeof ATTENDANCE_WORK_MODES)[number];

/**
 * Where an attendance record is in its day.
 *
 * The session state machine. Distinct from the status, which is the verdict on
 * the day: this is about whether somebody is currently clocked in, on a break, or
 * finished. A database CHECK pairs each state with the timestamps it implies, so
 * "clocked in twice" is unrepresentable rather than merely rejected.
 */
export const ATTENDANCE_SESSION_STATES = ['OPEN', 'ON_BREAK', 'CLOSED', 'NONE'] as const;
export type AttendanceSessionState = (typeof ATTENDANCE_SESSION_STATES)[number];

/**
 * Why an attendance record says what it says.
 *
 * An auto-resolved ABSENT and a manually corrected one are very different
 * claims, and a future Payroll phase must be able to tell them apart.
 */
export const ATTENDANCE_SOURCES = ['SELF', 'SYSTEM', 'MANUAL', 'CORRECTION'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export const ATTENDANCE_CORRECTION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type AttendanceCorrectionStatus = (typeof ATTENDANCE_CORRECTION_STATUSES)[number];

export const OVERTIME_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type OvertimeStatus = (typeof OVERTIME_STATUSES)[number];

export const LEAVE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

/** Requests still awaiting a decision — what an approver's queue shows. */
export const OPEN_LEAVE_STATUSES = ['PENDING'] as const satisfies readonly LeaveRequestStatus[];

/**
 * Which half a half-day leave covers.
 *
 * Required whenever a request is a half day, enforced by a CHECK: "half a day
 * off" without saying which half cannot be rostered against.
 */
export const HALF_DAY_PERIODS = ['FIRST_HALF', 'SECOND_HALF'] as const;
export type HalfDayPeriod = (typeof HALF_DAY_PERIODS)[number];

/**
 * What moved a leave balance.
 *
 * Every balance change is one of these, so a balance is always explainable by
 * replaying its ledger rather than being a number somebody edited.
 */
export const LEAVE_LEDGER_REASONS = [
  'ALLOCATION',
  'ACCRUAL',
  'CARRY_FORWARD',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'CONSUMPTION',
  'CONSUMPTION_REVERSAL',
  'ADJUSTMENT',
  'LAPSE',
] as const;
export type LeaveLedgerReason = (typeof LEAVE_LEDGER_REASONS)[number];

// ---------------------------------------------------------------------------
//  HR & Workforce — Phase 3: Recruitment / ATS, Onboarding & Probation
// ---------------------------------------------------------------------------
//
// Mirrors the Prisma enums one-for-one. Order matters in two of these —
// APPLICATION_STAGES and ONBOARDING_STAGES — because "forward" is defined as
// later in the array, and the transition maps are built from that.

export const JOB_REQUISITION_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PUBLISHED',
  'PAUSED',
  'CLOSED',
  'CANCELLED',
] as const;
export type JobRequisitionStatus = (typeof JOB_REQUISITION_STATUSES)[number];

/** A requisition accepting applications. Exactly one status, deliberately. */
export const OPEN_JOB_STATUSES = ['PUBLISHED'] as const satisfies readonly JobRequisitionStatus[];

export const JOB_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const CANDIDATE_SOURCES = [
  'DIRECT',
  'REFERRAL',
  'JOB_PORTAL',
  'WALK_IN',
  'CAMPUS',
  'AGENCY',
  'SOCIAL_MEDIA',
  'OTHER',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/**
 * The ATS pipeline, in order.
 *
 * The order is load-bearing: `nextStages` and `isForwardStage` in
 * `utils/ats-pipeline.ts` read index positions out of this array, so reordering it
 * silently changes which transitions are legal. Add to the end, or fix the map.
 */
export const APPLICATION_STAGES = [
  'APPLICATION',
  'SCREENING',
  'SHORTLISTED',
  'HR_INTERVIEW',
  'DEPARTMENT_INTERVIEW',
  'ASSESSMENT',
  'FINAL_INTERVIEW',
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'BACKGROUND_VERIFICATION',
  'ONBOARDING',
  'JOINED',
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

/**
 * Stages at or beyond selection.
 *
 * Paired with the application_selected_stage_has_decision CHECK — everything here
 * is downstream of somebody deciding to hire, so none of them can lack that
 * decision.
 */
export const POST_SELECTION_STAGES = [
  'SELECTED',
  'OFFER',
  'OFFER_ACCEPTED',
  'BACKGROUND_VERIFICATION',
  'ONBOARDING',
  'JOINED',
] as const satisfies readonly ApplicationStage[];

export const APPLICATION_STATUSES = [
  'ACTIVE',
  'REJECTED',
  'WITHDRAWN',
  'HIRED',
  'DECLINED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Applications still in play.
 *
 * The filter a recruiter's board defaults to, and the set a new application for
 * the same role is checked against.
 */
export const OPEN_APPLICATION_STATUSES = [
  'ACTIVE',
] as const satisfies readonly ApplicationStatus[];

export const INTERVIEW_TYPES = ['HR', 'DEPARTMENT', 'TECHNICAL', 'FINAL', 'OTHER'] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const INTERVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/**
 * What an interviewer concluded.
 *
 * Five points rather than three. A three-point scale collects everybody's
 * uncertainty in the middle and tells a hiring manager nothing; splitting the ends
 * makes a strong signal visible.
 */
export const INTERVIEW_RECOMMENDATIONS = [
  'STRONG_YES',
  'YES',
  'MAYBE',
  'NO',
  'STRONG_NO',
] as const;
export type InterviewRecommendation = (typeof INTERVIEW_RECOMMENDATIONS)[number];

export const ASSESSMENT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'PASSED',
  'FAILED',
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/** Assessments with a result recorded — paired with the review-complete CHECK. */
export const CONCLUDED_ASSESSMENT_STATUSES = [
  'COMPLETED',
  'PASSED',
  'FAILED',
] as const satisfies readonly AssessmentStatus[];

export const OFFER_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/**
 * Offers somebody has answered.
 *
 * Paired with the offer_response_stamp CHECK: each of these must carry a
 * respondedAt, because "when did they accept" is a question that gets asked.
 * EXPIRED is absent — lapsing is the absence of an answer, not an answer.
 */
export const ANSWERED_OFFER_STATUSES = [
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
] as const satisfies readonly OfferStatus[];

export const BACKGROUND_CHECK_TYPES = [
  'IDENTITY',
  'EDUCATION',
  'EMPLOYMENT',
  'CRIMINAL',
  'REFERENCE',
  'ADDRESS',
  'OTHER',
] as const;
export type BackgroundCheckType = (typeof BACKGROUND_CHECK_TYPES)[number];

export const BACKGROUND_CHECK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'CLEAR',
  'FLAGGED',
  'FAILED',
  'WAIVED',
] as const;
export type BackgroundCheckStatus = (typeof BACKGROUND_CHECK_STATUSES)[number];

/** Checks that have concluded, one way or another. */
export const CONCLUDED_BACKGROUND_CHECK_STATUSES = [
  'CLEAR',
  'FLAGGED',
  'FAILED',
  'WAIVED',
] as const satisfies readonly BackgroundCheckStatus[];

/**
 * Checks whose result counts against somebody.
 *
 * Named because it governs two things: the adverse-result CHECK requiring an
 * explanation, and the rule that a flagged verification blocks onboarding until a
 * person decides to proceed anyway. An automatic rejection on a FLAGGED check
 * would let a database row end somebody's employment without a human deciding.
 */
export const ADVERSE_BACKGROUND_CHECK_STATUSES = [
  'FLAGGED',
  'FAILED',
] as const satisfies readonly BackgroundCheckStatus[];

/**
 * The onboarding checklist, in order.
 *
 * Order is load-bearing, like APPLICATION_STAGES. EMPLOYEE_CREATED is the hinge:
 * the three stages before it run without an employment record, every stage after
 * it has one, and the onboarding_employee_after_creation CHECK pair enforces
 * exactly that boundary.
 */
export const ONBOARDING_STAGES = [
  'OFFER_ACCEPTED',
  'DOCUMENTS',
  'VERIFICATION',
  'EMPLOYEE_CREATED',
  'ACCOUNT',
  'ASSETS',
  'POLICIES',
  'TRAINING',
  'DEPARTMENT_INTRODUCTION',
  'MANAGER_ASSIGNED',
  'FIRST_WEEK',
  'DAY_30',
  'DAY_60',
  'DAY_90',
  'PROBATION_DECISION',
  'COMPLETED',
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

/**
 * The stages that run before an employment record exists.
 *
 * Mirrors the CHECK pair. Kept as a named constant so the service and the test
 * assert against the same list the database does, rather than three copies of
 * three strings drifting apart.
 */
export const PRE_EMPLOYEE_ONBOARDING_STAGES = [
  'OFFER_ACCEPTED',
  'DOCUMENTS',
  'VERIFICATION',
] as const satisfies readonly OnboardingStage[];

export const ONBOARDING_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'SKIPPED',
  'BLOCKED',
] as const;
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number];

/**
 * Tasks nobody needs to do any more.
 *
 * SKIPPED counts as settled: deciding not to do something is a decision, and the
 * completion CHECK requires it to be attributable like any other.
 */
export const SETTLED_ONBOARDING_TASK_STATUSES = [
  'COMPLETED',
  'SKIPPED',
] as const satisfies readonly OnboardingTaskStatus[];

/**
 * Who owns an onboarding task.
 *
 * Generic on purpose. ASSETS, TRAINING and POLICY are foundations in this phase:
 * the category is how a future Asset or Training module finds its work, without
 * this phase inventing an asset register or a course catalogue it would then have
 * to maintain.
 */
export const ONBOARDING_TASK_CATEGORIES = [
  'DOCUMENTS',
  'IT',
  'HR',
  'MANAGER',
  'TRAINING',
  'POLICY',
  'DEPARTMENT',
] as const;
export type OnboardingTaskCategory = (typeof ONBOARDING_TASK_CATEGORIES)[number];

export const PROBATION_STATUSES = [
  'NOT_STARTED',
  'ACTIVE',
  'EXTENDED',
  'CONFIRMED',
  'TERMINATED',
] as const;
export type ProbationStatus = (typeof PROBATION_STATUSES)[number];

/** Probations still running — the set a review or a decision may act on. */
export const OPEN_PROBATION_STATUSES = [
  'ACTIVE',
  'EXTENDED',
] as const satisfies readonly ProbationStatus[];

export const PROBATION_REVIEW_TYPES = ['FIRST_WEEK', 'DAY_30', 'DAY_60', 'DAY_90'] as const;
export type ProbationReviewType = (typeof PROBATION_REVIEW_TYPES)[number];

export const PROBATION_REVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'MISSED'] as const;
export type ProbationReviewStatus = (typeof PROBATION_REVIEW_STATUSES)[number];

export const PROBATION_DECISIONS = ['CONFIRM', 'EXTEND', 'TERMINATE'] as const;
export type ProbationDecision = (typeof PROBATION_DECISIONS)[number];

/**
 * How many days after joining each probation review falls due.
 *
 * Kept here rather than in the service because the frontend shows the schedule
 * too, and two copies of "60" would eventually disagree. FIRST_WEEK is 7 rather
 * than 5: a working-week offset would need the holiday calendar, and a review due
 * date is not worth a dependency on it — the reviewer picks the actual day.
 */
export const PROBATION_REVIEW_OFFSET_DAYS = {
  FIRST_WEEK: 7,
  DAY_30: 30,
  DAY_60: 60,
  DAY_90: 90,
} as const satisfies Record<ProbationReviewType, number>;

// ---------------------------------------------------------------------------
//  HR & Workforce — Phase 4: Training & Learning Management
// ---------------------------------------------------------------------------
//
// Mirrors the Prisma enums one-for-one. Order matters in TRAINING_MODULE_KINDS
// only in that the completion rule follows the kind — not as a sequence.
//
// The learning journey itself is deliberately NOT an enum here. It is ordered
// TrainingModule rows inside a program, because a compiled-in sequence would mean
// every department that trains differently needs a code change. See
// REQUIRED_JOURNEY_TEMPLATE below, which is a *starting point* a program can be
// seeded from and nothing the services branch on.

export const TRAINING_PROGRAM_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type TrainingProgramStatus = (typeof TRAINING_PROGRAM_STATUSES)[number];

/** Programs that accept new assignments. Exactly one status, deliberately. */
export const ASSIGNABLE_PROGRAM_STATUSES = [
  'ACTIVE',
] as const satisfies readonly TrainingProgramStatus[];

/**
 * What kind of step a module is, which decides how it is completed.
 *
 * The distinction is load-bearing rather than descriptive:
 *
 *   LESSON      the learner marks it read
 *   ASSESSMENT  the learner passes its test
 *   PRACTICAL   somebody else approves their submission
 *   SHADOWING   a mentor signs it off
 *
 * That is what lets one ordered list express the whole journey — company
 * introduction through to final test — without a service knowing the sequence.
 */
export const TRAINING_MODULE_KINDS = [
  'LESSON',
  'ASSESSMENT',
  'PRACTICAL',
  'SHADOWING',
] as const;
export type TrainingModuleKind = (typeof TRAINING_MODULE_KINDS)[number];

/** Modules completed by somebody other than the learner. */
export const REVIEWED_MODULE_KINDS = [
  'PRACTICAL',
  'SHADOWING',
] as const satisfies readonly TrainingModuleKind[];

export const TRAINING_ENROLLMENT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'EXEMPTED',
  'CANCELLED',
] as const;
export type TrainingEnrollmentStatus = (typeof TRAINING_ENROLLMENT_STATUSES)[number];

/**
 * Enrollments still in play.
 *
 * Paired with the `training_enrollment_one_live_per_program` partial unique index:
 * exactly these two statuses block a second assignment, so a retake years later is
 * allowed while two concurrent assignments cannot both land.
 */
export const LIVE_ENROLLMENT_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
] as const satisfies readonly TrainingEnrollmentStatus[];

/** Enrollments nobody needs to work on any more. */
export const SETTLED_ENROLLMENT_STATUSES = [
  'COMPLETED',
  'EXEMPTED',
  'CANCELLED',
] as const satisfies readonly TrainingEnrollmentStatus[];

export const TRAINING_OBLIGATIONS = ['MANDATORY', 'OPTIONAL'] as const;
export type TrainingObligation = (typeof TRAINING_OBLIGATIONS)[number];

/**
 * How an assignment came about.
 *
 * Paired with the `training_enrollment_assigned_via` CHECK. A named set rather than
 * free text because the point of recording it is to answer "why is this person
 * enrolled" months later, and three spellings of "department" make that
 * unanswerable.
 *
 * Stored on the enrollment rather than re-derived, deliberately: a department-wide
 * assignment must not change meaning when the employee later moves department.
 */
export const TRAINING_ASSIGNMENT_SOURCES = [
  'INDIVIDUAL',
  'DEPARTMENT',
  'DESIGNATION',
  'ONBOARDING',
] as const;
export type TrainingAssignmentSource = (typeof TRAINING_ASSIGNMENT_SOURCES)[number];

export const ASSESSMENT_QUESTION_KINDS = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
] as const;
export type AssessmentQuestionKind = (typeof ASSESSMENT_QUESTION_KINDS)[number];

export const TRAINING_ATTEMPT_STATUSES = [
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'EXPIRED',
] as const;
export type TrainingAttemptStatus = (typeof TRAINING_ATTEMPT_STATUSES)[number];

/**
 * Attempts that are over.
 *
 * EXPIRED counts here, which is the point: abandoning an attempt must not be a free
 * retry, so a lapsed one consumes its slot against the limit exactly as a failure
 * does.
 */
export const SETTLED_ATTEMPT_STATUSES = [
  'PASSED',
  'FAILED',
  'EXPIRED',
] as const satisfies readonly TrainingAttemptStatus[];

export const PRACTICAL_SUBMISSION_STATUSES = [
  'NOT_STARTED',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
] as const;
export type PracticalSubmissionStatus = (typeof PRACTICAL_SUBMISSION_STATUSES)[number];

export const SHADOWING_STATUSES = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ShadowingStatus = (typeof SHADOWING_STATUSES)[number];

/**
 * The business's default pass mark, out of 100.
 *
 * A default, not a rule. It is the column default on `TrainingProgram.passingScore`
 * and every program may set its own — nothing in the services compares against this
 * constant, and a CHECK keeps any stated value inside 0 < score <= 100.
 *
 * Named here so the frontend can show "80%" as the suggested value on a new-program
 * form without hard-coding the number in a component.
 */
export const DEFAULT_PASSING_SCORE = 80;

/** The default retake allowance, for the same reason. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The required learning journey, as a seed template.
 *
 * This is the sequence the business asked for: company introduction through to
 * live-work readiness. It exists so a new program can be created pre-populated
 * rather than built a module at a time in the UI.
 *
 * **Nothing branches on it.** No service checks "is this the company introduction
 * module"; completion is decided by module kind, the program's requirement flags and
 * the learner's actual progress. Reordering, removing or adding steps is editing a
 * program's modules, not changing code — which is the whole reason the journey is
 * data.
 *
 * `kind` drives how each step completes, so the knowledge test and department test
 * are ASSESSMENT, the practical is PRACTICAL, and shadowing is SHADOWING. The final
 * test is an ASSESSMENT flagged `isFinal` when the program is seeded.
 */
export const REQUIRED_JOURNEY_TEMPLATE = [
  { title: 'Company introduction', kind: 'LESSON' },
  { title: 'Product training', kind: 'LESSON' },
  { title: 'Customer psychology', kind: 'LESSON' },
  { title: 'Communication', kind: 'LESSON' },
  { title: 'Customer experience', kind: 'LESSON' },
  { title: 'Productivity tools', kind: 'LESSON' },
  { title: 'Company policies', kind: 'LESSON' },
  { title: 'Knowledge test', kind: 'ASSESSMENT' },
  { title: 'Department-specific training', kind: 'LESSON' },
  { title: 'Department test', kind: 'ASSESSMENT' },
  { title: 'Practical exercise', kind: 'PRACTICAL' },
  { title: 'Shadowing', kind: 'SHADOWING' },
  { title: 'Final assessment', kind: 'ASSESSMENT' },
] as const satisfies readonly { title: string; kind: TrainingModuleKind }[];

// ---------------------------------------------------------------------------
//  HR Phase 5 — Performance Management
// ---------------------------------------------------------------------------
//
// ### What a "review" is here, and why it is not ProbationReview
//
// Phase 3 already has `ProbationReview`: four fixed checkpoints, one rating,
// cascade-bound to a single ProbationRecord and keyed unique per type. That is a
// one-off hiring gate — it answers "should this person stay past probation".
//
// Phase 5 answers a different question, repeatedly: how did somebody do over a
// period, against goals they agreed and competencies the business names. It needs
// cycles, goals with measurable targets, a self-assessment, a manager review, named
// competency ratings and a finalisation step that locks the record. Widening
// ProbationReview to carry all that would make every probation row carry columns it
// never uses, and would tie an annual appraisal's lifecycle to a probation's cascade
// — delete the probation and the appraisal history goes with it.
//
// So these are separate tables, and `ProbationReview` is left exactly as it is.

/**
 * The life of a review cycle.
 *
 * DRAFT is where a cycle is configured — dates, competencies, who is in scope —
 * and nothing is visible to the people being reviewed. ACTIVE opens it: reviews
 * exist and self-assessments can be written. CLOSED stops new submissions while
 * leaving everything readable, which is what a cycle looks like after the
 * conversations have happened. ARCHIVED is history.
 *
 * Opening and closing are their own endpoints rather than a PATCH on this field,
 * the same decision Phase 4 made about publishing a program: each carries a
 * timestamp and a record of who did it, and a cycle that became ACTIVE with nothing
 * saying how is a cycle nobody can audit.
 */
export const REVIEW_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type ReviewCycleStatus = (typeof REVIEW_CYCLE_STATUSES)[number];

/** Cycles that accept new work. Reads better than listing the negation. */
export const OPEN_REVIEW_CYCLE_STATUSES = ['ACTIVE'] as const satisfies readonly ReviewCycleStatus[];

/**
 * How often a cycle recurs.
 *
 * Descriptive, not a scheduler. Nothing in Phase 5 creates the next cycle
 * automatically — somebody does, and this records the intended rhythm so a report
 * can say "quarterly" without inferring it from two dates. A cron that generated
 * cycles would need an answer for "what happens to the one still open", and nobody
 * has asked for that.
 */
export const REVIEW_CYCLE_CADENCES = [
  'MONTHLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'ANNUAL',
  'AD_HOC',
] as const;
export type ReviewCycleCadence = (typeof REVIEW_CYCLE_CADENCES)[number];

/**
 * Where one person's review stands.
 *
 * This is the state machine the whole phase turns on, and the order is the
 * progression:
 *
 *   NOT_STARTED        the review exists; nobody has written anything
 *   SELF_ASSESSMENT    the employee is writing theirs
 *   PENDING_MANAGER    submitted; waiting on the manager
 *   MANAGER_REVIEW     the manager is writing theirs
 *   PENDING_APPROVAL   the manager submitted; waiting on HR or a second approver
 *   FINALIZED          locked. Nobody edits a finalized review.
 *   CANCELLED          withdrawn, with a reason
 *
 * The employee drives the first transition and the manager the second. Neither can
 * reach FINALIZED: that needs HR_PERFORMANCE:APPROVE, and the service refuses a
 * self-approval regardless of what grants somebody holds — see
 * `performance-access.ts`.
 */
export const PERFORMANCE_REVIEW_STATUSES = [
  'NOT_STARTED',
  'SELF_ASSESSMENT',
  'PENDING_MANAGER',
  'MANAGER_REVIEW',
  'PENDING_APPROVAL',
  'FINALIZED',
  'CANCELLED',
] as const;
export type PerformanceReviewStatus = (typeof PERFORMANCE_REVIEW_STATUSES)[number];

/**
 * Reviews that are over.
 *
 * The predicate every "may this be edited" check is written against. FINALIZED is
 * here because a finalized review is the record of a conversation that happened —
 * editing it afterwards rewrites history, and the requirement is explicit that
 * employees must not edit finalized reviews.
 */
export const SETTLED_REVIEW_STATUSES = [
  'FINALIZED',
  'CANCELLED',
] as const satisfies readonly PerformanceReviewStatus[];

/**
 * Who a goal belongs to.
 *
 * EMPLOYEE and DEPARTMENT rather than one polymorphic owner column, because the two
 * are read by different people and scoped differently: an employee goal is personal
 * and visible to them, their manager and HR; a department goal is the unit's and
 * visible to everybody in it. A single nullable pair of foreign keys with a CHECK
 * keeps that honest — exactly one is set.
 */
export const GOAL_SCOPES = ['EMPLOYEE', 'DEPARTMENT'] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

/**
 * A goal's life.
 *
 * DRAFT is being written. ACTIVE is agreed and being worked. ACHIEVED, MISSED and
 * PARTIALLY_MET are the three honest outcomes — two would force somebody to call a
 * 70%-of-target result either a success or a failure, and the resulting number
 * would be worth nothing. CANCELLED is a goal that stopped being relevant, with a
 * reason recorded.
 */
export const GOAL_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'ACHIEVED',
  'PARTIALLY_MET',
  'MISSED',
  'CANCELLED',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Goals that are closed. No progress is recorded against these. */
export const SETTLED_GOAL_STATUSES = [
  'ACHIEVED',
  'PARTIALLY_MET',
  'MISSED',
  'CANCELLED',
] as const satisfies readonly GoalStatus[];

/**
 * How a KPI's target is measured, and therefore how progress is computed.
 *
 * This is what makes a KPI *measurable* rather than a sentence somebody rates out
 * of five. Each member decides the arithmetic in `performance.calc.ts`:
 *
 *   NUMBER       raw count against a target. 40 calls out of 50.
 *   PERCENTAGE   a rate. The target and the value are both percentages.
 *   CURRENCY     money. Stored as Decimal, never a float — see the schema note.
 *   DURATION     minutes. The unit is fixed so two KPIs cannot disagree about it.
 *   BOOLEAN      done or not. Target is 1, value is 0 or 1.
 *
 * `direction` below decides whether higher is better, which BOOLEAN and the rest
 * all need: a KPI for "average handling time" is met by going *down*.
 */
export const KPI_METRIC_KINDS = [
  'NUMBER',
  'PERCENTAGE',
  'CURRENCY',
  'DURATION',
  'BOOLEAN',
] as const;
export type KpiMetricKind = (typeof KPI_METRIC_KINDS)[number];

/**
 * Which way is good.
 *
 * HIGHER_IS_BETTER for sales made; LOWER_IS_BETTER for complaints received or
 * handling time. Without this a KPI's attainment cannot be computed at all — and
 * defaulting to "higher" silently scores a team as failing for reducing exactly
 * what they were asked to reduce.
 */
export const KPI_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type KpiDirection = (typeof KPI_DIRECTIONS)[number];

/**
 * The company's competency rating scale, 1–5.
 *
 * Named rather than bare integers so a stored 3 cannot be read as "3 out of 10" by
 * a later screen, and so the labels live in one place. Phase 3's interview feedback
 * and probation reviews already use a 1–5 integer with a CHECK; this matches that
 * deliberately — two HR scales that differ by one point would make the two
 * incomparable for no benefit.
 */
export const COMPETENCY_RATINGS = [1, 2, 3, 4, 5] as const;
export type CompetencyRating = (typeof COMPETENCY_RATINGS)[number];

/** The lowest and highest a rating may be. Mirrored by a database CHECK. */
export const MIN_COMPETENCY_RATING = 1;
export const MAX_COMPETENCY_RATING = 5;

/**
 * What a competency is about.
 *
 * Used to group a rating sheet so a reviewer is not handed twenty unsorted
 * attributes. Not a permission and not a gate — purely how the form is organised.
 */
export const COMPETENCY_CATEGORIES = [
  'CORE',
  'FUNCTIONAL',
  'LEADERSHIP',
  'BEHAVIOURAL',
] as const;
export type CompetencyCategory = (typeof COMPETENCY_CATEGORIES)[number];

/**
 * Who gave a rating.
 *
 * The same competency is rated twice — once by the employee, once by their manager
 * — and keeping both is the point: the gap between them is what the appraisal
 * conversation is actually about. One column with two rows per competency rather
 * than `selfRating`/`managerRating` columns, because a third rater (a peer, a
 * skip-level) is a plausible later requirement and would otherwise be a migration
 * plus every query rewritten.
 */
export const RATING_SOURCES = ['SELF', 'MANAGER', 'HR'] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

/**
 * A development plan's life.
 *
 * OPEN is being worked. COMPLETED is finished. ABANDONED is honest about the plan
 * that stopped mattering — better than leaving it OPEN forever or deleting it, since
 * a plan that was set and dropped is itself worth knowing.
 */
export const DEVELOPMENT_PLAN_STATUSES = ['OPEN', 'COMPLETED', 'ABANDONED'] as const;
export type DevelopmentPlanStatus = (typeof DEVELOPMENT_PLAN_STATUSES)[number];

/**
 * What a development plan is for.
 *
 * IMPROVEMENT is the formal performance-improvement case — a plan written because
 * somebody is underperforming, with a review date. GROWTH is the opposite: somebody
 * doing well who wants a next step. They are deliberately distinguished, because a
 * screen that showed them identically would put a promotion track beside a formal
 * warning and call both "development".
 */
export const DEVELOPMENT_PLAN_KINDS = ['IMPROVEMENT', 'GROWTH'] as const;
export type DevelopmentPlanKind = (typeof DEVELOPMENT_PLAN_KINDS)[number];

/**
 * The default weight a KPI carries inside a goal, as a percentage.
 *
 * A default, not a rule — the same decision as Phase 4's passing score. A goal's
 * KPIs may weight however the business wants; this is what an unspecified one gets
 * so a single-KPI goal works without anybody thinking about weighting.
 */
export const DEFAULT_KPI_WEIGHT = 100;

/**
 * The attainment at or above which a goal counts as achieved, as a percentage.
 *
 * Configurable per cycle, exactly like the training pass mark: this is the column
 * default and nothing in the services compares against this constant. Stated here so
 * the business default lives in one place.
 */
export const DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD = 100;

/**
 * The attainment below which a goal counts as missed rather than partially met.
 *
 * Between this and the achievement threshold is PARTIALLY_MET. Also a per-cycle
 * default.
 */
export const DEFAULT_GOAL_PARTIAL_THRESHOLD = 50;

// ---------------------------------------------------------------------------
//  HR Phase 6 — Payroll & Compensation
// ---------------------------------------------------------------------------
//
// One rule governs every value below: **this module computes what it is
// configured to compute, and nothing is a statutory rule.**
//
// No PF rate, ESI threshold, TDS slab, overtime multiplier or rounding policy
// appears anywhere in this codebase as a constant. Each is either a configured
// SalaryComponent row or an HRSetting, because a number like "12%" written into
// a shipped binary is a legal claim the code cannot substantiate and cannot be
// corrected without a deploy. See `backend/src/modules/hr/PAYROLL-SCOPE.md` for
// what that means for compliance.

/**
 * Whether a salary component adds to pay or subtracts from it.
 *
 * Two values rather than a signed amount, because the sign is a property of the
 * component's *kind* and not of any particular figure. A deduction stored as a
 * negative earning would make every sum in the module read correctly and every
 * payslip read wrongly — "Earnings: -1,800" is not a line anybody can explain.
 *
 * EMPLOYER_CONTRIBUTION is deliberately separate from DEDUCTION. Both are costs,
 * but only a deduction reduces net pay: an employer's share of a retirement fund
 * is company expenditure that never passes through the employee's hands, and
 * netting it off their payslip would understate what they were paid.
 */
export const SALARY_COMPONENT_KINDS = [
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_CONTRIBUTION',
] as const;
export type SalaryComponentKind = (typeof SALARY_COMPONENT_KINDS)[number];

/**
 * How a component's amount is arrived at.
 *
 * FIXED            a stated amount per month.
 * PERCENT_OF_BASE  a percentage of the structure's base component.
 * PERCENT_OF_GROSS a percentage of total gross earnings for the period.
 * FORMULA_BALANCE  whatever is left of a target gross once every other earning
 *                  is assigned — the "special allowance" shape, where a figure
 *                  exists to make a total come out right.
 *
 * PERCENT_OF_GROSS is evaluated strictly after every FIXED and PERCENT_OF_BASE
 * earning, and a PERCENT_OF_GROSS component may not itself be an input to
 * another one. That restriction is what makes a payroll run terminate: a
 * percentage of a total that includes itself is a fixed-point problem, not a
 * payroll line, and the service refuses the configuration rather than iterating
 * to a number nobody can reproduce by hand.
 */
export const SALARY_CALCULATION_KINDS = [
  'FIXED',
  'PERCENT_OF_BASE',
  'PERCENT_OF_GROSS',
  'FORMULA_BALANCE',
] as const;
export type SalaryCalculationKind = (typeof SALARY_CALCULATION_KINDS)[number];

/**
 * Which per-day divisor converts a monthly figure into a daily one.
 *
 * Needed for exactly two things: prorating a joiner or leaver who was present
 * for part of the month, and valuing a day of unpaid leave.
 *
 * **Configured, never assumed.** All three are in use in real businesses and
 * they disagree by up to 10% on the same salary, so the module stores the basis
 * it used on every period it processes rather than deriving it at read time. A
 * period finalised under one basis keeps its own arithmetic forever, which is
 * the only way a payslip from March still reconciles after the policy changes in
 * April.
 *
 * CALENDAR_DAYS  the actual length of the month: 28, 29, 30 or 31.
 * WORKING_DAYS   days the business expected work, from holidays and week-offs.
 * FIXED_THIRTY   always 30, whatever the month contains.
 */
export const DAILY_RATE_BASES = ['CALENDAR_DAYS', 'WORKING_DAYS', 'FIXED_THIRTY'] as const;
export type DailyRateBasis = (typeof DAILY_RATE_BASES)[number];

/**
 * Where a payroll period stands.
 *
 * DRAFT       created, nothing computed. Employees and components may change.
 * CALCULATED  every eligible employee has a computed, reviewable payslip line.
 *             Recalculation is allowed and replaces the previous figures.
 * PENDING_APPROVAL an ApprovalRequest is open against the period.
 * APPROVED    a decider with HR_PAYROLL:APPROVE has agreed the figures.
 * FINALIZED   locked. The figures are the record, snapshots are immutable, and
 *             payslips may be issued.
 * CANCELLED   abandoned before finalisation. Kept rather than deleted, because a
 *             period that was opened and dropped is a fact somebody may need to
 *             account for.
 *
 * The shape mirrors PERFORMANCE_REVIEW_STATUSES on purpose — the same
 * draft/submit/approve/lock arc, the same refusal to offer a path out of the
 * locked state. There is no transition from FINALIZED. Correcting a finalised
 * period means a separately authorised adjustment in a later period, never an
 * edit to a figure somebody has already been paid against.
 *
 * FINALIZED is also deliberately **not** called PAID. Nothing in this module
 * moves money. Marking a row PAID when no bank instruction has been issued would
 * make the system assert something untrue about an employee's livelihood.
 */
export const PAYROLL_PERIOD_STATUSES = [
  'DRAFT',
  'CALCULATED',
  'PENDING_APPROVAL',
  'APPROVED',
  'FINALIZED',
  'CANCELLED',
] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];

/**
 * The period statuses that can no longer be recalculated or re-costed.
 *
 * Read by the access policy before it considers who is asking, so that a
 * finalised period is immutable to everybody rather than to everybody without a
 * sufficiently broad grant.
 */
export const SETTLED_PAYROLL_PERIOD_STATUSES = ['FINALIZED', 'CANCELLED'] as const;
export type SettledPayrollPeriodStatus = (typeof SETTLED_PAYROLL_PERIOD_STATUSES)[number];

/**
 * Where one employee's line within a period stands.
 *
 * Separate from the period's own status because one employee can be excluded or
 * held back without stopping the run: somebody whose bank details are missing, or
 * whose attendance is still under correction, should not block ninety colleagues
 * from being paid.
 *
 * EXCLUDED is the state that earns its place. A zero-value payslip and a
 * deliberate exclusion look identical in a total and mean entirely different
 * things to the person not being paid.
 */
export const PAYROLL_ITEM_STATUSES = ['PENDING', 'CALCULATED', 'EXCLUDED', 'FINALIZED'] as const;
export type PayrollItemStatus = (typeof PAYROLL_ITEM_STATUSES)[number];

/**
 * Why an employee's line was held out of a run.
 *
 * Recorded rather than inferred, because "why was I not paid" is the single
 * question this module must always be able to answer. NOT_ELIGIBLE covers the
 * documented eligibility rules; the others are specific enough to act on.
 */
export const PAYROLL_EXCLUSION_REASONS = [
  'NOT_ELIGIBLE',
  'NO_SALARY_ASSIGNMENT',
  'JOINED_AFTER_PERIOD',
  'EXITED_BEFORE_PERIOD',
  'MANUALLY_EXCLUDED',
] as const;
export type PayrollExclusionReason = (typeof PAYROLL_EXCLUSION_REASONS)[number];

/**
 * What a payroll adjustment does to a later period.
 *
 * This is the correction mechanism, and it exists because a finalised period
 * cannot be edited. An arrear, a recovery or a one-off bonus attaches to the next
 * open period and carries a reference to what it corrects, so the trail reads
 * forwards: period N was wrong, period N+1 says so and by how much.
 */
export const PAYROLL_ADJUSTMENT_KINDS = ['ARREAR', 'RECOVERY', 'BONUS', 'REIMBURSEMENT'] as const;
export type PayrollAdjustmentKind = (typeof PAYROLL_ADJUSTMENT_KINDS)[number];

/**
 * How a monetary result is rounded to two decimal places.
 *
 * Configured per period and stored on it, for the same reason the daily-rate
 * basis is: rounding policy is a business decision that moves real money in
 * aggregate, and a finalised period must keep the policy it was computed under.
 *
 * HALF_UP    0.005 becomes 0.01. The common commercial convention.
 * HALF_EVEN  banker's rounding; 0.005 goes to the nearest even cent.
 * DOWN       always truncate toward zero.
 */
export const MONETARY_ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN', 'DOWN'] as const;
export type MonetaryRoundingMode = (typeof MONETARY_ROUNDING_MODES)[number];

/**
 * The scale every monetary column in this module uses.
 *
 * Two decimal places, matching `Decimal(12, 2)` throughout the existing schema.
 * Stated as a constant so the rounding helpers and the Zod schemas agree with the
 * database rather than each asserting it separately.
 */
export const MONEY_SCALE = 2;

/**
 * The currency a payroll period is denominated in, where none is configured.
 *
 * A column default and an HRSetting fallback, never a hard-coded assumption at a
 * call site: the period stores its own currency so a historical payslip cannot be
 * reinterpreted by a later configuration change. Multi-currency payroll is out of
 * scope for this phase and the single stored code is what makes adding it later a
 * migration rather than a rewrite.
 */
export const DEFAULT_PAYROLL_CURRENCY = 'INR';
