/**
 * Partial dispatch: asking whether part of an order may go now, and answering.
 *
 * The question only exists in one situation — some of an order is ready and
 * some is not. Dispatch would rather send the ready half than have it sit;
 * Procurement may prefer it waits, because a second parcel costs a second
 * freight charge and a customer who receives half an order often asks where the
 * rest is. So Dispatch asks and Procurement answers.
 *
 * ### The four endings
 *
 *   ALLOWED by a person   somebody agreed, and said why. A plan of action is
 *                         optional: permitting needs no alternative plan.
 *   DISALLOWED            somebody refused, and said why AND what happens
 *                         instead — a refusal leaves goods sitting, so it owes
 *                         the warehouse a plan.
 *   ALLOWED automatically the deadline passed with no answer. `autoDecided` is
 *                         true, and `reason`, `poa` and `decidedById` are all
 *                         null, because nobody decided it. Inventing a reason
 *                         here would put words in an absent person's mouth.
 *   MOOT                  the rest of the order became ready, so the question
 *                         stopped applying. Nobody is notified: nothing was
 *                         decided and nobody needs to act.
 *
 * Every one of those shapes is also a CHECK constraint on the table. The rules
 * are stated twice on purpose — once here where they are readable, once in the
 * database where they are enforced against every writer, including a future one
 * that has not read this file.
 *
 * ### What this file never does
 *
 * It does not move stock, and it does not dispatch anything. An ALLOWED request
 * is permission to pack a partial shipment, not a shipment: somebody still has
 * to create one. Keeping the two apart is what lets a permission be granted and
 * then not used.
 */

import type { Request } from 'express';
import type {
  CreatePartialDispatchRequestInput,
  DecidePartialDispatchInput,
  PartialDispatchRequestView,
  PendingPartialDispatchRow,
} from '@rs/shared';
import { PARTIAL_DISPATCH_DEADLINE_MS } from '@rs/shared';
import { Prisma } from '@rs/database';
import { databaseNow, prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { decidesOwnAction } from '../../policies/approval.js';
import * as notifications from '../notification/notification.service.js';
import { orderFullyReady, orderPartiallyReady } from './dispatch.calc.js';
import * as repo from './dispatch.repository.js';
import { readinessFor } from './dispatch.readiness.js';

/** Neon is a network hop away; the same budget the rest of the CRM uses. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

// ---------------------------------------------------------------------------
//  Raising the question
// ---------------------------------------------------------------------------

/**
 * Dispatch asks whether the ready part of an order may go.
 *
 * Three things are established under the order's lock, because all three can
 * change between the screen being drawn and the button being pressed:
 *
 *   1. The order is genuinely partial. Asking about a fully ready order is
 *      meaningless — just send it — and asking about one with nothing ready is
 *      asking to send an empty parcel. Both are refused rather than recorded,
 *      so the procurement queue only ever holds real questions.
 *   2. No question is already open. The partial unique index is the authority,
 *      but checking here turns a constraint violation into a sentence a person
 *      can read.
 *   3. The deadline. Stored as an absolute instant computed from database time,
 *      not from this process's clock — see the note on the sweep.
 *
 * ADMIN is the asymmetric case. An administrator needs no permission from
 * anybody, so their request is born ALLOWED in the same transaction rather than
 * sitting in a queue waiting for a decision they are already entitled to make.
 * That is a role test, never a permission test: a USER holding
 * `PROCUREMENT:ASSIGN` is powerful, but they are not an administrator, and
 * their request waits like anyone else's.
 */
export async function createRequest(
  req: Request,
  actor: AuthenticatedUser,
  input: CreatePartialDispatchRequestInput,
): Promise<PartialDispatchRequestView> {
  /*
    An administrator deciding their own request still has to say why. The
    decision is immediate, not unexplained — the record has to stand on its own
    when somebody reads it in three months and asks why half an order went.
  */
  const immediate = decidesOwnAction(actor);
  if (immediate && !input.reason) {
    throw AppError.badRequest(
      'REASON_REQUIRED',
      'Give the reason this partial dispatch is being allowed.',
    );
  }

  const { id, notify } = await prisma
    .$transaction(async (tx) => {
      await repo.lockOrder(tx, input.salesOrderId);

      const order = await repo.findOrderForDispatch(input.salesOrderId, tx);
      if (!order) {
        throw AppError.notFound('SALES_ORDER_NOT_FOUND', 'That sales order could not be found.');
      }

      if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
        throw AppError.conflict(
          'ORDER_NOT_DISPATCHABLE',
          `That order is ${order.status.toLowerCase()} and cannot be dispatched.`,
        );
      }

      const { lines } = readinessFor(order);

      if (orderFullyReady(lines)) {
        throw AppError.conflict(
          'ORDER_FULLY_READY',
          'The whole order is ready, so no permission is needed — dispatch it.',
        );
      }

      if (!orderPartiallyReady(lines)) {
        throw AppError.conflict(
          'NOTHING_DISPATCHABLE',
          'Nothing on this order is ready to send yet, so there is no partial dispatch to ask about.',
        );
      }

      const open = await repo.findPendingRequest(tx, input.salesOrderId);
      if (open) {
        throw AppError.conflict(
          'PARTIAL_REQUEST_ALREADY_OPEN',
          'A partial dispatch request is already awaiting a decision on this order.',
        );
      }

      // Database time, so the deadline does not depend on this process's clock
      // being right — the sweep compares against the same source.
      const now = await databaseNow(tx);
      const deadline = new Date(now.getTime() + PARTIAL_DISPATCH_DEADLINE_MS);

      const created = await repo.createPartialRequest(tx, {
        salesOrderId: input.salesOrderId,
        requestedById: actor.id,
        requestedAt: now,
        deadline,
        ...(immediate
          ? {
              status: 'ALLOWED' as const,
              decidedById: actor.id,
              decidedAt: now,
              reason: input.reason ?? null,
              poa: input.poa ?? null,
              autoDecided: false,
            }
          : {}),
      });

      /*
        Who hears about it depends on what just happened. An open question goes
        to Procurement, who have to answer it. One that was decided on the spot
        goes to nobody: the only person who would be told is the administrator
        who just did it.
      */
      const recipients = immediate ? [] : await notifications.partialDispatchDeciders();

      if (recipients.length > 0) {
        await notifications.persist(
          tx,
          recipients,
          notifications.partialDispatchRequestedDraft(order.orderId, created.id, input.salesOrderId),
        );
      }

      return {
        id: created.id,
        notify: { recipients, orderId: order.orderId },
      };
    }, TX_OPTIONS)
    .catch(rethrowDuplicatePending);

  // After commit, never before: a socket failure must not fail the request, and
  // nobody should be told about a row that then rolled back.
  await notifications.deliver(notify.recipients, 'PARTIAL_DISPATCH_REQUESTED', id);

  await recordAudit(req, {
    action: immediate ? 'dispatch.partial.allowed' : 'dispatch.partial.requested',
    entityType: 'PartialDispatchRequest',
    entityId: id,
    actorId: actor.id,
    newValue: {
      salesOrderId: input.salesOrderId,
      status: immediate ? 'ALLOWED' : 'PENDING',
      ...(immediate ? { reason: input.reason, poa: input.poa ?? null, byAdmin: true } : {}),
    },
  });

  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Answering it
// ---------------------------------------------------------------------------

/**
 * Procurement allows or refuses the partial dispatch.
 *
 * The conditional update is what makes this safe against the sweep. Both this
 * and the 24-hour sweep want to move the same row out of PENDING, and they can
 * genuinely collide — a decision submitted at the moment the deadline passes.
 * Rather than lock and re-read, the update names `status: 'PENDING'` in its own
 * WHERE clause: whichever transaction commits first wins, the other matches
 * zero rows and is told the question was already settled. No decision is ever
 * silently overwritten.
 *
 * Reason and plan of action are validated by the shared schema before arriving
 * here (ALLOW needs a reason, DISALLOW needs both) and again by the table's
 * CHECK constraints. This function does not re-state those rules; it enforces
 * the one thing neither of those can see, which is whether the question is
 * still open.
 */
export async function decide(
  req: Request,
  actor: AuthenticatedUser,
  requestId: string,
  input: DecidePartialDispatchInput,
): Promise<PartialDispatchRequestView> {
  const allowed = input.decision === 'ALLOW';

  const { notify, orderId, salesOrderId } = await prisma.$transaction(async (tx) => {
    const existing = await repo.findPartialRequest(tx, requestId);
    if (!existing) {
      throw AppError.notFound(
        'PARTIAL_REQUEST_NOT_FOUND',
        'That partial dispatch request could not be found.',
      );
    }

    if (existing.status !== 'PENDING') {
      throw settled(existing.status, existing.autoDecided);
    }

    const now = await databaseNow(tx);

    const count = await repo.decidePendingRequest(tx, requestId, {
      status: allowed ? 'ALLOWED' : 'DISALLOWED',
      decidedById: actor.id,
      decidedAt: now,
      reason: input.reason,
      poa: input.poa ?? null,
      autoDecided: false,
    });

    /*
      Zero rows means something else settled it between the read above and this
      write — the sweep, or another reviewer. Refusing is the only honest
      answer: the decision this person made was never applied.
    */
    if (count === 0) {
      const current = await repo.findPartialRequest(tx, requestId);
      throw settled(current?.status ?? 'ALLOWED', current?.autoDecided ?? false);
    }

    // The person who asked is the person who needs to know.
    const recipients = [existing.requestedById];

    await notifications.persist(
      tx,
      recipients,
      allowed
        ? notifications.partialDispatchAllowedDraft(
            existing.salesOrder.orderId,
            requestId,
            existing.salesOrderId,
          )
        : notifications.partialDispatchDisallowedDraft(
            existing.salesOrder.orderId,
            requestId,
            existing.salesOrderId,
          ),
    );

    return {
      notify: recipients,
      orderId: existing.salesOrder.orderId,
      salesOrderId: existing.salesOrderId,
    };
  }, TX_OPTIONS);

  await notifications.deliver(
    notify,
    allowed ? 'PARTIAL_DISPATCH_ALLOWED' : 'PARTIAL_DISPATCH_DISALLOWED',
    requestId,
  );

  await recordAudit(req, {
    action: `dispatch.partial.${allowed ? 'allowed' : 'disallowed'}`,
    entityType: 'PartialDispatchRequest',
    entityId: requestId,
    actorId: actor.id,
    newValue: {
      salesOrderId,
      orderId,
      status: allowed ? 'ALLOWED' : 'DISALLOWED',
      reason: input.reason,
      poa: input.poa ?? null,
    },
  });

  return loadView(requestId);
}

// ---------------------------------------------------------------------------
//  The question stopping applying
// ---------------------------------------------------------------------------

/**
 * Resolves an open request to MOOT when the whole order became ready.
 *
 * Called from Procurement's own reconciliation completion point, *after* that
 * work has committed its arithmetic — never from inside a stock mutation.
 * Readiness is Procurement's fact; this only reads the conclusion.
 *
 * Deliberately silent. Nothing was decided, nobody was overruled, and the
 * warehouse can now send the entire order — which they would have seen on the
 * board anyway. A notification here would read as an answer to a question that
 * simply stopped being asked.
 *
 * Idempotent twice over: it does nothing when no request is open, and its
 * update is conditional on the row still being PENDING, so a concurrent human
 * decision or sweep wins and this becomes a no-op rather than an overwrite.
 * It never throws — a reconciliation must not fail because a courtesy cleanup
 * could not run.
 */
export async function resolveMootForOrder(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
): Promise<void> {
  try {
    const open = await repo.findPendingRequest(tx, salesOrderId);
    if (!open) return;

    const order = await repo.findOrderForDispatch(salesOrderId, tx);
    if (!order) return;

    const { lines } = readinessFor(order);
    if (!orderFullyReady(lines)) return;

    await repo.decidePendingRequest(tx, open.id, {
      status: 'MOOT',
      decidedById: null,
      decidedAt: await databaseNow(tx),
      reason: null,
      poa: null,
      autoDecided: false,
    });
  } catch (error) {
    // A reconciliation is the caller's real work. This is housekeeping that
    // rides along with it, and housekeeping does not get to fail it.
    logger.error({ err: error, salesOrderId }, 'Failed to resolve partial dispatch request to MOOT');
  }
}

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

export async function listForOrder(salesOrderId: string): Promise<PartialDispatchRequestView[]> {
  const rows = await repo.listPartialRequests(salesOrderId);
  return rows.map(toView);
}

/**
 * Procurement's decision queue: every open question, with what it takes to
 * answer one.
 *
 * The quantities come from the same `readinessFor` the dispatch board reads,
 * so the two screens cannot disagree about how much of an order is ready — the
 * whole reason readiness is derived rather than stored. An order that vanished
 * between the two reads is skipped rather than reported with blank figures.
 */
export async function listPending(): Promise<PendingPartialDispatchRow[]> {
  const requests = await repo.findPendingPartialRequests();
  if (requests.length === 0) return [];

  const rows: PendingPartialDispatchRow[] = [];

  for (const request of requests) {
    const order = await repo.findOrderForDispatch(request.salesOrderId);
    if (!order) continue;

    const { lines } = readinessFor(order);

    rows.push({
      request: toView(request),
      orderId: order.orderId,
      customerName: order.customer.name,
      toBeDispatchedBy: order.toBeDispatchedBy.toISOString(),
      requiredQty: lines.reduce((sum, l) => sum + l.requiredQty, 0),
      readyQty: lines.reduce((sum, l) => sum + l.readyQty, 0),
      pendingQty: lines.reduce((sum, l) => sum + l.pendingQty, 0),
      readyLines: lines.filter((l) => l.pendingQty === 0).length,
      totalLines: lines.length,
    });
  }

  return rows;
}

export async function getRequest(id: string): Promise<PartialDispatchRequestView> {
  return loadView(id);
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * One conflict, phrased by what actually happened.
 *
 * The auto-allowed case is named specifically because it is the one a person
 * will not expect: they opened the screen, the deadline passed while they were
 * reading it, and their decision has no effect.
 */
function settled(status: string, autoDecided: boolean): AppError {
  if (autoDecided) {
    return AppError.conflict(
      'PARTIAL_REQUEST_AUTO_ALLOWED',
      'That request was automatically allowed when its 24-hour deadline passed, so it can no longer be decided.',
    );
  }

  const phrase =
    status === 'MOOT'
      ? 'no longer applies — the rest of the order became ready'
      : `has already been ${status.toLowerCase()}`;

  return AppError.conflict('PARTIAL_REQUEST_SETTLED', `That request ${phrase}.`);
}

/**
 * Turns the one-pending index into the module's vocabulary.
 *
 * The index is the authority on duplicates: two simultaneous requests both pass
 * the read above, and one still has to lose. Catching the constraint is what
 * makes that loss a sentence rather than a 500.
 */
function rethrowDuplicatePending(error: unknown): never {
  if ((error as { code?: string }).code === 'P2002') {
    throw AppError.conflict(
      'PARTIAL_REQUEST_ALREADY_OPEN',
      'A partial dispatch request is already awaiting a decision on this order.',
    );
  }
  throw error;
}

export function toView(row: repo.PartialRequestRecord): PartialDispatchRequestView {
  return {
    id: row.id,
    salesOrderId: row.salesOrderId,
    orderId: row.salesOrder.orderId,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    deadline: row.deadline.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
    poa: row.poa,
    autoDecided: row.autoDecided,
  };
}

async function loadView(id: string): Promise<PartialDispatchRequestView> {
  const row = await repo.findPartialRequest(prisma, id);
  if (!row) {
    throw AppError.notFound(
      'PARTIAL_REQUEST_NOT_FOUND',
      'That partial dispatch request could not be found.',
    );
  }
  return toView(row);
}
