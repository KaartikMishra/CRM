/**
 * §15–16, §21 — submission, the SLA stop, and the delay gate.
 *
 * Partial and Full Submit differ in exactly two respects: what they require of
 * the products, and what status they leave behind. Everything else — the delay
 * gate, the clock freeze, the event trail — is shared, which is why both go
 * through `submit()`.
 *
 * Partial Submit never closes the enquiry and never touches a pending line
 * (§15). Full Submit closes it only when every line is resolved (§16).
 */

import type { Prisma } from '@rs/database';
import type {
  DelayReasonInput,
  EnquiryDetail,
  EnquiryStatus,
  FullSubmitBlocker,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthenticatedUser } from '../../middleware/requireAuth.js';
import { canSubmitEnquiry } from '../../policies/enquiry-access.js';
import { recordEvent } from './enquiry-event.service.js';
import { freezeFirstSubmit, isBreached, minutesLate } from './enquiry-sla.service.js';
import { assertNotClosed, assertTransition } from './enquiry-status.js';
import * as repo from './product-enquiry.repository.js';
import { TX_OPTIONS, detailAfterCommit, forbidden, notFound } from './product-enquiry.service.js';

/**
 * §21 — a breached enquiry cannot be submitted until the delay is explained.
 *
 * Enforced here rather than in the UI, because a prompt that can be dismissed
 * produces empty delay analytics. Once a DelayRecord exists the gate opens.
 */
async function assertDelayExplained(
  tx: Prisma.TransactionClient,
  enquiry: repo.EnquiryForPolicy,
  now: Date,
): Promise<void> {
  if (!isBreached(now, enquiry.slaDeadlineAt, enquiry.firstSubmitAt)) return;

  const explained = await tx.delayRecord.count({ where: { enquiryId: enquiry.id } });
  if (explained === 0) {
    throw AppError.conflict(
      'DELAY_REASON_REQUIRED',
      'This response is past its deadline. Submit a reason for the delay first.',
    );
  }
}

/** §16 — the lines standing between this enquiry and a full close. */
async function unresolvedLines(
  tx: Prisma.TransactionClient,
  enquiryId: string,
): Promise<FullSubmitBlocker[]> {
  const rows = await tx.enquiryProduct.findMany({
    where: { enquiryId, status: 'PENDING' },
    orderBy: { lineNo: 'asc' },
    select: { lineNo: true, name: true, status: true },
  });
  return rows;
}

type SubmitKind = 'PARTIAL' | 'FULL';

async function submit(
  actor: AuthenticatedUser,
  id: string,
  kind: SubmitKind,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    // Serialise submits on this enquiry before reading its state, so two
    // simultaneous Full Submits cannot both see it as open.
    await repo.lockEnquiry(tx, id);

    const enquiry = await repo.findForPolicy(id, tx);
    if (!enquiry) throw notFound();
    assertNotClosed(enquiry.status);
    // §23 — Partial and Full Submit are Towards-only, plus admin.
    if (!canSubmitEnquiry({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    await assertDelayExplained(tx, enquiry, at);

    const counts = await tx.enquiryProduct.groupBy({
      by: ['status'],
      where: { enquiryId: id },
      _count: true,
    });
    const byStatus = new Map(counts.map((c) => [c.status, c._count]));
    const responded = byStatus.get('RESPONDED') ?? 0;
    const pending = byStatus.get('PENDING') ?? 0;
    const noVendor = byStatus.get('NO_VENDOR') ?? 0;

    if (kind === 'PARTIAL' && responded === 0 && noVendor === 0) {
      throw AppError.conflict(
        'NOTHING_TO_SUBMIT',
        'Record at least one vendor response before submitting.',
      );
    }

    if (kind === 'FULL' && pending > 0) {
      const blockers = await unresolvedLines(tx, id);
      throw new AppError(
        'FULL_SUBMIT_INCOMPLETE',
        409,
        'Every product needs a vendor response, or must be marked as having no vendor.',
        // Line numbers, not ids — safe to show and meaningful to the employee.
        blockers.map((b) => ({
          path: `products.${b.lineNo}`,
          message: `Line ${b.lineNo} (${b.name}) is still pending.`,
        })),
      );
    }

    const nextStatus: EnquiryStatus = kind === 'FULL' ? 'CLOSED' : 'PARTIAL_CLOSED';
    assertTransition(enquiry.status, nextStatus);

    // §19 — stops the clock only if it is still running. A retry no-ops.
    const freeze = await freezeFirstSubmit(tx, enquiry, at);

    if (kind === 'FULL') {
      await tx.productEnquiry.update({
        where: { id },
        // closedAt and closedById are written together — closed_has_closer.
        data: { status: 'CLOSED', closedAt: at, closedById: actor.id },
      });
    } else {
      await tx.productEnquiry.update({
        where: { id },
        data: { status: 'PARTIAL_CLOSED', partialSubmittedAt: at },
      });
    }

    await recordEvent(tx, {
      enquiryId: id,
      type: kind === 'FULL' ? 'FULL_SUBMITTED' : 'PARTIAL_SUBMITTED',
      actorId: actor.id,
      field: 'status',
      oldValue: enquiry.status,
      newValue: nextStatus,
      metadata: {
        responded,
        pending,
        noVendor,
        // True only on the call that actually stopped the clock.
        stoppedSla: freeze.frozenNow,
        ...(freeze.frozenNow ? { efficiency: freeze.efficiency } : {}),
      },
    });

    // §25 — a late first response is recorded as a breach on the timeline.
    // There is no FIRST_SUBMITTED event type; the submit event above carries
    // that meaning via stoppedSla.
    if (freeze.frozenNow && freeze.efficiency === 'DELAYED') {
      await recordEvent(tx, {
        enquiryId: id,
        type: 'DEADLINE_BREACHED',
        actorId: actor.id,
        field: 'efficiency',
        newValue: 'DELAYED',
        metadata: { minutesLate: minutesLate(at, enquiry.slaDeadlineAt) },
      });
    }

    if (kind === 'FULL') {
      await recordEvent(tx, {
        enquiryId: id,
        type: 'CLOSED',
        actorId: actor.id,
        field: 'status',
        oldValue: enquiry.status,
        newValue: 'CLOSED',
      });
    }

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}

export function partialSubmit(actor: AuthenticatedUser, id: string): Promise<EnquiryDetail> {
  return submit(actor, id, 'PARTIAL');
}

export function fullSubmit(actor: AuthenticatedUser, id: string): Promise<EnquiryDetail> {
  return submit(actor, id, 'FULL');
}

/**
 * §21/§43 — append-only. A previous delay record is never overwritten, because
 * management analytics depend on the full history of what went wrong and when.
 */
export async function recordDelayReason(
  actor: AuthenticatedUser,
  id: string,
  input: DelayReasonInput,
): Promise<EnquiryDetail> {
  const now = await prisma.$transaction(async (tx) => {
    const at = await databaseNow(tx);

    const enquiry = await repo.findForPolicy(id, tx);
    if (!enquiry) throw notFound();
    if (!canSubmitEnquiry({ id: actor.id, role: actor.role }, enquiry)) throw forbidden();

    if (!isBreached(at, enquiry.slaDeadlineAt, enquiry.firstSubmitAt)) {
      throw AppError.conflict(
        'NOT_DELAYED',
        'This enquiry is not past its deadline, so no delay reason is needed.',
      );
    }

    await tx.delayRecord.create({
      data: {
        enquiryId: id,
        reason: input.reason,
        deadlineAt: enquiry.slaDeadlineAt,
        detectedAt: at,
        minutesLate: minutesLate(at, enquiry.slaDeadlineAt),
        submittedById: actor.id,
      },
    });

    await recordEvent(tx, {
      enquiryId: id,
      type: 'DELAY_REASON_SUBMITTED',
      actorId: actor.id,
      newValue: input.reason,
      metadata: { minutesLate: minutesLate(at, enquiry.slaDeadlineAt) },
    });

    return at;
  }, TX_OPTIONS);

  return detailAfterCommit(id, now);
}
