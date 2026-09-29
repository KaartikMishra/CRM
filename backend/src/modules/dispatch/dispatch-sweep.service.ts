/**
 * The 24-hour deadline, enforced.
 *
 * A partial-dispatch request that Procurement never answers is allowed when its
 * deadline passes. The business reason is that silence should not hold goods
 * indefinitely: the warehouse asked, nobody objected for a day, and the parcel
 * goes.
 *
 * ### Why this is a sweep and not a timer
 *
 * A `setTimeout` for 24 hours dies with the process. Deploy, crash or restart
 * inside that window and the deadline is simply forgotten — the request sits
 * PENDING forever and the goods never move. So the deadline is a column, and
 * this sweep asks the database which rows have passed it. A process that was
 * down across a deadline settles it on the next boot, which is exactly why the
 * boot sweep exists.
 *
 * This mirrors `purgeExpired` in the notification module rather than
 * introducing a second scheduler: one architecture for "work that happens on a
 * clock", boot sweep plus interval, registered in server.ts.
 *
 * ### Correctness under concurrency
 *
 * Nothing here relies on in-memory state being right.
 *
 *   - **The clock is the database's.** `now()` inside the transaction, never
 *     `Date.now()`, so a server with a skewed clock cannot settle a request
 *     early or leave one hanging.
 *   - **Every write is conditional on PENDING.** A request a person decides in
 *     the same second matches zero rows here and is left exactly as that person
 *     left it. The human decision always wins; this only ever settles silence.
 *   - **One request per transaction.** A batch-wide transaction would make one
 *     contended row roll back the settlement of every other, and would hold the
 *     notification writes of unrelated orders hostage to it.
 *   - **`inFlight` is an optimisation, not the safety.** It stops this process
 *     overlapping itself on a slow sweep. It is not what makes double-processing
 *     impossible — the conditional update is — which is why a second process, or
 *     the same process after a restart, is also safe.
 */

import { databaseNow, prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import * as notifications from '../notification/notification.service.js';
import * as repo from './dispatch.repository.js';

/**
 * How many overdue requests one pass settles.
 *
 * Bounded so a long backlog — a process down for a week — cannot turn one sweep
 * into an unbounded run. Whatever is left is taken by the next pass, and the
 * deadlines are already in the past, so the order is what matters and that is
 * oldest-first.
 */
const SWEEP_BATCH = 100;

/**
 * Stops this process running two sweeps at once.
 *
 * Only a performance guard: correctness comes from the conditional update in
 * the repository, not from this flag. If it were the safety mechanism, a second
 * instance of the API would break the rule immediately.
 */
let inFlight = false;

export type SweepResult = {
  /** Requests moved from PENDING to ALLOWED by the deadline. */
  autoAllowed: number;
  /** Requests something else settled between the read and the write. */
  raced: number;
};

/**
 * Settles every request whose deadline has passed.
 *
 * Never throws. This runs on a timer with no request to fail and no user to
 * tell, so every failure is logged and the next pass tries again — a sweep that
 * crashed the process would take the whole API down for a housekeeping error.
 */
export async function sweepOverdueRequests(): Promise<SweepResult> {
  const result: SweepResult = { autoAllowed: 0, raced: 0 };

  if (inFlight) {
    logger.debug('Partial dispatch sweep already running; skipping this tick');
    return result;
  }

  inFlight = true;

  try {
    const now = await databaseNow();
    const overdue = await repo.findOverdueRequests(now, SWEEP_BATCH);
    if (overdue.length === 0) return result;

    for (const request of overdue) {
      try {
        const settled = await settleOne(request);
        if (settled) result.autoAllowed += 1;
        else result.raced += 1;
      } catch (error) {
        // One bad row must not stop the rest of the batch.
        logger.error(
          { err: error, requestId: request.id },
          'Failed to auto-allow an overdue partial dispatch request',
        );
      }
    }

    if (result.autoAllowed > 0 || result.raced > 0) {
      logger.info(result, 'Partial dispatch deadline sweep');
    }

    return result;
  } catch (error) {
    logger.error({ err: error }, 'Partial dispatch deadline sweep failed');
    return result;
  } finally {
    inFlight = false;
  }
}

/**
 * One request, in its own transaction.
 *
 * The four automatic-decision fields are written exactly as the table's
 * `partial_dispatch_auto_is_allowed` constraint requires, and for the same
 * reason it requires them: nobody decided this, so there is no decider to name
 * and no reason to quote. Writing a reason like "auto-approved after 24 hours"
 * would be this code putting words in an absent person's mouth, and the
 * dashboard could no longer tell an agreement from a silence.
 *
 * Returns false when the row was no longer PENDING — a person got there first.
 */
async function settleOne(request: {
  id: string;
  salesOrderId: string;
  requestedById: string;
}): Promise<boolean> {
  const notify = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);

    const count = await repo.decidePendingRequest(tx, request.id, {
      status: 'ALLOWED',
      autoDecided: true,
      decidedAt: now,
      // All three null, deliberately. See the note above.
      decidedById: null,
      reason: null,
      poa: null,
    });

    if (count === 0) return null;

    const row = await repo.findPartialRequest(tx, request.id);
    const recipients = [request.requestedById];

    await notifications.persist(
      tx,
      recipients,
      notifications.partialDispatchAutoAllowedDraft(
        row?.salesOrder.orderId ?? request.salesOrderId,
        request.id,
        request.salesOrderId,
      ),
    );

    await tx.auditLog.create({
      data: {
        action: 'dispatch.partial.auto_allowed',
        entityType: 'PartialDispatchRequest',
        entityId: request.id,
        // No actor: the deadline is not a person. A null here is what lets an
        // audit reader tell this apart from an administrator's decision.
        actorId: null,
        newValue: {
          salesOrderId: request.salesOrderId,
          status: 'ALLOWED',
          autoDecided: true,
          why: 'No response within 24 hours',
        },
      },
    });

    return recipients;
  });

  if (!notify) return false;

  // After commit, like every other notification in the CRM.
  await notifications.deliver(notify, 'PARTIAL_DISPATCH_AUTO_ALLOWED', request.id);
  return true;
}
