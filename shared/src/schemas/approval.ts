import { z } from 'zod';
import { APP_MODULES, APPROVAL_STATUSES, PERMISSION_ACTIONS } from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for the generic approval foundation.
 *
 * What these deliberately do NOT accept, in every case because the server is the
 * only thing entitled to decide it:
 *
 *   - **`requestedById`, `decidedById`.** Taken from the authenticated session.
 *     A caller must never be able to record a colleague as having asked for
 *     something, still less as having approved it.
 *   - **`status`.** A new request is always PENDING, and it moves only through
 *     the decide and cancel endpoints. Accepting it here would let a request be
 *     born APPROVED, which is the entire point of having approvals.
 *   - **`decidedAt`.** Stamped when the decision is actually recorded, so the
 *     timestamp cannot disagree with the status. The database enforces the
 *     pairing again with the approval_decision_consistency CHECK.
 *
 * `entityType` is a free string rather than an enum, matching AuditLog and
 * Notification: the set of approvable things grows with every module, and an
 * enum would mean a migration to approve a new kind of record.
 */

/** A model name as the service writes it — "LeaveRequest", not a table name. */
export const approvalEntityTypeSchema = z
  .string()
  .trim()
  .min(1, 'An approval must say what it is about')
  .max(64, 'Entity type is too long');

export const approvalStatusSchema = z.enum(APPROVAL_STATUSES, {
  errorMap: () => ({ message: 'Choose an approval status' }),
});

/**
 * Raising a request.
 *
 * `action` defaults to APPROVE because that is what deciding a request requires;
 * it is accepted at all so a module can demand a narrower capability than its
 * generic approver permission if it ever needs to.
 */
export const createApprovalRequestSchema = z.object({
  entityType: approvalEntityTypeSchema,
  entityId: cuidSchema,
  module: z.enum(APP_MODULES, {
    errorMap: () => ({ message: 'Choose which module governs this approval' }),
  }),
  action: z.enum(PERMISSION_ACTIONS).default('APPROVE'),
  reason: z.string().trim().max(1000, 'Keep the reason under 1000 characters').optional(),
  /**
   * What is being proposed. A record rather than `z.any()`, so a bare string or
   * array cannot arrive where the reader expects fields — and unknown values
   * inside it, because the shape differs per entity type and this is evidence to
   * display rather than data to query.
   */
  payload: z.record(z.unknown()).optional(),
});

/**
 * Deciding one.
 *
 * APPROVED or REJECTED only. CANCELLED is not reachable here because withdrawing
 * is the requester's act, not the approver's, and it has its own endpoint — if
 * both lived on this schema an approver could cancel somebody else's request and
 * it would read in the trail as though they had withdrawn it themselves.
 */
export const decideApprovalRequestSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Choose whether to approve or reject' }),
  }),
  /**
   * Required when rejecting, optional when approving.
   *
   * Somebody whose request was turned down needs to know why, and "no" with no
   * reason is the most common complaint about every approval system. Approving
   * needs no justification: the decision speaks for itself.
   */
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters').optional(),
}).refine(
  (value) => value.decision !== 'REJECTED' || (value.note?.length ?? 0) > 0,
  { message: 'Say why this is being rejected', path: ['note'] },
);

/** Withdrawing one's own request. The reason is optional; the act is the point. */
export const cancelApprovalRequestSchema = z.object({
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters').optional(),
});

/** The approver's queue, and one entity's history. */
export const approvalListQuerySchema = paginationSchema.extend({
  status: approvalStatusSchema.optional(),
  module: z.enum(APP_MODULES).optional(),
  entityType: approvalEntityTypeSchema.optional(),
  entityId: cuidSchema.optional(),
  /** Only requests this person may decide, rather than every pending one. */
  mine: z.coerce.boolean().optional(),
});

export const approvalParamSchema = z.object({ id: cuidSchema });

export type CreateApprovalRequestInput = z.infer<typeof createApprovalRequestSchema>;
export type DecideApprovalRequestInput = z.infer<typeof decideApprovalRequestSchema>;
export type CancelApprovalRequestInput = z.infer<typeof cancelApprovalRequestSchema>;
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;
