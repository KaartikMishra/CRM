/**
 * §23 — human-facing enquiry numbers: ENQ-2026-000001.
 *
 * The cuid primary key is what appears in URLs; this is the number people read
 * out. Allocation takes a row lock on EnquiryCounter inside the creating
 * transaction, so two employees creating enquiries in the same instant cannot
 * be handed the same number. Volume here is a handful per hour, so serialising
 * costs nothing.
 */

import type { Prisma } from '@rs/database';
import { ENQUIRY_NUMBER_PAD, ENQUIRY_NUMBER_PREFIX } from '@rs/shared';
import { env } from '../../config/env.js';

/**
 * The period the counter resets on. Calendar year by default; Indian financial
 * years run April–March, so 2026-04-01 falls in "2026-27".
 */
export function currentPeriod(now: Date): string {
  if (env.ENQUIRY_NUMBER_PERIOD === 'CALENDAR') {
    return String(now.getUTCFullYear());
  }

  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export async function allocateEnquiryNumber(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<string> {
  const period = currentPeriod(now);

  // One statement that inserts or bumps the counter and hands back the new
  // value. The row lock is held by the UPDATE until the transaction commits,
  // which is what makes concurrent allocation safe.
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "EnquiryCounter" ("period", "lastValue")
    VALUES (${period}, 1)
    ON CONFLICT ("period")
    DO UPDATE SET "lastValue" = "EnquiryCounter"."lastValue" + 1
    RETURNING "lastValue"
  `;

  const next = rows[0]?.lastValue;
  if (next === undefined) {
    throw new Error('Enquiry counter returned no value');
  }

  return `${ENQUIRY_NUMBER_PREFIX}-${period}-${String(next).padStart(ENQUIRY_NUMBER_PAD, '0')}`;
}
