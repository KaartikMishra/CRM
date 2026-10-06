import { z } from 'zod';
import {
  POST_SALES_ACTIVITY_KINDS,
  POST_SALES_ATTACHMENT_KINDS,
  POST_SALES_CASE_STATUSES,
  POST_SALES_CASE_TYPES,
  POST_SALES_COMMUNICATION_CHANNELS,
  POST_SALES_COMMUNICATION_DIRECTIONS,
  POST_SALES_ISSUE_CATEGORIES,
  POST_SALES_PRIORITIES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for Post Sales & Grievance — Phase 1, the core case foundation.
 *
 * What these deliberately do NOT accept, in every case because the server is the
 * only thing entitled to decide it:
 *
 *   - **`caseNumber`.** Allocated from a counter inside the creating transaction.
 *     A client-supplied number would collide.
 *   - **`raisedById`, `performedById`.** Taken from the authenticated session. A
 *     caller must never be able to record a colleague as having done their work.
 *   - **`status`.** A new case is always NEW. Status moves through the transition
 *     endpoint, which validates the move; accepting it here would let a case be
 *     born CLOSED.
 *   - **`resolvedAt`, `closedAt`.** Stamped by the service when the status
 *     actually reaches those states, so the timestamps cannot disagree with it.
 */

export const postSalesCaseTypeSchema = z.enum(POST_SALES_CASE_TYPES, {
  errorMap: () => ({ message: 'Choose what this case is about' }),
});

export const postSalesIssueCategorySchema = z.enum(POST_SALES_ISSUE_CATEGORIES, {
  errorMap: () => ({ message: 'Choose the issue category' }),
});

export const postSalesPrioritySchema = z.enum(POST_SALES_PRIORITIES, {
  errorMap: () => ({ message: 'Choose a priority' }),
});

export const postSalesCaseStatusSchema = z.enum(POST_SALES_CASE_STATUSES, {
  errorMap: () => ({ message: 'Choose a case status' }),
});

export const postSalesActivityKindSchema = z.enum(POST_SALES_ACTIVITY_KINDS, {
  errorMap: () => ({ message: 'Choose what kind of entry this is' }),
});

/** Free text an employee types. Generous, but bounded so a body cannot be a book. */
const SUBJECT_MAX = 300;
const DESCRIPTION_MAX = 5000;
const NOTE_MAX = 5000;

/**
 * One affected order line.
 *
 * `salesOrderItemId` only — the product, SKU, price and image all come from the
 * line itself through relations that already exist. A quantity because a
 * complaint is often about some of what was bought, not all of it.
 *
 * The service checks the line belongs to the case's order. That cannot be
 * expressed here: Zod sees one payload, not the database.
 */
export const postSalesCaseItemSchema = z.object({
  salesOrderItemId: cuidSchema,
  affectedQty: z
    .number({ invalid_type_error: 'Affected quantity must be a number' })
    .int('Affected quantity must be a whole number')
    .positive('Affected quantity must be at least one'),
});

/**
 * Raising a case.
 *
 * The customer is required and the order is not, deliberately: a product-care
 * question or a piece of feedback may arrive with no order behind it, and
 * demanding one would force somebody to attach an unrelated order to file it.
 *
 * Items are permitted only alongside an order — an affected line with no order is
 * a line belonging to nothing, which the service also refuses.
 */
export const createPostSalesCaseSchema = z
  .object({
    customerId: cuidSchema,
    salesOrderId: cuidSchema.optional(),
    /** Only for delivery-shaped cases. Read-only reference; Dispatch is untouched. */
    dispatchId: cuidSchema.optional(),

    caseType: postSalesCaseTypeSchema,
    issueCategory: postSalesIssueCategorySchema,
    priority: postSalesPrioritySchema.default('MEDIUM'),

    subject: z.string().trim().min(1, 'Enter a short subject').max(SUBJECT_MAX),
    description: z
      .string()
      .trim()
      .min(1, 'Describe what the customer reported')
      .max(DESCRIPTION_MAX),

    /** Optional at creation: a case may be raised before anybody owns it. */
    assignedToId: cuidSchema.optional(),

    items: z.array(postSalesCaseItemSchema).max(50).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.items && value.items.length > 0 && !value.salesOrderId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salesOrderId'],
        message: 'Choose the order these items belong to',
      });
    }

    // One line at most once. A second entry for the same line is an edit of the
    // quantity, not a second affected line.
    if (value.items) {
      const ids = value.items.map((i) => i.salesOrderItemId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items'],
          message: 'Each order line may be listed once',
        });
      }
    }
  });

/**
 * Editing a case.
 *
 * Narrow on purpose. The customer and the order are what the case *is* — changing
 * either would make it a different case, and correcting a mis-filed one means
 * raising the right case rather than rewriting this one. Status has its own
 * endpoint because it is validated against a transition map, and assignment has
 * its own because it is gated on a different capability.
 */
export const updatePostSalesCaseSchema = z
  .object({
    caseType: postSalesCaseTypeSchema.optional(),
    issueCategory: postSalesIssueCategorySchema.optional(),
    priority: postSalesPrioritySchema.optional(),
    subject: z.string().trim().min(1).max(SUBJECT_MAX).optional(),
    description: z.string().trim().min(1).max(DESCRIPTION_MAX).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Moving a case.
 *
 * The target status and an optional reason. The move itself is checked against
 * `canTransitionCase` by the service — a payload cannot carry the permission to
 * make an illegal jump.
 */
export const postSalesCaseStatusChangeSchema = z.object({
  status: postSalesCaseStatusSchema,
  note: z.string().trim().max(NOTE_MAX).optional(),
});

/**
 * Allocating a case, or clearing the allocation.
 *
 * `assignedToId: null` means unassign — explicit null rather than an absent key,
 * so "clear it" and "change nothing" cannot be confused. Who performed the
 * allocation is never accepted: it is the authenticated actor.
 */
export const assignPostSalesCaseSchema = z.object({
  assignedToId: cuidSchema.nullable(),
});

/**
 * One timeline entry.
 *
 * Shape depends on the kind, and the cross-field rules below are what keep the
 * one table honest:
 *
 *   - a FOLLOW_UP needs a `dueAt`; a follow-up with no moment is a note
 *   - a CUSTOMER_COMMUNICATION needs a channel and a direction; without them
 *     there is no record of how the conversation happened
 *   - the three system kinds are refused outright — the service writes those, and
 *     a caller forging a STATUS_CHANGE entry would be falsifying history
 */
export const postSalesActivitySchema = z
  .object({
    kind: postSalesActivityKindSchema,
    note: z.string().trim().min(1, 'Enter what happened').max(NOTE_MAX),

    dueAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),

    channel: z.enum(POST_SALES_COMMUNICATION_CHANNELS).optional(),
    direction: z.enum(POST_SALES_COMMUNICATION_DIRECTIONS).optional(),
  })
  .superRefine((value, ctx) => {
    if (['SYSTEM', 'STATUS_CHANGE', 'ASSIGNMENT_CHANGE'].includes(value.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'That kind of entry is recorded by the system, not added by hand',
      });
    }

    if (value.kind === 'FOLLOW_UP' && !value.dueAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueAt'],
        message: 'Choose when this follow-up is due',
      });
    }

    if (value.kind === 'CUSTOMER_COMMUNICATION') {
      if (!value.channel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['channel'],
          message: 'Choose how the customer was contacted',
        });
      }
      if (!value.direction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['direction'],
          message: 'Say whether this was incoming or outgoing',
        });
      }
    }

    // A channel on anything else would describe a conversation that is not one.
    if (value.kind !== 'CUSTOMER_COMMUNICATION' && (value.channel || value.direction)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channel'],
        message: 'Only a customer communication carries a channel and direction',
      });
    }
  });

/**
 * Editing a timeline entry.
 *
 * `kind` is absent and stays absent — turning a note into a communication
 * rewrites what happened rather than correcting it, the same rule LeadActivity
 * follows. Completing a follow-up is a `completedAt`, so this is also the
 * "mark done" path.
 */
export const updatePostSalesActivitySchema = z
  .object({
    note: z.string().trim().min(1).max(NOTE_MAX).optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
    completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

/**
 * Attaching an already-uploaded image.
 *
 * A `mediaAssetId`, never a file: the upload goes through the existing Cloudinary
 * route, which is the one place binary data is handled. This records that an
 * existing asset belongs to this case.
 */
export const postSalesAttachmentSchema = z.object({
  mediaAssetId: cuidSchema,
  kind: z.enum(POST_SALES_ATTACHMENT_KINDS).default('OTHER'),
});

/** `/:id/activities/:activityId` — both ids validated, neither trusted. */
export const postSalesActivityParamSchema = z.object({
  id: cuidSchema,
  activityId: cuidSchema,
});

/** `/:id/attachments/:attachmentId`. */
export const postSalesAttachmentParamSchema = z.object({
  id: cuidSchema,
  attachmentId: cuidSchema,
});

export const postSalesCaseParamSchema = z.object({ id: cuidSchema });

export const postSalesCustomerParamSchema = z.object({ customerId: cuidSchema });

/**
 * The orderings the board offers, as an allowlist.
 *
 * `lastActivityAt` is absent deliberately: it is derived from the activity rows,
 * so Postgres cannot order by it without a per-case subquery — the N+1 the list
 * query is shaped to avoid.
 */
export const POST_SALES_SORTS = ['createdAt', 'updatedAt', 'priority', 'status'] as const;
export type PostSalesSort = (typeof POST_SALES_SORTS)[number];

/**
 * The case board's query.
 *
 * Every filter is applied in SQL — none is derived — so a page is a page and the
 * cursor means what it says. `mine` is resolved against the authenticated user by
 * the service rather than taking an id, so somebody cannot read "my cases" as
 * somebody else.
 */
export const postSalesListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(160).optional(),
  caseType: postSalesCaseTypeSchema.optional(),
  issueCategory: postSalesIssueCategorySchema.optional(),
  priority: postSalesPrioritySchema.optional(),
  status: postSalesCaseStatusSchema.optional(),
  assignedToId: cuidSchema.optional(),
  /** Only cases assigned to the caller. Needs no id and accepts none. */
  mine: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  /** Open means not RESOLVED and not CLOSED — see POST_SALES_OPEN_STATUSES. */
  openOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  channel: z.enum(POST_SALES_COMMUNICATION_CHANNELS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(POST_SALES_SORTS).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type CreatePostSalesCaseInput = z.infer<typeof createPostSalesCaseSchema>;
export type UpdatePostSalesCaseInput = z.infer<typeof updatePostSalesCaseSchema>;
export type PostSalesCaseStatusChangeInput = z.infer<typeof postSalesCaseStatusChangeSchema>;
export type AssignPostSalesCaseInput = z.infer<typeof assignPostSalesCaseSchema>;
export type PostSalesActivityInput = z.infer<typeof postSalesActivitySchema>;
export type UpdatePostSalesActivityInput = z.infer<typeof updatePostSalesActivitySchema>;
export type PostSalesAttachmentInput = z.infer<typeof postSalesAttachmentSchema>;
export type PostSalesListQuery = z.infer<typeof postSalesListQuerySchema>;
export type PostSalesCaseItemInput = z.infer<typeof postSalesCaseItemSchema>;
