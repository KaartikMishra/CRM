import { z } from 'zod';
import { COUNTRIES, DEFAULT_COUNTRY, GSTIN_PATTERN, INDIA_STATES } from '../constants/index.js';
import { CUSTOMER_TYPES } from '../enums.js';
import { cuidSchema } from './common.js';

/**
 * Q1 — the customer belongs to the enquiry, not to each product line.
 * One enquiry, one customer.
 */
/**
 * The customer phone format, extracted so a caller that needs it *required*
 * reuses the rule rather than restating the pattern and drifting from it.
 */
export const customerPhoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number');

export const customerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address');

/**
 * A postal address, kept deliberately unstructured.
 *
 * Addresses are written the way the customer gives them — house names, floors,
 * landmarks, "opposite the temple" — and imposing line/city/postcode fields
 * would only invite them to be filled in wrongly. Trimmed and length-capped;
 * nothing else is assumed about the shape.
 */
export const customerAddressSchema = z
  .string()
  .trim()
  .max(500, 'Keep the address under 500 characters');

/**
 * The trading or registered name the customer bills under.
 *
 * Separate from `name`, never a replacement for it: `name` is who is dealt
 * with and is required, while this is who the invoice is made out to and a
 * retail buyer has none.
 */
export const customerCompanySchema = z
  .string()
  .trim()
  .max(160, 'Keep the company name under 160 characters');

/**
 * The country, closed to the COUNTRIES reference list.
 *
 * A closed list rather than free text so that 'UAE', 'U.A.E.' and 'United
 * Arab Emirates' cannot become three countries in the same database.
 */
export const customerCountrySchema = z.enum(COUNTRIES, {
  errorMap: () => ({ message: 'Choose a country from the list' }),
});

/**
 * The customer's State, closed to the States and Union Territories of India.
 *
 * A closed list rather than free text: a state typed by hand becomes "U.P.",
 * "Uttar pradesh" and "UP" in three rows and stops being groupable. The list
 * itself lives in `constants` so the dropdown and this rule read the same one.
 */
export const customerStateSchema = z.enum(INDIA_STATES, {
  errorMap: () => ({ message: 'Choose a state' }),
});

/**
 * A GSTIN, checked for structure and nothing more.
 *
 * Uppercased before the pattern runs, so a number typed in lower case is
 * accepted and stored in the single canonical casing rather than being
 * rejected for a difference that carries no meaning.
 */
export const customerGstSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN');

/**
 * State belongs to India, and only to India.
 *
 * `state` is closed to the States and Union Territories of India, so pairing it
 * with any other country is not a preference but a contradiction — it would
 * record a customer in Lesotho as being in Haryana. The rule is written once,
 * here, and applied to every customer schema, because a form that disables the
 * field is a courtesy and never the guarantee.
 *
 * A customer with no country at all is left alone deliberately: every row
 * recorded before the field existed has none, and they must stay loadable and
 * editable.
 */
const requireStateWithinIndia = (
  value: { country?: string; state?: string },
  ctx: z.RefinementCtx,
): void => {
  if (!value.country) return;

  if (value.country === DEFAULT_COUNTRY) {
    if (!value.state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'Choose a state',
      });
    }
    return;
  }

  if (value.state) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: `A state is only recorded for a customer in ${DEFAULT_COUNTRY}`,
    });
  }
};

/*
  Kept as a plain object so it can still be extended — `salesNewCustomerSchema`
  needs `.extend()`, and a schema carrying a refinement can no longer be
  extended. The refinement is applied to each finished schema instead.
*/
const customerFields = z.object({
  name: z.string().trim().min(2, 'Customer name is required').max(160),
  type: z.enum(CUSTOMER_TYPES, {
    errorMap: () => ({ message: 'Choose a customer type' }),
  }),
  /**
   * All seven stay optional on the wire so no existing customer record and no
   * existing caller becomes invalid. Where a form needs one of them — both
   * add-customer dialogs require a phone — that is enforced at the form, which
   * is the layer that knows what it is asking for.
   *
   * `gstNumber` is optional by business rule rather than by compatibility: a
   * retail customer has no GSTIN, so blank must always be a valid answer.
   */
  companyName: customerCompanySchema.optional(),
  phone: customerPhoneSchema.optional(),
  email: customerEmailSchema.optional(),
  address: customerAddressSchema.optional(),
  state: customerStateSchema.optional(),
  country: customerCountrySchema.optional(),
  gstNumber: customerGstSchema.optional(),
});

export const createCustomerSchema = customerFields.superRefine(requireStateWithinIndia);

export const customerSearchSchema = z.object({
  q: z.string().trim().max(160).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
  /** Typeahead sizing; the list is for picking, not for browsing. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CustomerSearchQuery = z.infer<typeof customerSearchSchema>;

/** The enquiry form either picks an existing customer or creates one inline. */
export const customerSelectionSchema = z
  .object({
    customerId: cuidSchema.optional(),
    newCustomer: createCustomerSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const provided = [value.customerId, value.newCustomer].filter(Boolean).length;
    if (provided !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerId'],
        message: 'Select an existing customer or enter a new one, not both',
      });
    }
  });

/**
 * Creating a customer from the Sales flow, where a contact number is required.
 *
 * An order that needs chasing is far easier to chase with a number attached, so
 * Sales asks for one. Product Enquiry keeps phone optional — the base schema is
 * unchanged, and both reuse the same format rule.
 */
export const salesNewCustomerSchema = customerFields
  .extend({ phone: customerPhoneSchema })
  .superRefine(requireStateWithinIndia);

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type SalesNewCustomerInput = z.infer<typeof salesNewCustomerSchema>;
export type CustomerSelection = z.infer<typeof customerSelectionSchema>;

// ---------------------------------------------------------------------------
//  All Customers — the directory
// ---------------------------------------------------------------------------

/*
  `customerSearchSchema` above is deliberately untouched. It validates the
  picker that Product Enquiry, Create Lead and Sales all submit to — a name
  typeahead, capped, no cursor — and widening it would change a contract four
  modules depend on. The directory is a different query shape, so it gets its
  own schema and its own route.
*/

/**
 * How the directory may be ordered.
 *
 * Note which of these are columns and which are derived. `name` and `createdAt`
 * are columns on Customer. The other three are aggregates over orders and
 * enquiries that no column holds, so the repository must order them in SQL over
 * the aggregate — page-local sorting would present one page as if it were a
 * global ordering, which is a lie the RS Products listing already documents.
 */
export const CUSTOMER_DIRECTORY_SORTS = [
  'name',
  'createdAt',
  'lastPurchaseAt',
  'purchaseValue',
  'orderCount',
] as const;
export type CustomerDirectorySort = (typeof CUSTOMER_DIRECTORY_SORTS)[number];

export const customerDirectoryQuerySchema = z.object({
  /** Matched against name, companyName, phone (digits), email and GSTIN. */
  q: z.string().trim().max(160).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  /** A first-touch or last-touch source value, as stored. */
  source: z.string().trim().max(60).optional(),
  /** Which end of the journey `source` filters on. */
  sourceTouch: z.enum(['FIRST', 'LAST']).default('LAST'),
  hasOrders: z.coerce.boolean().optional(),
  isRepeat: z.coerce.boolean().optional(),
  /** Only customers appearing in an open duplicate suggestion. */
  duplicatesOnly: z.coerce.boolean().optional(),
  minPurchaseValue: z.coerce.number().min(0).optional(),
  maxPurchaseValue: z.coerce.number().min(0).optional(),
  /** Filters on SalesOrder.orderDate — the business date. */
  purchasedFrom: z.coerce.date().optional(),
  purchasedTo: z.coerce.date().optional(),
  sort: z.enum(CUSTOMER_DIRECTORY_SORTS).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  /*
    Keyset where the sort is a column; offset where it is an aggregate. Both are
    accepted so the repository can choose, and the response says which it used
    rather than leaving the caller to guess.
  */
  cursor: cuidSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CustomerDirectoryQuery = z.infer<typeof customerDirectoryQuerySchema>;

export const customerIdParamSchema = z.object({ id: cuidSchema });
export type CustomerIdParam = z.infer<typeof customerIdParamSchema>;

/** A page of one customer's related records. */
export const customerHistoryQuerySchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CustomerHistoryQuery = z.infer<typeof customerHistoryQuerySchema>;

// ---------------------------------------------------------------------------
//  Duplicate review
// ---------------------------------------------------------------------------

export const CUSTOMER_DUPLICATE_STATUSES = ['SUGGESTED', 'CONFIRMED', 'DISMISSED'] as const;
export type CustomerDuplicateStatusValue = (typeof CUSTOMER_DUPLICATE_STATUSES)[number];

export const customerDuplicateQuerySchema = z.object({
  status: z.enum(CUSTOMER_DUPLICATE_STATUSES).default('SUGGESTED'),
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CustomerDuplicateQuery = z.infer<typeof customerDuplicateQuerySchema>;

/**
 * Recording a decision about a pair.
 *
 * Only the two decided states are accepted: a reviewer can confirm or dismiss,
 * and cannot set a pair back to SUGGESTED by hand. Reopening happens one way
 * only — a rescan finding that the matched identifiers changed — so a dismissal
 * cannot be quietly undone without the underlying data having moved.
 *
 * Confirming records agreement. It merges nothing: no customer row, enquiry,
 * lead or order is touched by this endpoint.
 */
export const customerDuplicateDecisionSchema = z.object({
  status: z.enum(['CONFIRMED', 'DISMISSED']),
});
export type CustomerDuplicateDecisionInput = z.infer<typeof customerDuplicateDecisionSchema>;
