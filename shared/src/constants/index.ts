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

  // The eight Union Territories. A GSTIN is issued against these exactly as
  // it is against a State, and a customer in Delhi or Chandigarh has to be
  // recordable, so they belong in the same list rather than a parallel one.
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
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

/**
 * Countries, for the customer's postal address.
 *
 * Plain text and a fixed reference list, exactly like INDIA_STATES and for the
 * same reasons: `Customer.country` is a nullable String, and a Postgres enum
 * would charge an ALTER TYPE migration every time a name changed.
 *
 * Names, not ISO codes. The column is read by people preparing shipping and
 * invoice documents, and a document says "United Arab Emirates" rather than
 * "AE". Anything that needs a code later can map from this.
 */
export const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
  'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain',
  'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
  'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
  'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia',
  'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
  'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France',
  'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada',
  'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
  'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati',
  'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia',
  'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi',
  'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania',
  'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia',
  'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal',
  'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea',
  'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama',
  'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
  'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles',
  'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands',
  'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka',
  'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
  'Tanzania', 'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago',
  'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States of America', 'Uruguay',
  'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen',
  'Zambia', 'Zimbabwe',
] as const;

export type Country = (typeof COUNTRIES)[number];

/** What a new customer form starts on. Nearly every customer is domestic. */
export const DEFAULT_COUNTRY: Country = 'India';

/**
 * How the price typed onto a sales line is to be read.
 *
 * EXCLUSIVE  the price is the taxable value; GST is added on top.
 * INCLUSIVE  the price is what the customer pays; the taxable value and the
 *            tax are worked back out of it.
 *
 * One setting for the whole order rather than one per line. A quotation is
 * given on one basis or the other, and mixing the two on a single document is
 * a mistake rather than a feature.
 *
 * Worth being exact about what changes: the mode never alters what the
 * customer pays for the goods, only how that figure is broken up. Ten rupees
 * inclusive of 5% is ₹9.52 of goods and ₹0.48 of tax; ten rupees exclusive is
 * ₹10.00 of goods and ₹0.50 of tax, totalling ₹10.50.
 */
export const GST_MODES = ['EXCLUSIVE', 'INCLUSIVE'] as const;

export type GstMode = (typeof GST_MODES)[number];

export const GST_MODE_LABELS = {
  EXCLUSIVE: 'GST Excluded',
  INCLUSIVE: 'GST Included',
} as const satisfies Record<GstMode, string>;

/**
 * What a rate is called once it has been split for an intra-state sale.
 *
 * Under Indian GST a sale within the seller's own state carries CGST and SGST
 * at half the rate each; a sale to another state carries IGST at the whole
 * rate. The total tax is identical either way — only the heads differ, and an
 * invoice has to name them correctly.
 */
export const TAX_SPLITS = ['CGST_SGST', 'IGST'] as const;

export type TaxSplit = (typeof TAX_SPLITS)[number];

/**
 * Order-level charges and adjustments, beyond the goods themselves.
 *
 * DISCOUNT is the one that subtracts. It is kept in the same list rather than
 * given a field of its own because it behaves like the others in every other
 * respect — it is entered, labelled and shown the same way — and because an
 * order may legitimately carry more than one.
 */
export const SALES_CHARGE_TYPES = [
  'DUTY',
  'PACKING',
  'SHIPPING',
  'CUSTOMIZATION',
  'DISCOUNT',
  'OTHER',
] as const;

export type SalesChargeType = (typeof SALES_CHARGE_TYPES)[number];

export const SALES_CHARGE_TYPE_LABELS = {
  DUTY: 'Duty',
  PACKING: 'Packing',
  SHIPPING: 'Shipping',
  CUSTOMIZATION: 'Customization',
  DISCOUNT: 'Discount',
  OTHER: 'Other',
} as const satisfies Record<SalesChargeType, string>;

/** The only charge type that reduces the payable amount. */
export const DISCOUNT_CHARGE_TYPE: SalesChargeType = 'DISCOUNT';

/** How many charge lines one order may carry. Generous; a guard, not a rule. */
export const SALES_CHARGE_MAX = 20;

/** Free-text note beside a charge, e.g. "Air freight, Mumbai–Dubai". */
export const SALES_CHARGE_LABEL_MAX_LENGTH = 120;
