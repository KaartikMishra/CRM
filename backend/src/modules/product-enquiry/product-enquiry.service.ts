/**
 * Enquiry lifecycle: create, read, header edits, assignment and reopen.
 *
 * Product and vendor-response mutations live in their own services; submission
 * and the SLA live in theirs. This file owns the enquiry record itself.
 */

import type { Prisma } from '@rs/database';
import type {
  CreateEnquiryInput,
  EnquiryDetail,
  EnquiryListQuery,
  EnquirySummary,
  ReassignEnquiryInput,
  ReopenEnquiryInput,
  UpdateEnquiryInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import {
  canEditEnquiry,
  canReassignEnquiry,
  canReopenEnquiry,
} from '../../policies/enquiry-access.js';
import { recordEvent, recordEvents } from './enquiry-event.service.js';
import { allocateEnquiryNumber } from './enquiry-number.service.js';
import { openWindow } from './enquiry-sla.service.js';
import { assertNotClosed, assertReopenable } from './enquiry-status.js';
import { dimensionColumns, weightColumns } from './measurement-columns.js';
import * as repo from './product-enquiry.repository.js';

// ---------------------------------------------------------------------------
//  Shared lookups
// ---------------------------------------------------------------------------

export function notFound(): AppError {
  // §26 — the same answer whether the enquiry is absent or simply not this
  // person's to see, so an id cannot be probed for existence.
  return AppError.notFound('PRODUCT_ENQUIRY_NOT_FOUND', 'That enquiry could not be found.');
}

export function forbidden(): AppError {
  return new AppError(
    'FORBIDDEN_ENQUIRY_ACCESS',
    403,
    'You do not have access to this enquiry.',
  );
}

/**
 * Neon is a network hop away, so a transaction doing a handful of round trips
 * can outrun Prisma's 5-second default — especially when a row lock has other
 * requests queued behind it. Fifteen seconds is generous for the work these
 * transactions actually do while still failing fast on a genuine stall.
 */
export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * Reads the detail projection *after* the write transaction has committed.
 *
 * The read is large — products, vendor responses, the event timeline — and it
 * needs none of the transaction's guarantees. Running it inside would hold the
 * enquiry's row lock for the duration of a query nobody is racing on.
 */
export async function detailAfterCommit(
  id: string,
  now: Date,
): Promise<EnquiryDetail> {
  const detail = await repo.findDetail(id, now);
  if (!detail) throw notFound();
  return detail;
}

async function assertAssigneeIsUsable(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const assignee = await tx.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  });

  if (!assignee || !assignee.isActive) {
    throw AppError.badRequest(
      'INVALID_ASSIGNEE',
      'That employee cannot be assigned this enquiry.',
    );
  }
}

// ---------------------------------------------------------------------------
//  Create (§9, §28)
// ---------------------------------------------------------------------------

/**
 * One transaction: number, customer, enquiry, 1..20 products, history.
 *
 * Every business timestamp comes from a single `SELECT now()` taken inside the
 * transaction, so createdAt and slaDeadlineAt cannot straddle a clock tick and
 * Node's clock is never consulted.
 */
export async function createEnquiry(
  actor: AuthenticatedUser,
  input: CreateEnquiryInput,
): Promise<EnquiryDetail> {
  const { id, now } = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await assertAssigneeIsUsable(tx, input.assignedToId);

    // §3 — reuse the customer master; create only when explicitly asked to.
    const customerId = input.customer.customerId
      ? (
          await tx.customer.findUnique({
            where: { id: input.customer.customerId },
            select: { id: true },
          })
        )?.id
      : (await tx.customer.create({ data: input.customer.newCustomer! })).id;

    if (!customerId) {
      throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'That customer could not be found.');
    }

    const window = openWindow(at, env.ENQUIRY_SLA_MINUTES);
    const enquiryNo = await allocateEnquiryNumber(tx, at);

    const enquiry = await tx.productEnquiry.create({
      data: {
        enquiryNo,
        customerId,
        source: input.source,
        sourceDetail: input.sourceDetail ?? null,
        createdById: actor.id,
        assignedToId: input.assignedToId,
        slaMinutes: window.slaMinutes,
        createdAt: window.createdAt,
        slaDeadlineAt: window.slaDeadlineAt,
        products: {
          create: input.products.map((product, index) => ({
            lineNo: index + 1,
            name: product.name,
            quantity: product.quantity,
            imageId: product.imageAssetId ?? null,
            similarOptionNeeded: product.similarOptionNeeded,
            ...weightColumns(product.weight),
            ...dimensionColumns(product.dimension),
          })),
        },
      },
      select: { id: true },
    });

    await recordEvents(tx, [
      {
        enquiryId: enquiry.id,
        type: 'CREATED',
        actorId: actor.id,
        newValue: enquiryNo,
        metadata: { productCount: input.products.length, source: input.source },
      },
      {
        enquiryId: enquiry.id,
        type: 'ASSIGNED',
        actorId: actor.id,
        field: 'assignedToId',
        newValue: input.assignedToId,
      },
    ]);

    return { id: enquiry.id, now: at };
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Read (§10, §11)
// ---------------------------------------------------------------------------

export async function listEnquiries(
  query: EnquiryListQuery,
): Promise<{ items: EnquirySummary[]; nextCursor: string | null; serverTime: string }> {
  const now = await databaseNow();
  const { items, nextCursor } = await repo.list(query, now);
  return { items, nextCursor, serverTime: now.toISOString() };
}

export async function getEnquiry(
  id: string,
): Promise<{ enquiry: EnquiryDetail; serverTime: string }> {
  const now = await databaseNow();
  const enquiry = await repo.findDetail(id, now);
  if (!enquiry) throw notFound();
  return { enquiry, serverTime: now.toISOString() };
}

/**
 * §22/§34 — the employees an enquiry can be assigned to.
 *
 * Deliberately scoped to this module rather than exposed as a Users API: it
 * exists so the Towards picker and the Towards filter have something to show.
 * Returns identity only — no email, no hash, no permission matrix.
 */
export async function listAssignees(): Promise<
  { id: string; name: string; employeeId: string; role: AuthenticatedUser['role'] }[]
> {
  return prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, employeeId: true, role: true },
    orderBy: { name: 'asc' },
  });
}

// ---------------------------------------------------------------------------
//  Header edit (§34 PATCH)
// ---------------------------------------------------------------------------

/**
 * Deliberately narrow: source and sourceDetail only. Status, assignment and
 * every SLA field are unreachable here — they change through the explicit
 * business actions below, never through a general-purpose PATCH (§17, §19).
 */
export async function updateEnquiry(
  actor: AuthenticatedUser,
  id: string,
  input: UpdateEnquiryInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    const enquiry = await repo.findForPolicy(id, tx);
    if (!enquiry) throw notFound();
    assertNotClosed(enquiry.status);
    if (!canEditEnquiry({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    const before = await tx.productEnquiry.findUniqueOrThrow({
      where: { id },
      select: { source: true, sourceDetail: true },
    });

    const source = input.source ?? before.source;
    const sourceDetail =
      input.sourceDetail !== undefined ? input.sourceDetail : before.sourceDetail;

    // §5 — mirrors the other_source_specified CHECK with a readable message.
    if (source === 'OTHERS' && !sourceDetail) {
      throw AppError.validation('Specify the source when the enquiry came from "Others".', [
        { path: 'sourceDetail', message: 'Specify the source' },
      ]);
    }

    await tx.productEnquiry.update({
      where: { id },
      data: { source, sourceDetail: sourceDetail ?? null },
    });

    if (source !== before.source) {
      await recordEvent(tx, {
        enquiryId: id,
        type: 'PRODUCT_UPDATED',
        actorId: actor.id,
        field: 'source',
        oldValue: before.source,
        newValue: source,
      });
    }

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Assignment (§22)
// ---------------------------------------------------------------------------

/**
 * Reassigning is an ADMIN action and never silent: the old and new assignee,
 * the actor and the time all land in the timeline. Assigning to the person who
 * already holds it is a no-op, which keeps retries clean (§29).
 */
export async function assignEnquiry(
  actor: AuthenticatedUser,
  id: string,
  input: ReassignEnquiryInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockEnquiry(tx, id);

    const enquiry = await repo.findForPolicy(id, tx);
    if (!enquiry) throw notFound();
    assertNotClosed(enquiry.status);
    if (!canReassignEnquiry({ id: actor.id, role: actor.role })) throw forbidden();

    await assertAssigneeIsUsable(tx, input.assignedToId);

    // §29 — assigning to the current holder is a no-op, so a retry adds no
    // second REASSIGNED event.
    if (enquiry.assignedToId === input.assignedToId) {
      return at;
    }

    await tx.productEnquiry.update({
      where: { id },
      data: { assignedToId: input.assignedToId },
    });

    await recordEvent(tx, {
      enquiryId: id,
      type: 'REASSIGNED',
      actorId: actor.id,
      field: 'assignedToId',
      oldValue: enquiry.assignedToId,
      newValue: input.assignedToId,
      ...(input.note ? { metadata: { note: input.note } } : {}),
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

// ---------------------------------------------------------------------------
//  Reopen (§24)
// ---------------------------------------------------------------------------

/**
 * The only sanctioned way out of CLOSED. Admin only, reason mandatory, fully
 * audited — and the frozen SLA fields are left exactly as they were, because
 * reopening an enquiry does not un-answer it (§20).
 */
export async function reopenEnquiry(
  actor: AuthenticatedUser,
  id: string,
  input: ReopenEnquiryInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    await repo.lockEnquiry(tx, id);

    const enquiry = await repo.findForPolicy(id, tx);
    if (!enquiry) throw notFound();
    // Status first, so "this enquiry is not closed" beats a bare 403. Once it
    // is known to be CLOSED, the policy reduces to the ADMIN check.
    assertReopenable(enquiry.status);
    if (!canReopenEnquiry({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    await tx.productEnquiry.update({
      where: { id },
      // closedAt/closedById clear together, satisfying closed_has_closer.
      data: { status: 'OPEN', closedAt: null, closedById: null },
    });

    await recordEvent(tx, {
      enquiryId: id,
      type: 'REOPENED',
      actorId: actor.id,
      field: 'status',
      oldValue: 'CLOSED',
      newValue: 'OPEN',
      metadata: { reason: input.reason },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}
