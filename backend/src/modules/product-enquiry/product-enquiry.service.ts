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
import * as notification from '../notification/notification.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import {
  canEditEnquiry,
  canReassignEnquiry,
  canReopenEnquiry,
  canViewCustomerContact,
} from '../../policies/enquiry-access.js';
import { resolvePermission } from '../../services/permission.service.js';
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
 * Whether this person may see who the enquiry is for.
 *
 * Resolved through the same permission service the routes use, so a per-user
 * override applies here exactly as it does there: revoke PRODUCT_ENQUIRY CREATE
 * from somebody and they become an Answerer — able to read every enquiry, able
 * to see no customer — with nothing else to switch.
 */
const mayRaiseEnquiry = (actor: AuthenticatedUser): Promise<boolean> =>
  resolvePermission(actor.id, actor.role, 'PRODUCT_ENQUIRY', 'CREATE');

/**
 * Reads the detail projection *after* the write transaction has committed.
 *
 * The read is large — products, vendor responses, the event timeline — and it
 * needs none of the transaction's guarantees. Running it inside would hold the
 * enquiry's row lock for the duration of a query nobody is racing on.
 */
export async function detailAfterCommit(
  actor: AuthenticatedUser,
  id: string,
  now: Date,
): Promise<EnquiryDetail> {
  /*
    Resolved here rather than trusted from the caller, because an Answerer
    legitimately reaches this path: adding a vendor response and submitting are
    exactly their job, and both return the detail payload. Taking the actor and
    deciding inside means no write route can hand back an unredacted customer by
    forgetting to ask.
  */
  const canSeeCustomer = canViewCustomerContact(await mayRaiseEnquiry(actor));
  const detail = await repo.findDetail(id, now, canSeeCustomer);
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
  const { id, now, assignedToId } = await prisma.$transaction(async (tx) => {
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

    // Written inside the transaction that creates the enquiry, so a rolled-back
    // creation cannot leave somebody told about an enquiry that never existed.
    // Only the Towards user is told; an enquiry is one person's queue.
    await notification.persist(
      tx,
      [input.assignedToId],
      notification.enquiryAssignedDraft(enquiryNo, enquiry.id),
    );

    return { id: enquiry.id, now: at, assignedToId: input.assignedToId };
  }, TX_OPTIONS);

  // After commit, never before: delivery is best-effort and must not be able
  // to fail an enquiry that has already been created.
  await notification.deliver([assignedToId], 'ENQUIRY_ASSIGNED', id);

  return detailAfterCommit(actor, id, now);
}

// ---------------------------------------------------------------------------
//  Read (§10, §11)
// ---------------------------------------------------------------------------

export async function listEnquiries(
  actor: AuthenticatedUser,
  query: EnquiryListQuery,
): Promise<{ items: EnquirySummary[]; nextCursor: string | null; serverTime: string }> {
  const canSeeCustomer = canViewCustomerContact(await mayRaiseEnquiry(actor));
  const now = await databaseNow();
  const { items, nextCursor } = await repo.list(query, now, canSeeCustomer);
  return { items, nextCursor, serverTime: now.toISOString() };
}

export async function getEnquiry(
  actor: AuthenticatedUser,
  id: string,
): Promise<{ enquiry: EnquiryDetail; serverTime: string }> {
  const canSeeCustomer = canViewCustomerContact(await mayRaiseEnquiry(actor));
  const now = await databaseNow();
  const enquiry = await repo.findDetail(id, now, canSeeCustomer);
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

  return detailAfterCommit(actor, id, now);
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
  const { at: now, notify } = await prisma.$transaction(async (tx) => {
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
      // Nothing changed, so nobody is told. A retry must not re-notify.
      return { at, notify: false as const };
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

    // findForPolicy selects only what the policy checks need, so the human
    // number is read here rather than widening that query for every caller.
    const { enquiryNo } = await tx.productEnquiry.findUniqueOrThrow({
      where: { id },
      select: { enquiryNo: true },
    });

    // Only the new holder is told — reassignment moves one person's queue.
    await notification.persist(
      tx,
      [input.assignedToId],
      notification.enquiryAssignedDraft(enquiryNo, id),
    );

    return { at, notify: true as const };
  }, TX_OPTIONS);

  if (notify) {
    await notification.deliver([input.assignedToId], 'ENQUIRY_ASSIGNED', id);
  }

  return detailAfterCommit(actor, id, now);
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

  return detailAfterCommit(actor, id, now);
}
