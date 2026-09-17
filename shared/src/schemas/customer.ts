import { z } from 'zod';
import { GSTIN_PATTERN, INDIA_STATES } from '../constants/index.js';
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
 * The customer's State, closed to the 28 States of India.
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

export const createCustomerSchema = z.object({
  name: z.string().trim().min(2, 'Customer name is required').max(160),
  type: z.enum(CUSTOMER_TYPES, {
    errorMap: () => ({ message: 'Choose a customer type' }),
  }),
  /**
   * All five stay optional on the wire so no existing customer record and no
   * existing caller becomes invalid. Where a form needs one of them — both
   * add-customer dialogs require a phone — that is enforced at the form, which
   * is the layer that knows what it is asking for.
   *
   * `gstNumber` is optional by business rule rather than by compatibility: a
   * retail customer has no GSTIN, so blank must always be a valid answer.
   */
  phone: customerPhoneSchema.optional(),
  email: customerEmailSchema.optional(),
  address: customerAddressSchema.optional(),
  state: customerStateSchema.optional(),
  gstNumber: customerGstSchema.optional(),
});

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
export const salesNewCustomerSchema = createCustomerSchema.extend({
  phone: customerPhoneSchema,
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type SalesNewCustomerInput = z.infer<typeof salesNewCustomerSchema>;
export type CustomerSelection = z.infer<typeof customerSelectionSchema>;
