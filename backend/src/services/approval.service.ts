/**
 * The generic approval foundation.
 *
 * One table, one decision, recorded — `ApprovalRequest`, polymorphic on
 * entityType/entityId exactly as AuditLog and Notification already are.
 *
 * ### What this replaces, and what it deliberately does not
 *
 * Before this, the whole approval mechanism was `policies/approval.ts`:
 * `requiresApproval = actor.role !== 'ADMIN'`. It answers one narrow question
 * well — may this actor's own change skip the queue — and cannot answer the one
 * HR needs: who may decide somebody else's request, for a kind of record nobody
 * has heard of yet. Keying that on role makes every approval an administrator's
 * job, which breaks the moment a reporting manager must approve their own team's
 * leave without becoming a CRM administrator.
 *
 * Five shipped tables already implement request/decide by hand:
 * SalesItemChangeRequest, SalesChargeChangeRequest, PurchaseItemProductChange,
 * PurchaseDelayReason and ProcurementDelayReason. **None of them is migrated into
 * this table and none is touched.** They are load-bearing in shipped modules
 * carrying live data, and converting them is a data migration rather than a
 * foundation. This table is for what comes next.
 *
 * ### What this is not
 *
 * Not a workflow engine. No stages, no routing rules, no delegation chains, no
 * escalation. One request, one decision. Multi-step approval is additive later —
 * a stage column, a parent id — but inventing it now would mean guessing at a
 * shape the business has not described.
 */

import type { ApprovalStatus, AppModule, PermissionAction } from '@rs/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { AppError } from '../utils/AppError.js';
import {
  mayCancelApproval,
  mayDecideApproval,
  type Actor,
} from '../policies/approval.js';
import { resolvePermission } from './permission.service.js';

const requestSelect = {
  id: true,
  entityType: true,
  entityId: true,
  module: true,
  action: true,
  status: true,
  requestedById: true,
  requestedAt: true,
  reason: true,
  payload: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

export type ApprovalRequestView = Prisma.ApprovalRequestGetPayload<{
  select: typeof requestSelect;
}>;

/**
 * Raises a request.
 *
 * `entityType`/`entityId` are not verified to exist, and cannot be: the point of
 * polymorphism is that this table knows nothing about what it governs. The
 * calling module knows, and is the right place to check — this is the same
 * trade AuditLog and Notification already make.
 *
 * A second pending request for the same entity is refused. Without that, a
 * double-submitted form produces two requests, two approvers decide them
 * independently, and the second decision silently contradicts the first.
 */
export async function createApprovalRequest(
  actor: Actor,
  input: {
    entityType: string;
    entityId: string;
    module: AppModule;
    action?: PermissionAction;
    reason?: string;
    payload?: Record<string, unknown>;
  },
  tx: Prisma.TransactionClient = prisma,
): Promise<ApprovalRequestView> {
  const existing = await tx.approvalRequest.findFirst({
    where: {
      entityType: input.entityType,
      entityId: input.entityId,
      status: 'PENDING',
    },
    select: { id: true },
  });

  if (existing) {
    throw AppError.badRequest(
      'APPROVAL_ALREADY_PENDING',
      'There is already a request waiting for a decision on this.',
    );
  }

  return tx.approvalRequest.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      module: input.module,
      action: input.action ?? 'APPROVE',
      status: 'PENDING',
      requestedById: actor.id,
      reason: input.reason ?? null,
      payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: requestSelect,
  });
}

/**
 * Records a decision.
 *
 * Three things are checked, and the order is deliberate — the request is read
 * first so the permission question can be asked about the right module, rather
 * than about one the caller supplied.
 *
 * The update is conditional on the row still being PENDING
 * (`updateMany` + a status predicate rather than `update` by id), so two
 * approvers deciding the same request at the same moment cannot both succeed.
 * The loser is told the request was already decided instead of silently
 * overwriting the winner's answer — a read-then-write would lose that race.
 */
export async function decideApprovalRequest(
  actor: Actor,
  id: string,
  decision: { decision: 'APPROVED' | 'REJECTED'; note?: string },
): Promise<ApprovalRequestView> {
  const request = await prisma.approvalRequest.findUnique({
    where: { id },
    select: { id: true, module: true, action: true, status: true, requestedById: true },
  });

  if (!request) {
    throw AppError.notFound('APPROVAL_NOT_FOUND', 'That request could not be found.');
  }

  // Resolved through the same two-layer resolver every other request obeys, so a
  // per-user grant or revocation applies here exactly as it does everywhere else.
  const mayApprove = await resolvePermission(actor.id, actor.role, request.module, 'APPROVE');

  if (!mayDecideApproval({ ...actor, mayApprove }, request)) {
    // Deliberately one message for three causes — no permission, own request,
    // already decided. Distinguishing them would tell a caller which requests
    // exist and who raised them.
    throw new AppError(
      'APPROVAL_NOT_PERMITTED',
      403,
      'You cannot decide this request.',
    );
  }

  const decided = await prisma.approvalRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: decision.decision,
      decidedById: actor.id,
      decidedAt: new Date(),
      decisionNote: decision.note ?? null,
    },
  });

  if (decided.count === 0) {
    throw AppError.badRequest(
      'APPROVAL_ALREADY_DECIDED',
      'Somebody has already decided this request.',
    );
  }

  return readApprovalRequest(id);
}

/**
 * Withdraws one's own request.
 *
 * CANCELLED rather than deleted: the row is the evidence that the request was
 * made, and a withdrawn request is a historical fact like any other. The same
 * conditional update guards the same race.
 */
export async function cancelApprovalRequest(
  actor: Actor,
  id: string,
  note?: string,
): Promise<ApprovalRequestView> {
  const request = await prisma.approvalRequest.findUnique({
    where: { id },
    select: { id: true, status: true, requestedById: true },
  });

  if (!request) {
    throw AppError.notFound('APPROVAL_NOT_FOUND', 'That request could not be found.');
  }

  if (!mayCancelApproval(actor, request)) {
    throw new AppError(
      'APPROVAL_NOT_PERMITTED',
      403,
      'You can only withdraw a request you raised yourself, and only before it is decided.',
    );
  }

  const cancelled = await prisma.approvalRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'CANCELLED',
      // No decidedById or decidedAt: withdrawing is not deciding, and the
      // approval_decision_consistency CHECK enforces that distinction.
      decisionNote: note ?? null,
    },
  });

  if (cancelled.count === 0) {
    throw AppError.badRequest(
      'APPROVAL_ALREADY_DECIDED',
      'This request has already been decided.',
    );
  }

  return readApprovalRequest(id);
}

export async function readApprovalRequest(id: string): Promise<ApprovalRequestView> {
  const request = await prisma.approvalRequest.findUnique({
    where: { id },
    select: requestSelect,
  });

  if (!request) {
    throw AppError.notFound('APPROVAL_NOT_FOUND', 'That request could not be found.');
  }

  return request;
}

/** Every request against one thing, newest first — a detail page's history. */
export async function approvalHistoryFor(
  entityType: string,
  entityId: string,
): Promise<ApprovalRequestView[]> {
  return prisma.approvalRequest.findMany({
    where: { entityType, entityId },
    orderBy: { requestedAt: 'desc' },
    select: requestSelect,
  });
}

/**
 * Whether one entity is waiting on a decision.
 *
 * Exists so a caller does not fetch the whole history to answer a yes/no. The
 * composite index on (entityType, entityId, requestedAt) serves it.
 */
export async function hasPendingApproval(
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const pending = await prisma.approvalRequest.findFirst({
    where: { entityType, entityId, status: 'PENDING' },
    select: { id: true },
  });

  return pending !== null;
}

/**
 * The queue, cursor-paginated like every other list in the CRM.
 *
 * `mine` narrows to requests this person may actually decide, which is the view
 * an approver wants: it drops their own requests, because nobody decides their
 * own, and drops modules they hold no APPROVE on. That filtering needs the
 * resolver per module, so it is done over the distinct modules in the page rather
 * than per row — at most a handful of queries regardless of page size.
 */
export async function listApprovalRequests(
  actor: Actor,
  query: {
    cursor?: string;
    limit: number;
    status?: ApprovalStatus;
    module?: AppModule;
    entityType?: string;
    entityId?: string;
    mine?: boolean;
  },
): Promise<{ requests: ApprovalRequestView[]; nextCursor: string | null }> {
  const where: Prisma.ApprovalRequestWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.module ? { module: query.module } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    // Nobody decides their own request, so an approver's queue never shows one.
    ...(query.mine ? { requestedById: { not: actor.id } } : {}),
  };

  const rows = await prisma.approvalRequest.findMany({
    where,
    // One more than asked for: its presence is what says another page exists,
    // without a second count query.
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: requestSelect,
  });

  const page = rows.slice(0, query.limit);

  const visible = query.mine ? await filterToApprovable(actor, page) : page;

  return {
    requests: visible,
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Drops rows whose module this person holds no APPROVE on. */
async function filterToApprovable(
  actor: Actor,
  rows: ApprovalRequestView[],
): Promise<ApprovalRequestView[]> {
  const modules = [...new Set(rows.map((row) => row.module))];

  const decisions = await Promise.all(
    modules.map(async (module) => [
      module,
      await resolvePermission(actor.id, actor.role, module, 'APPROVE'),
    ] as const),
  );

  const allowed = new Map(decisions);

  return rows.filter((row) => allowed.get(row.module) === true);
}
