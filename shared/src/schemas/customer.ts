import { z } from 'zod';
import { CUSTOMER_TYPES } from '../enums.js';
import { cuidSchema } from './common.js';

/**
 * Q1 — the customer belongs to the enquiry, not to each product line.
 * One enquiry, one customer.
 */
export const createCustomerSchema = z.object({
  name: z.string().trim().min(2, 'Customer name is required').max(160),
  type: z.enum(CUSTOMER_TYPES, {
    errorMap: () => ({ message: 'Choose a customer type' }),
  }),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number')
    .optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').optional(),
});

export const customerSearchSchema = z.object({
  q: z.string().trim().max(160).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
});

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

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type CustomerSelection = z.infer<typeof customerSelectionSchema>;
