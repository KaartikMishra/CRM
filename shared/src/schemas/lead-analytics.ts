import { z } from 'zod';
import {
  LEAD_CHANNELS,
  LEAD_OTHER_MAX_LENGTH,
  LEAD_PROMPTNESS_RATINGS,
} from '../constants/index.js';
import {
  DEAL_STATUSES,
  DIMENSION_UNITS,
  LEAD_ACTIVITY_KINDS,
  PRODUCT_MATCH_KINDS,
  WEIGHT_UNITS,
} from '../enums.js';
import { amountSchema, cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for the Lead/Deal analytics phases.
 *
 * Phase 4B ships the vocabularies and the one rule that is genuinely a contract
 * rather than an endpoint: a matched product and its match kind travel together.
 * The endpoints that consume these arrive in later phases; putting the shapes in
 * now is what lets the database CHECK constraints and the Zod schemas be written
 * from the same statement of the rule rather than from two readings of it.
 *
 * Deliberately absent: any promptness input schema. Promptness is never
 * submitted — it is derived from LeadActivity rows on every read, so there is
 * nothing for a caller to send and nothing to validate.
 */

export const dealStatusSchema = z.enum(DEAL_STATUSES, {
  errorMap: () => ({ message: 'Choose a deal status' }),
});

export const leadActivityKindSchema = z.enum(LEAD_ACTIVITY_KINDS, {
  errorMap: () => ({ message: 'Choose what kind of action this is' }),
});

export const productMatchKindSchema = z.enum(PRODUCT_MATCH_KINDS, {
  errorMap: () => ({ message: 'Say whether this is the exact product or a similar one' }),
});

/**
 * The weight and dimension fields, lifted from the enquiry contract.
 *
 * Same names and same units as EnquiryProduct, because a requirement describes
 * goods the same way an enquiry line does — and because the normalised
 * companions (`weightInGrams`, `lengthMm` …) are computed by the same helpers in
 * `utils/units.ts` rather than being sent by the caller.
 */
const measurementShape = {
  weightValue: z.number().positive('Weight must be greater than zero').optional(),
  weightUnit: z.enum(WEIGHT_UNITS).optional(),
  lengthValue: z.number().positive('Dimension must be greater than zero').optional(),
  widthValue: z.number().positive('Dimension must be greater than zero').optional(),
  heightValue: z.number().positive('Dimension must be greater than zero').optional(),
  dimensionUnit: z.enum(DIMENSION_UNITS).optional(),
};

/**
 * One line of what the customer wants.
 *
 * Two rules are stated here and again as CHECK constraints on the table, so a
 * row written by any caller obeys them:
 *
 *   - **A match kind needs a product.** `matchKind` without `rsProductId`
 *     describes nothing. The reverse is allowed: a product may be attached
 *     before anybody has decided whether it is exact or merely close.
 *   - **A quantity is positive.** Zero of something is not a requirement.
 *
 * `productValue` permits zero: a sample or a replacement can legitimately be
 * worth nothing, which is different from being unpriced (null).
 *
 * Volume is absent, and stays absent. It is lengthMm × widthMm × heightMm,
 * derived wherever it is shown.
 */
export const leadProductRequirementSchema = z
  .object({
    productName: z.string().trim().min(1, 'Product name is required').max(500),
    imageId: cuidSchema.optional(),
    rsProductId: cuidSchema.optional(),
    matchKind: productMatchKindSchema.optional(),
    quantity: z
      .number({ invalid_type_error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .positive('Quantity must be at least one'),
    ...measurementShape,
    /** Non-negative when supplied. Reuses the money contract, so one amount
        rule governs every price in the CRM. */
    productValue: amountSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.matchKind && !value.rsProductId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rsProductId'],
        message: 'Choose the catalogue product this matches',
      });
    }

    /*
      A weight figure and its unit are one answer. Without the unit the number
      cannot be normalised to grams, so it would be stored meaning nothing.
    */
    if (value.weightValue !== undefined && !value.weightUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weightUnit'],
        message: 'Choose a weight unit',
      });
    }

    const hasDimension =
      value.lengthValue !== undefined ||
      value.widthValue !== undefined ||
      value.heightValue !== undefined;

    if (hasDimension && !value.dimensionUnit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensionUnit'],
        message: 'Choose a dimension unit',
      });
    }
  });

/**
 * One expected action on a lead.
 *
 * `completedAt` is optional and means exactly what its absence says: not done
 * yet. It is never defaulted to now — "outstanding" and "done the moment it was
 * recorded" are different facts, and promptness reads the difference.
 */
export const leadActivitySchema = z.object({
  kind: leadActivityKindSchema,
  dueAt: z
    .string({ required_error: 'Enter when this was due' })
    .datetime({ offset: true, message: 'Enter a valid date and time' }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(LEAD_OTHER_MAX_LENGTH * 10).optional(),
});

/**
 * Editing one activity.
 *
 * Every field optional — the form sends what changed — with `completedAt`
 * nullable so an action can be reopened by clearing it. An absent key means
 * "leave it alone"; an explicit null means "it did not happen after all".
 *
 * `kind` is absent deliberately: what sort of action a row records is what it
 * is, and turning a FIRST_CONTACT into a RESULT would rewrite history rather
 * than correct it. Delete and re-add instead.
 */
export const updateLeadActivitySchema = z
  .object({
    dueAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).nullable().optional(),
    note: z.string().trim().max(LEAD_OTHER_MAX_LENGTH * 10).nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Change at least one field',
  );

/**
 * Editing a lead — Phase 4C.
 *
 * Deliberately narrow: only the deal status. Assignment is NOT here, because it
 * is gated on a different capability (ASSIGN, not EDIT) and giving it its own
 * endpoint is what lets the route table state that rather than the service
 * inferring a permission from which keys happen to be present in a body.
 *
 * Nothing from Phase 1 is editable through this: the source, the moment, the
 * requirement type and the customer are what the lead *was*, and correcting one
 * is a different operation from managing the deal.
 */
export const updateLeadSchema = z.object({
  dealStatus: dealStatusSchema,
});

/**
 * Assigning a lead, or clearing its assignment.
 *
 * `associateId: null` means unassign. Explicit null rather than an absent key,
 * so "clear the associate" and "change nothing" cannot be confused — the same
 * distinction `updateVariantSchema` draws in RS Products.
 *
 * `allocatedById` is never accepted from the caller. Who performed an allocation
 * is the authenticated actor, and taking it from the body would let somebody
 * record a colleague as having made their decision.
 */
export const assignLeadSchema = z.object({
  associateId: cuidSchema.nullable(),
});

/** `/:id/activities/:activityId` — both ids, so neither is trusted as text. */
export const leadActivityParamSchema = z.object({
  id: cuidSchema,
  activityId: cuidSchema,
});

// ---------------------------------------------------------------------------
//  Complete the Ideal — Phase 4F
// ---------------------------------------------------------------------------

/** `/:id/requirements/:requirementId` — both ids validated, neither trusted. */
export const leadRequirementParamSchema = z.object({
  id: cuidSchema,
  requirementId: cuidSchema,
});

/**
 * Editing one requirement line.
 *
 * Every field is nullable as well as optional, and the difference carries
 * meaning the UI depends on:
 *
 *   absent   leave it as it is
 *   null     clear it — drop the photo, unmatch the product, forget the weight
 *   value    set it
 *
 * `leadId` and `lineNo` are absent and stay absent. A line belongs to the lead
 * in the URL, and moving one between leads or renumbering it is not editing —
 * Phase 4F ships no reorder, so there is nothing legitimate to send.
 *
 * The three cross-field rules are restated rather than inherited, because
 * `leadProductRequirementSchema` validates a whole row while this validates a
 * patch: "weight without a unit" is wrong in a create, but in a patch the unit
 * may already be in the database. So each rule here fires only when the pair it
 * governs is actually being written, and the service checks the merged result
 * against the complete contract afterwards.
 */
export const updateLeadRequirementSchema = z
  .object({
    productName: z.string().trim().min(1, 'Product name is required').max(500).optional(),
    imageId: cuidSchema.nullable().optional(),
    rsProductId: cuidSchema.nullable().optional(),
    matchKind: productMatchKindSchema.nullable().optional(),
    quantity: z
      .number({ invalid_type_error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .positive('Quantity must be at least one')
      .optional(),
    weightValue: z.number().positive('Weight must be greater than zero').nullable().optional(),
    weightUnit: z.enum(WEIGHT_UNITS).nullable().optional(),
    lengthValue: z.number().positive('Dimension must be greater than zero').nullable().optional(),
    widthValue: z.number().positive('Dimension must be greater than zero').nullable().optional(),
    heightValue: z.number().positive('Dimension must be greater than zero').nullable().optional(),
    dimensionUnit: z.enum(DIMENSION_UNITS).nullable().optional(),
    productValue: amountSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field')
  .superRefine((value, ctx) => {
    /*
      Unmatching a product takes its match kind with it. Stated here so the
      caller is told which field is wrong, rather than meeting the table's CHECK
      constraint as a 500.
    */
    if (value.rsProductId === null && value.matchKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matchKind'],
        message: 'Remove the match kind when clearing the product',
      });
    }
  });

export type DealStatusInput = z.infer<typeof dealStatusSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;
export type LeadActivityInput = z.infer<typeof leadActivitySchema>;
export type UpdateLeadActivityInput = z.infer<typeof updateLeadActivitySchema>;
export type LeadProductRequirementInput = z.infer<typeof leadProductRequirementSchema>;
export type UpdateLeadRequirementInput = z.infer<typeof updateLeadRequirementSchema>;

// ---------------------------------------------------------------------------
//  The analytics list — Phase 4E
// ---------------------------------------------------------------------------

/**
 * How the analytics table may be ordered.
 *
 * An allowlist, never a client-supplied column name: every member maps to a
 * concrete ordering the repository knows how to build, so nothing a caller
 * sends can reach an ORDER BY clause.
 *
 * `lastFollowUpAt` and `nextFollowUpAt` are deliberately absent. Both are
 * derived from activity rows rather than stored, so Postgres cannot order by
 * them without a correlated subquery per lead — which is the N+1 this phase
 * exists to avoid. The table sorts on what the database actually holds.
 */
export const LEAD_SORTS = ['initiatedAt', 'dealStatus', 'createdAt'] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

/** SELF / OTHER_USER / UNASSIGNED, as a filter value. */
export const ALLOCATION_KINDS = ['SELF', 'OTHER_USER', 'UNASSIGNED'] as const;

/**
 * The analytics list query.
 *
 * Cursor pagination, following `paginationSchema` and every other list in the
 * CRM — not page numbers. `q` searches the customer and the lead's own source
 * note, which is what staff actually have to hand when they go looking.
 *
 * Two filters are marked derived below. Promptness and allocation are computed
 * from activity rows and a pair of ids, so neither can be expressed in SQL; the
 * service applies them after calculating, and the response reports whether the
 * page was narrowed that way. Stated here so a reader of the contract knows
 * which filters are cheap and which are not.
 */
export const leadListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  dealStatus: dealStatusSchema.optional(),
  associateId: cuidSchema.optional(),
  channel: z.enum(LEAD_CHANNELS).optional(),
  /** Derived — applied after promptness is calculated. */
  promptness: z.enum(LEAD_PROMPTNESS_RATINGS).optional(),
  /** Derived — applied after allocation is resolved. */
  allocation: z.enum(ALLOCATION_KINDS).optional(),
  /**
   * Follow-up state, also derived.
   *
   *   overdue   at least one follow-up past its due moment and not done
   *   upcoming  at least one incomplete follow-up still to come
   */
  followUp: z.enum(['overdue', 'upcoming']).optional(),
  sort: z.enum(LEAD_SORTS).default('initiatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;
