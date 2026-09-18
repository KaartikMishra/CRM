/**
 * Business constants shared by every tier.
 *
 * These are contract values: the frontend uses them to render limits, the
 * backend uses them to enforce rules, and the database enforces the hard ones
 * again as CHECK constraints. Changing a value here changes all three.
 */

/** §62.1 — hard cap on products in one enquiry. Also a DB CHECK constraint. */
export const MAX_PRODUCTS_PER_ENQUIRY = 20;

/** §62.2 — default response SLA. Snapshotted onto each enquiry at creation. */
export const DEFAULT_SLA_MINUTES = 15;

/** Countdown crosses into its warning state this long before the deadline. */
export const SLA_WARNING_THRESHOLD_SECONDS = 120;

/**
 * §46 — Leader Dashboard bands, applied to
 * (on-time enquiries / responded enquiries) per employee per month.
 * Configurable later without a deployment; ordered highest first.
 */
export const EFFICIENCY_BANDS = [
  { label: 'Excellent', minPercent: 80 },
  { label: 'Good', minPercent: 70 },
  { label: 'Satisfactory', minPercent: 60 },
  { label: 'Poor', minPercent: 0 },
] as const;

export type EfficiencyBandLabel = (typeof EFFICIENCY_BANDS)[number]['label'];

export function efficiencyBand(percent: number): EfficiencyBandLabel {
  const band = EFFICIENCY_BANDS.find((b) => percent >= b.minPercent);
  return (band ?? EFFICIENCY_BANDS[EFFICIENCY_BANDS.length - 1]!).label;
}

/** Enquiry number format: ENQ-<period>-<6 digits>. */
export const ENQUIRY_NUMBER_PREFIX = 'ENQ';
export const ENQUIRY_NUMBER_PAD = 6;

/** Default page size for server-side paginated lists. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Sales order ids are entered by hand, never generated.
 *
 * Orders reach the CRM from Shopify as often as they are keyed in, so the
 * accepted shape has to cover what those systems actually produce — `#1001`,
 * `RS-1001/A`, `SO_2026_44` — rather than a format invented here. Anything
 * outside this set is almost certainly a typo, so the pattern stays closed.
 */
export const SALES_ORDER_ID_MAX_LENGTH = 64;
export const SALES_ORDER_ID_PATTERN = /^[A-Za-z0-9#\-_/]+$/;

/**
 * Hard cap on product lines in one sales order.
 *
 * Higher than the twenty an enquiry allows: an enquiry is a question about a
 * handful of products, while an order can legitimately be a long bill.
 */
export const MAX_ITEMS_PER_SALES_ORDER = 50;

/**
 * §12 — session JWT contract.
 *
 * Auth.js signs the session token with these claims and Express verifies
 * against the same values, so they live here rather than as matching literals
 * in two packages that could drift apart.
 */
export const SESSION_JWT_ALG = 'HS256' as const;
export const SESSION_JWT_ISSUER = 'royalstuffs-crm';
export const SESSION_JWT_AUDIENCE = 'royalstuffs-crm-api';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * The 28 States of India, as the customer's State dropdown offers them.
 *
 * The official name is both the label and the stored value, so the column reads
 * exactly as the dropdown shows and no lookup table or code map is needed.
 *
 * Union Territories are deliberately excluded: this is the 28 States and
 * nothing else. Delhi, Jammu & Kashmir, Chandigarh, Puducherry, Ladakh and the
 * island territories are therefore not offered — a decision, not an omission.
 *
 * It lives here rather than in `enums.ts` because that file is reserved for
 * values paired with a Prisma enum ("add a member here and in schema.prisma
 * together, never in one alone"), and `Customer.state` is a plain nullable
 * String by design.
 */
export const INDIA_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export type IndiaState = (typeof INDIA_STATES)[number];

/**
 * GSTIN shape: a 15-character identifier built as
 * `<2-digit state code><10-character PAN><entity code>Z<check character>`.
 *
 * Structure only. The check character is **not** verified arithmetically, and
 * the leading state code is **not** cross-checked against `Customer.state` —
 * both would be stricter rules than "a well-formed GSTIN", and a number that
 * fails either is far more likely to be a legitimate edge case than a typo we
 * are entitled to reject.
 */
export const GSTIN_LENGTH = 15;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

/**
 * Display names for the CRM modules.
 *
 * The sidebar and the administrator's module-access grid must call a module the
 * same thing, so the label lives beside the enum rather than being retyped in
 * each component.
 */
export const APP_MODULE_LABELS = {
  PRODUCT_ENQUIRY: 'Product Enquiry',
  SALES: 'Sales',
  PROCUREMENT: 'Purchase & Procurement',
  RS_PRODUCTS: 'RS Products',
  PACKING_DISPATCH: 'Packing & Dispatch',
  CUSTOMER_BILLING: 'Customer Billing',
  VENDOR_INVOICE: 'Vendor Invoices',
  POST_SALES: 'Post Sales & Grievance',
} as const satisfies Record<string, string>;

/**
 * The GST rates a sales line may carry.
 *
 * Exactly six, and no seventh: the five statutory slabs plus `NONE`.
 *
 * `NONE` and `'0'` are different answers and must stay that way. "No GST
 * decision has been recorded for this line" is not the same statement as "this
 * line is exempt, taxed at zero percent" — the second is a tax position
 * somebody took, and a bill has to be able to say which. Nothing in the CRM
 * coerces one into the other, and neither is ever parsed into a number.
 *
 * Kept here rather than in `enums.ts` for the same reason as INDIA_STATES:
 * that file is reserved for values paired with a Prisma enum, and
 * `SalesOrderItem.gstRate` is a plain nullable String by design. Rates are set
 * by policy and change; a Postgres enum would charge an ALTER TYPE migration
 * for every revision.
 *
 * These are display and storage values only. No total, line or otherwise, is
 * computed from them anywhere in the CRM.
 */
export const GST_RATES = ['NONE', '0', '5', '12', '18', '28'] as const;

export type GstRate = (typeof GST_RATES)[number];

/**
 * What each rate is called in the UI.
 *
 * The slab descriptions come from the request and are shown verbatim, so a
 * salesperson picks by meaning rather than by recalling which slab a product
 * falls in. The label lives beside the values rather than being retyped in
 * the form.
 */
export const GST_RATE_LABELS = {
  NONE: 'None',
  '0': '0% — Exempt items',
  '5': '5% — Low-tax items',
  '12': '12% — Some goods/services',
  '18': '18% — Most goods/services',
  '28': '28% — High-tax/luxury items',
} as const satisfies Record<GstRate, string>;

/**
 * The longest HSN code the CRM will store.
 *
 * Generous on purpose. Indian HSN is 4, 6 or 8 digits, but the field accepts
 * whatever the seller actually writes on the document — codes arrive with
 * separators and suffixes — and inventing a stricter rule would reject
 * legitimate entries. Length is the only constraint; there is no format
 * pattern and no numeric coercion.
 */
export const HSN_CODE_MAX_LENGTH = 20;
