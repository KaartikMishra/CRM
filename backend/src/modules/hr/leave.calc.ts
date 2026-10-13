/**
 * Leave balance arithmetic, as pure functions.
 *
 * ### Why not the money helpers, and why not plain numbers either
 *
 * Leave is counted in days and half days, so `0.5` looks safe — and mostly is.
 * But a balance is a running total of allocations, accruals, reservations and
 * reversals, and `0.1 + 0.2 !== 0.3` in binary floating point. A balance that
 * drifts by a fraction over a year reads as 17.999999999 days and somebody is
 * told they cannot take their last day.
 *
 * The obvious move is to reuse `addAmount`/`normaliseAmount` from @rs/shared,
 * which the Sales module uses for money. **They cannot be used here**: their
 * pattern is `^\d{1,10}(\.\d{1,2})?$` — unsigned, because money in this system
 * is never negative. Leave genuinely is: an HR adjustment may remove days, a
 * reversal returns them, and the ledger's `days` is signed by design. Widening
 * the money validator to accept a minus sign would loosen every price, total and
 * payment in the CRM to solve an HR problem.
 *
 * So days get their own arithmetic, in the same spirit: convert to an integer
 * number of hundredths, do the sums in integers where no drift is possible, and
 * render back to a two-decimal string that matches `@db.Decimal(6,2)` exactly.
 */

import type { LeaveLedgerReason } from '@rs/shared';

/** The canonical form of a day count: a signed two-decimal string. */
const DAYS_PATTERN = /^-?\d{1,8}(\.\d{1,2})?$/;

/**
 * A day count as an exact integer number of hundredths.
 *
 * The whole point: every sum below happens in integers, so two half days are
 * exactly one day and twenty of them are exactly ten.
 */
function toHundredths(value: string | number): number {
  const raw = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!DAYS_PATTERN.test(raw)) {
    throw new Error(`Not a valid day count: ${raw}`);
  }
  return Math.round(Number(raw) * 100);
}

/** Back to a signed two-decimal string, matching the Decimal(6,2) column. */
function fromHundredths(hundredths: number): string {
  const sign = hundredths < 0 ? '-' : '';
  const abs = Math.abs(hundredths);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Canonicalises a day count — the signed equivalent of `normaliseAmount`. */
export function normaliseDays(value: string | number): string {
  return fromHundredths(toHundredths(value));
}

export function addDays(a: string, b: string): string {
  return fromHundredths(toHundredths(a) + toHundredths(b));
}

export function subtractDays(a: string, b: string): string {
  return fromHundredths(toHundredths(a) - toHundredths(b));
}

/** -1, 0 or 1. Exact, because it compares integers. */
export function compareDays(a: string, b: string): -1 | 0 | 1 {
  const left = toHundredths(a);
  const right = toHundredths(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** The stored components of one balance, as decimal strings. */
export type BalanceComponents = {
  allocated: string;
  accrued: string;
  carriedForward: string;
  used: string;
  reserved: string;
  /** Signed: an HR correction may add or remove. */
  adjusted: string;
};

/**
 * What is actually available to take.
 *
 * **Derived, never stored.** Its inputs are all in the same row and none of them
 * changes retroactively, so a stored copy would be a sixth number free to
 * disagree with the five it comes from — and the one somebody would then
 * "correct" by hand.
 *
 *     available = allocated + accrued + carriedForward + adjusted
 *                 − used − reserved
 *
 * `reserved` is subtracted, which is the subtle and important part: a pending
 * request holds days so two of them cannot both be approved into the same
 * remaining day. Without it, an employee with one day left could apply twice and
 * have both approved by different managers.
 */
export function availableDays(components: BalanceComponents): string {
  const credits = [
    components.allocated,
    components.accrued,
    components.carriedForward,
    components.adjusted,
  ].reduce((total, value) => addDays(total, normaliseDays(value)), '0.00');

  const debits = addDays(normaliseDays(components.used), normaliseDays(components.reserved));

  return subtractDays(credits, debits);
}

/**
 * Whether a balance covers a request.
 *
 * `compareDays` rather than `Number(a) >= Number(b)`: the comparison happens in
 * integer hundredths, so it cannot be defeated by the float drift this module
 * exists to avoid.
 */
export function hasSufficientBalance(
  components: BalanceComponents,
  requestedDays: string,
): boolean {
  return compareDays(availableDays(components), normaliseDays(requestedDays)) >= 0;
}

/**
 * Which balance column a ledger reason moves, and in which direction.
 *
 * The single mapping from "what happened" to "what changes", so the ledger and
 * the cached balance cannot disagree about the meaning of a row. Every reason
 * appears exactly once; adding a reason without a rule here is a compile error,
 * because the record is exhaustive over the enum.
 *
 * `sign` is how the ledger's signed `days` relates to the column: RESERVATION
 * writes a negative `days` (it reduces what is available) but *increases* the
 * `reserved` column, so its sign is -1. Getting this backwards is the obvious
 * way to corrupt a balance, which is why it is stated once rather than inlined
 * at each call site.
 */
export const LEDGER_EFFECTS: Record<
  LeaveLedgerReason,
  { column: keyof BalanceComponents; sign: 1 | -1 }
> = {
  ALLOCATION: { column: 'allocated', sign: 1 },
  ACCRUAL: { column: 'accrued', sign: 1 },
  CARRY_FORWARD: { column: 'carriedForward', sign: 1 },
  /** Holds days while a request waits: ledger days negative, `reserved` up. */
  RESERVATION: { column: 'reserved', sign: -1 },
  /** Releases the hold: ledger days positive, `reserved` down. */
  RESERVATION_RELEASE: { column: 'reserved', sign: -1 },
  /** Spends the days: ledger negative, `used` up. */
  CONSUMPTION: { column: 'used', sign: -1 },
  /** Returns them on cancellation: ledger positive, `used` down. */
  CONSUMPTION_REVERSAL: { column: 'used', sign: -1 },
  /** Signed either way, applied directly. */
  ADJUSTMENT: { column: 'adjusted', sign: 1 },
  /** Expired rather than carried: ledger negative, `allocated` down. */
  LAPSE: { column: 'allocated', sign: 1 },
};

/**
 * The balance components after applying one ledger entry.
 *
 * Returns a new object rather than mutating, so a caller cannot half-apply an
 * entry and leave the balance inconsistent — the service writes the whole result
 * in the same transaction as the ledger row.
 */
export function applyLedgerEntry(
  components: BalanceComponents,
  entry: { reason: LeaveLedgerReason; days: string },
): BalanceComponents {
  const effect = LEDGER_EFFECTS[entry.reason];
  const delta = toHundredths(entry.days);

  // sign -1 means the column moves opposite to the ledger's signed days: a
  // RESERVATION of -2 days raises `reserved` by 2.
  const applied = effect.sign === 1 ? delta : -delta;

  return {
    ...components,
    [effect.column]: fromHundredths(toHundredths(components[effect.column]) + applied),
  };
}

/**
 * How many days to carry into the next period.
 *
 * Carry-forward is the lesser of what is left and what the type permits — a
 * limit of null meaning unlimited, which is deliberately different from zero.
 * Never negative: a balance overdrawn by an adjustment carries nothing rather
 * than carrying a debt into next year, which nobody would expect and no policy
 * here describes.
 */
export function carryForwardDays(
  components: BalanceComponents,
  limit: string | null,
): string {
  const available = availableDays(components);
  if (compareDays(available, '0.00') <= 0) return '0.00';
  if (limit === null) return available;

  const cap = normaliseDays(limit);
  return compareDays(available, cap) <= 0 ? available : cap;
}

/**
 * Days accrued by a given point in the year.
 *
 * Monthly, which is the only frequency Phase 2 implements: `accrualPerPeriod`
 * times the number of completed months. Deliberately simple, and deliberately
 * *not* pro-rated by joining date — that interacts with payroll and with notice
 * periods, and inventing the rule here would mean guessing at a policy nobody has
 * stated. The documented behaviour is that accrual runs on whole months from the
 * start of the period, and a mid-year joiner's opening balance is set by an
 * explicit allocation rather than inferred.
 */
export function accruedByMonth(perPeriod: string, monthsElapsed: number): string {
  const months = Math.max(0, Math.min(12, Math.floor(monthsElapsed)));
  let total = '0.00';
  for (let i = 0; i < months; i += 1) total = addDays(total, normaliseDays(perPeriod));
  return total;
}
