import { z } from 'zod';
import {
  LEAD_CHANNELS,
  LEAD_OTHER_MAX_LENGTH,
  LEAD_SOURCE_DETAILS_MAX_LENGTH,
} from '../constants/index.js';
import { LEAD_SOURCES, REQUIREMENT_TYPES } from '../enums.js';
import { cuidSchema } from './common.js';
import { createCustomerSchema, customerPhoneSchema } from './customer.js';

/**
 * The Create Lead / Deal contract — Phase 1.
 *
 * Two rules shape this file, and both are also CHECK constraints on the table,
 * so a row written by any caller obeys them:
 *
 *   - **"Other" plus a written name is one answer, not two.** Choosing OTHER
 *     without naming it, and naming something while choosing a listed value,
 *     are both contradictions. Enforced in both directions, exactly as Dispatch
 *     does for channel and carrier.
 *
 *   - **A lead never creates a second customer by accident.** It either points
 *     at an existing one or creates one through the existing Customer contract;
 *     there is no third path and no copied customer field on the lead itself.
 *
 * What is deliberately absent: status, owner, follow-up, products, pipeline
 * stage, scoring. Those rules are not specified, and a speculative field is one
 * the business has to work around later.
 */

/** Adds the OTHER/free-text agreement issue, so both fields report together. */
function checkOther(
  value: string,
  other: string | undefined,
  field: 'leadSource' | 'channel',
  label: string,
  ctx: z.RefinementCtx,
): void {
  const otherField = `${field}Other` as const;

  if (value === 'OTHER' && !other) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [otherField],
      message: `Name the ${label} when choosing Other`,
    });
  }

  if (value !== 'OTHER' && other) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [otherField],
      message: `Only fill this in when the ${label} is Other`,
    });
  }
}

const otherNameSchema = z.string().trim().min(1).max(LEAD_OTHER_MAX_LENGTH);

/**
 * Who the lead is from.
 *
 * Exactly one of the two, never both and never neither — the same shape
 * `customerSelectionSchema` already uses for Product Enquiry, restated here
 * only because a lead requires a customer where an enquiry's is optional.
 * `newCustomer` is the existing Customer contract verbatim, so a lead cannot
 * invent a customer field the master does not have.
 */
export const leadCustomerSchema = z
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
        message: 'Choose an existing customer or add a new one',
      });
    }
  });

export const createLeadSchema = z
  .object({
    leadSource: z.enum(LEAD_SOURCES, {
      errorMap: () => ({ message: 'Choose where this lead came from' }),
    }),
    leadSourceOther: otherNameSchema.optional(),

    /**
     * A free-text reference for the source.
     *
     * Generic and optional on purpose: the team has not settled what this means
     * per source, so it is one neutral field rather than six speculative ones.
     */
    sourceDetails: z.string().trim().max(LEAD_SOURCE_DETAILS_MAX_LENGTH).optional(),

    /**
     * When the enquiry actually happened — not when the row was made. A lead is
     * often entered hours after the call, so the moment is asked for rather
     * than assumed, and it is required because "when" is half of a lead.
     */
    sourceAt: z
      .string({ required_error: 'Enter the date and time of the enquiry' })
      .datetime({ offset: true, message: 'Enter a valid date and time' }),

    requirementType: z.enum(REQUIREMENT_TYPES, {
      errorMap: () => ({ message: 'Choose what this enquiry is for' }),
    }),

    customer: leadCustomerSchema,

    channel: z.enum(LEAD_CHANNELS, {
      errorMap: () => ({ message: 'Choose the channel this arrived through' }),
    }),
    channelOther: otherNameSchema.optional(),
  })
  .superRefine((value, ctx) => {
    checkOther(value.leadSource, value.leadSourceOther, 'leadSource', 'source', ctx);
    checkOther(value.channel, value.channelOther, 'channel', 'channel', ctx);
  });

/**
 * Looking a customer up by phone, before the lead is made.
 *
 * Phase 1 matches on digits alone — see `normalizePhone`. The country travels
 * with the query because it is stored and displayed on the customer, but it
 * does NOT take part in matching: the CRM holds no dialling-code data, and
 * inferring one would be guessing at which numbers are the same number.
 */
export const leadCustomerLookupSchema = z.object({
  /**
   * Deliberately more permissive than `customerPhoneSchema`.
   *
   * That schema governs what may be *stored* on a customer, and widening it
   * would change the Customer contract for every module. This governs what may
   * be *searched for*, which is a different question: somebody pastes a number
   * out of an email or a chat, dots and all, and a search box that refused
   * `(91) 98123.45678` would be rejecting a perfectly findable customer over
   * punctuation the matcher is about to discard anyway.
   *
   * Still bounded, and still requires at least seven digits, so this cannot
   * become a way to enumerate the customer directory with a single character.
   */
  phone: z
    .string()
    .trim()
    .min(1, 'Enter a phone number')
    .max(32)
    .refine((value) => value.replace(/\D/g, '').length >= 7, 'Enter a valid phone number'),
});

export const leadIdParamSchema = z.object({ id: cuidSchema });

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type LeadCustomerInput = z.infer<typeof leadCustomerSchema>;
export type LeadCustomerLookupQuery = z.infer<typeof leadCustomerLookupSchema>;
