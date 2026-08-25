/**
 * §18–20 — the SLA clock.
 *
 * Three rules hold this together, and none of them are negotiable:
 *
 *   1. Postgres is the only clock. `databaseNow()` supplies every business
 *      timestamp; Node's clock and the browser's clock are never consulted.
 *   2. The clock stops at the first submit — partial or full — recorded as
 *      `firstSubmitAt`. Not the first vendor response.
 *   3. `efficiency` is written exactly once, alongside `firstSubmitAt`, and is
 *      never recalculated. Changing ENQUIRY_SLA_MINUTES later cannot rewrite
 *      the verdict on an enquiry that has already been answered, because each
 *      enquiry snapshots the `slaMinutes` in force when it was created.
 */

import type { Prisma } from '@rs/database';
import type { EnquiryEfficiency } from '@rs/shared';

export type SlaWindow = {
  slaMinutes: number;
  createdAt: Date;
  slaDeadlineAt: Date;
};

/** Both timestamps derive from one `now`, so they cannot straddle a tick. */
export function openWindow(now: Date, slaMinutes: number): SlaWindow {
  return {
    slaMinutes,
    createdAt: now,
    slaDeadlineAt: new Date(now.getTime() + slaMinutes * 60_000),
  };
}

export function efficiencyFor(submittedAt: Date, deadlineAt: Date): EnquiryEfficiency {
  return submittedAt.getTime() <= deadlineAt.getTime() ? 'ON_TIME' : 'DELAYED';
}

export function responseSecondsBetween(createdAt: Date, submittedAt: Date): number {
  return Math.max(0, Math.round((submittedAt.getTime() - createdAt.getTime()) / 1000));
}

/** Derived, never stored: past deadline with nothing submitted yet. */
export function isBreached(
  now: Date,
  deadlineAt: Date,
  firstSubmitAt: Date | null,
): boolean {
  return firstSubmitAt === null && now.getTime() > deadlineAt.getTime();
}

export function minutesLate(now: Date, deadlineAt: Date): number {
  return Math.max(0, Math.ceil((now.getTime() - deadlineAt.getTime()) / 60_000));
}

export type FreezeResult = {
  /** True when this call is the one that stopped the clock. */
  frozenNow: boolean;
  efficiency: EnquiryEfficiency | null;
  responseSeconds: number | null;
};

/**
 * Stops the clock if it is still running, and does nothing at all if it is not.
 *
 * The `firstSubmitAt: null` guard in the WHERE clause is what makes this safe
 * under retries and concurrency (§29/§36): two simultaneous submits both attempt
 * the update, exactly one matches a row, and the loser silently no-ops rather
 * than overwriting a recorded verdict.
 */
export async function freezeFirstSubmit(
  tx: Prisma.TransactionClient,
  enquiry: { id: string; createdAt: Date; slaDeadlineAt: Date; firstSubmitAt: Date | null },
  submittedAt: Date,
): Promise<FreezeResult> {
  if (enquiry.firstSubmitAt !== null) {
    return { frozenNow: false, efficiency: null, responseSeconds: null };
  }

  const efficiency = efficiencyFor(submittedAt, enquiry.slaDeadlineAt);
  const responseSeconds = responseSecondsBetween(enquiry.createdAt, submittedAt);

  const { count } = await tx.productEnquiry.updateMany({
    where: { id: enquiry.id, firstSubmitAt: null },
    data: { firstSubmitAt: submittedAt, responseSeconds, efficiency },
  });

  // count === 0 means another transaction won the race; its verdict stands.
  return count === 1
    ? { frozenNow: true, efficiency, responseSeconds }
    : { frozenNow: false, efficiency: null, responseSeconds: null };
}
