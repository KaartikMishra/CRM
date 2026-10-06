/**
 * Business constants shared by every tier.
 *
 * These are contract values: the frontend uses them to render limits, the
 * backend uses them to enforce rules, and the database enforces the hard ones
 * again as CHECK constraints. Changing a value here changes all three.
 */

import type {
  DealStatus,
  LeadActivityKind,
  LeadSource,
  ProductMatchKind,
  RequirementType,
} from '../enums.js';

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
  LEAD_DEAL: 'Create Lead / Deal',
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
//  Create Lead / Deal
// ---------------------------------------------------------------------------

/** How a lead reached us, as the form offers it. */
export const LEAD_SOURCE_LABELS = {
  CALL: 'Call',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  ABANDONED_CART: 'Abandoned Cart',
  SOCIAL_MEDIA: 'Social Media',
  OTHER: 'Other',
} as const satisfies Record<LeadSource, string>;

/** What the enquiry is for. */
export const REQUIREMENT_TYPE_LABELS = {
  RETAIL: 'Retail',
  WHOLESALE: 'Wholesale',
  EXPORT_RETAIL: 'Export Retail',
  EXPORT_WHOLESALE: 'Export Wholesale',
  CORPORATE_GIFTING: 'Corporate Gifting',
  PERSONAL_GIFTING: 'Personal Gifting',
} as const satisfies Record<RequirementType, string>;

/**
 * The storefronts and marketplaces a lead can arrive through.
 *
 * A plain String list rather than a Prisma enum, following DISPATCH_CHANNELS
 * and DISPATCH_CARRIERS: a commercial list that changes as storefronts are
 * added and retired should not charge an ALTER TYPE for every revision. The
 * z.enum built from this is what restricts the stored value.
 */
export const LEAD_CHANNELS = [
  'ROYALSTUFFS_COM',
  'ROYALSTUFFS_STORE',
  'INDIAMART',
  'AMAZON',
  'FLIPKART',
  'OTHER',
] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export const LEAD_CHANNEL_LABELS = {
  ROYALSTUFFS_COM: 'RoyalStuffs.com',
  ROYALSTUFFS_STORE: 'RoyalStuffs.store',
  INDIAMART: 'IndiaMART',
  AMAZON: 'Amazon',
  FLIPKART: 'Flipkart',
  OTHER: 'Other',
} as const satisfies Record<LeadChannel, string>;

/** The written name beside an OTHER answer, and the free-text source note. */
export const LEAD_OTHER_MAX_LENGTH = 120;
export const LEAD_SOURCE_DETAILS_MAX_LENGTH = 1000;

/**
 * Where the promptness bands begin.
 *
 * Centralised here, and read by both tiers, so the business can move a band
 * without a migration — the rating is derived on every read, so there is no
 * stored value to rewrite when a number changes.
 *
 *   score >= GOOD     -> GOOD
 *   score >= AVERAGE  -> AVERAGE
 *   below that        -> POOR
 *
 * A score is `onTime / expected`, both counted from LeadActivity rows. When
 * `expected` is zero there is no score at all and the rating is NOT_RATED —
 * which is why these are two thresholds and not three: "not measurable" is not
 * the bottom band, it is the absence of a band.
 */
export const LEAD_PROMPTNESS_THRESHOLDS = {
  GOOD: 0.65,
  AVERAGE: 0.5,
} as const;

/**
 * The four things promptness can say.
 *
 * NOT_RATED is a peer of the other three, not a degenerate POOR: a new lead, or
 * one with nobody assigned, has earned no verdict rather than a bad one.
 */
export const LEAD_PROMPTNESS_RATINGS = ['GOOD', 'AVERAGE', 'POOR', 'NOT_RATED'] as const;
export type LeadPromptnessRating = (typeof LEAD_PROMPTNESS_RATINGS)[number];

export const LEAD_PROMPTNESS_LABELS = {
  GOOD: 'Good',
  AVERAGE: 'Average',
  POOR: 'Poor',
  NOT_RATED: 'Not rated',
} as const satisfies Record<LeadPromptnessRating, string>;

export const DEAL_STATUS_LABELS = {
  WON: 'Won',
  LOST: 'Lost',
  INPROCESS: 'In process',
} as const satisfies Record<DealStatus, string>;

export const LEAD_ACTIVITY_KIND_LABELS = {
  FIRST_CONTACT: 'First contact',
  FOLLOW_UP: 'Follow-up',
  RESULT: 'Result',
} as const satisfies Record<LeadActivityKind, string>;

export const PRODUCT_MATCH_KIND_LABELS = {
  EXACT: 'Exact product',
  SIMILAR: 'Similar product',
} as const satisfies Record<ProductMatchKind, string>;

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
 * The international dialling code for each country in COUNTRIES above.
 *
 * Added so the customer forms can show a prefix beside the number field instead
 * of asking somebody to type `+91` every time. Keyed by the exact country name,
 * and complete: every one of the 196 entries in COUNTRIES has a code here,
 * asserted by a test, so a selector can never land on a country with no prefix.
 *
 * ### What this does NOT change
 *
 * **Phone matching.** `normalizePhone` still compares digits and nothing else —
 * it does not consult this map, infer a country, or treat `9876543210` and
 * `+919876543210` as the same number. This is input assistance, not parsing
 * intelligence, and the lookup semantics are deliberately untouched.
 *
 * Several codes are shared: +1 covers the USA, Canada and the Caribbean, and
 * Vatican City uses Italy's +39. That is the real numbering plan, not an error —
 * which is why the map goes country to code and never the reverse.
 */
export const COUNTRY_DIAL_CODES = {
  'Afghanistan': '+93', 'Albania': '+355', 'Algeria': '+213', 'Andorra': '+376',
  'Angola': '+244', 'Antigua and Barbuda': '+1', 'Argentina': '+54', 'Armenia': '+374',
  'Australia': '+61', 'Austria': '+43', 'Azerbaijan': '+994', 'Bahamas': '+1',
  'Bahrain': '+973', 'Bangladesh': '+880', 'Barbados': '+1', 'Belarus': '+375',
  'Belgium': '+32', 'Belize': '+501', 'Benin': '+229', 'Bhutan': '+975', 'Bolivia': '+591',
  'Bosnia and Herzegovina': '+387', 'Botswana': '+267', 'Brazil': '+55', 'Brunei': '+673',
  'Bulgaria': '+359', 'Burkina Faso': '+226', 'Burundi': '+257', 'Cabo Verde': '+238',
  'Cambodia': '+855', 'Cameroon': '+237', 'Canada': '+1', 'Central African Republic': '+236',
  'Chad': '+235', 'Chile': '+56', 'China': '+86', 'Colombia': '+57', 'Comoros': '+269',
  'Congo': '+242', 'Costa Rica': '+506', 'Croatia': '+385', 'Cuba': '+53', 'Cyprus': '+357',
  'Czechia': '+420', 'Democratic Republic of the Congo': '+243', 'Denmark': '+45',
  'Djibouti': '+253', 'Dominica': '+1', 'Dominican Republic': '+1', 'Ecuador': '+593',
  'Egypt': '+20', 'El Salvador': '+503', 'Equatorial Guinea': '+240', 'Eritrea': '+291',
  'Estonia': '+372', 'Eswatini': '+268', 'Ethiopia': '+251', 'Fiji': '+679',
  'Finland': '+358', 'France': '+33', 'Gabon': '+241', 'Gambia': '+220', 'Georgia': '+995',
  'Germany': '+49', 'Ghana': '+233', 'Greece': '+30', 'Grenada': '+1', 'Guatemala': '+502',
  'Guinea': '+224', 'Guinea-Bissau': '+245', 'Guyana': '+592', 'Haiti': '+509',
  'Honduras': '+504', 'Hungary': '+36', 'Iceland': '+354', 'India': '+91', 'Indonesia': '+62',
  'Iran': '+98', 'Iraq': '+964', 'Ireland': '+353', 'Israel': '+972', 'Italy': '+39',
  'Ivory Coast': '+225', 'Jamaica': '+1', 'Japan': '+81', 'Jordan': '+962',
  'Kazakhstan': '+7', 'Kenya': '+254', 'Kiribati': '+686', 'Kuwait': '+965',
  'Kyrgyzstan': '+996', 'Laos': '+856', 'Latvia': '+371', 'Lebanon': '+961',
  'Lesotho': '+266', 'Liberia': '+231', 'Libya': '+218', 'Liechtenstein': '+423',
  'Lithuania': '+370', 'Luxembourg': '+352', 'Madagascar': '+261', 'Malawi': '+265',
  'Malaysia': '+60', 'Maldives': '+960', 'Mali': '+223', 'Malta': '+356',
  'Marshall Islands': '+692', 'Mauritania': '+222', 'Mauritius': '+230', 'Mexico': '+52',
  'Micronesia': '+691', 'Moldova': '+373', 'Monaco': '+377', 'Mongolia': '+976',
  'Montenegro': '+382', 'Morocco': '+212', 'Mozambique': '+258', 'Myanmar': '+95',
  'Namibia': '+264', 'Nauru': '+674', 'Nepal': '+977', 'Netherlands': '+31',
  'New Zealand': '+64', 'Nicaragua': '+505', 'Niger': '+227', 'Nigeria': '+234',
  'North Korea': '+850', 'North Macedonia': '+389', 'Norway': '+47', 'Oman': '+968',
  'Pakistan': '+92', 'Palau': '+680', 'Palestine': '+970', 'Panama': '+507',
  'Papua New Guinea': '+675', 'Paraguay': '+595', 'Peru': '+51', 'Philippines': '+63',
  'Poland': '+48', 'Portugal': '+351', 'Qatar': '+974', 'Romania': '+40', 'Russia': '+7',
  'Rwanda': '+250', 'Saint Kitts and Nevis': '+1', 'Saint Lucia': '+1',
  'Saint Vincent and the Grenadines': '+1', 'Samoa': '+685', 'San Marino': '+378',
  'Sao Tome and Principe': '+239', 'Saudi Arabia': '+966', 'Senegal': '+221',
  'Serbia': '+381', 'Seychelles': '+248', 'Sierra Leone': '+232', 'Singapore': '+65',
  'Slovakia': '+421', 'Slovenia': '+386', 'Solomon Islands': '+677', 'Somalia': '+252',
  'South Africa': '+27', 'South Korea': '+82', 'South Sudan': '+211', 'Spain': '+34',
  'Sri Lanka': '+94', 'Sudan': '+249', 'Suriname': '+597', 'Sweden': '+46',
  'Switzerland': '+41', 'Syria': '+963', 'Taiwan': '+886', 'Tajikistan': '+992',
  'Tanzania': '+255', 'Thailand': '+66', 'Timor-Leste': '+670', 'Togo': '+228',
  'Tonga': '+676', 'Trinidad and Tobago': '+1', 'Tunisia': '+216', 'Turkey': '+90',
  'Turkmenistan': '+993', 'Tuvalu': '+688', 'Uganda': '+256', 'Ukraine': '+380',
  'United Arab Emirates': '+971', 'United Kingdom': '+44', 'United States of America': '+1',
  'Uruguay': '+598', 'Uzbekistan': '+998', 'Vanuatu': '+678', 'Vatican City': '+39',
  'Venezuela': '+58', 'Vietnam': '+84', 'Yemen': '+967', 'Zambia': '+260', 'Zimbabwe': '+263',
} as const satisfies Record<Country, string>;

/** The prefix for a country, or null when the value is not a known country. */
export function dialCodeFor(country: string | null | undefined): string | null {
  if (!country) return null;
  return (COUNTRY_DIAL_CODES as Record<string, string>)[country] ?? null;
}


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
 * How an order's money is being collected.
 *
 * Three answers, and they differ in *when* the money arrives rather than in how
 * much of it does:
 *
 *   PREPAID      the whole payable is collected before dispatch
 *   COD          the whole payable is collected on delivery
 *   PARTIAL_COD  some is collected now, the rest on delivery
 *
 * Deliberately not a term in any total. This says how a payment arrived, never
 * how much — the payable is the sum of the lines and charges, and the money
 * guard does not read this. Recording COD does not make an order paid, and
 * recording PREPAID does not make it paid either; only a payment does.
 */
export const PAYMENT_METHODS = ['PREPAID', 'COD', 'PARTIAL_COD'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  PREPAID: 'Prepaid',
  COD: 'Cash on delivery',
  PARTIAL_COD: 'Partial COD',
};

/**
 * What a rate is called once it has been split for an intra-state sale.
 *
 * Under Indian GST a sale within the seller's own state carries CGST and SGST
 * at half the rate each; a sale to another state carries IGST at the whole
 * rate. The total tax is identical either way — only the heads differ, and an
 * invoice has to name them correctly.
 */
/*
  NONE is the third answer, and it is not "no tax decided" — it is "Indian GST
  does not name heads for this supply at all", which is what a customer outside
  India is. A line on such an order carries no GST rate (the service refuses
  one), so NONE always coincides with a tax total of zero; it exists so nothing
  labels a foreign sale CGST or IGST on the way past.
*/
export const TAX_SPLITS = ['CGST_SGST', 'IGST', 'NONE'] as const;

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

/**
 * How long a payment reference may be.
 *
 * Generous on purpose. A UPI UTR is 12 digits and a NEFT one 16, but bank
 * portals hand out longer strings and people paste what they were given —
 * truncating a reference makes it useless for the one job it has, which is
 * matching this payment to a line on a statement.
 */
export const SALES_PAYMENT_REFERENCE_MAX_LENGTH = 120;

/** Room for a sentence explaining a cancellation or a refund, not an essay. */
export const SALES_CANCELLATION_REASON_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
//  Packing & Dispatch
// ---------------------------------------------------------------------------

/**
 * How a shipment was booked.
 *
 * `OTHER` is a real answer, not a gap: a shipment booked outside the two
 * aggregators still has to be recordable, and the name then goes in
 * `channelOther`. Forcing it into one of the named two would make the record
 * say something untrue.
 *
 * Kept here rather than in `enums.ts` for the reason that file states: it is
 * reserved for values paired with a Prisma enum, and `Dispatch.channel` is a
 * plain nullable String by design — courier arrangements are commercial and
 * change, and a Postgres enum would charge an ALTER TYPE for every revision.
 */
export const DISPATCH_CHANNELS = ['BIGSHIP', 'SHIPROCKET', 'OTHER'] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

export const DISPATCH_CHANNEL_LABELS = {
  BIGSHIP: 'BigShip',
  SHIPROCKET: 'Shiprocket',
  OTHER: 'Other',
} as const satisfies Record<DispatchChannel, string>;

/**
 * Who is carrying it.
 *
 * Twenty-six named carriers and `OTHER`, in the order the business gave them:
 * the Indian networks first, then the international ones, because that is the
 * order somebody scanning the list will look in. The name behind `OTHER` goes
 * in `carrierOther`.
 *
 * A plain String column for the same reason as the channel above — this list
 * will be revised, and revising it should not require a migration.
 */
export const DISPATCH_CARRIERS = [
  'DELHIVERY',
  'BLUE_DART',
  'DTDC',
  'ECOM_EXPRESS',
  'XPRESSBEES',
  'SHADOWFAX',
  'SHIPROCKET',
  'SHIPYAARI',
  'PICKRR',
  'ITHINK_LOGISTICS',
  'EKART_LOGISTICS',
  'INDIA_POST',
  'AMAZON_SHIPPING',
  'PORTER',
  'BORZO',
  'DHL_EXPRESS',
  'FEDEX',
  'UPS',
  'ARAMEX',
  'DPD',
  'GLS',
  'SF_EXPRESS',
  'USPS',
  'ROYAL_MAIL',
  'CANADA_POST',
  'AUSTRALIA_POST',
  'OTHER',
] as const;
export type DispatchCarrier = (typeof DISPATCH_CARRIERS)[number];

/** What each carrier is called on screen, spelled as the courier spells it. */
export const DISPATCH_CARRIER_LABELS = {
  DELHIVERY: 'Delhivery',
  BLUE_DART: 'Blue Dart',
  DTDC: 'DTDC',
  ECOM_EXPRESS: 'Ecom Express',
  XPRESSBEES: 'XpressBees',
  SHADOWFAX: 'Shadowfax',
  SHIPROCKET: 'Shiprocket',
  SHIPYAARI: 'Shipyaari',
  PICKRR: 'Pickrr',
  ITHINK_LOGISTICS: 'iThink Logistics',
  EKART_LOGISTICS: 'Ekart Logistics',
  INDIA_POST: 'India Post',
  AMAZON_SHIPPING: 'Amazon Shipping',
  PORTER: 'Porter',
  BORZO: 'Borzo',
  DHL_EXPRESS: 'DHL Express',
  FEDEX: 'FedEx',
  UPS: 'UPS',
  ARAMEX: 'Aramex',
  DPD: 'DPD',
  GLS: 'GLS',
  SF_EXPRESS: 'SF Express',
  USPS: 'USPS',
  ROYAL_MAIL: 'Royal Mail',
  CANADA_POST: 'Canada Post',
  AUSTRALIA_POST: 'Australia Post',
  OTHER: 'Other',
} as const satisfies Record<DispatchCarrier, string>;

/** The longest airway bill the CRM will store. Generous: formats vary widely. */
export const AWB_MAX_LENGTH = 60;

/** How long Procurement has to answer a partial-dispatch request. */
export const PARTIAL_DISPATCH_DEADLINE_HOURS = 24;
export const PARTIAL_DISPATCH_DEADLINE_MS = PARTIAL_DISPATCH_DEADLINE_HOURS * 60 * 60 * 1000;
