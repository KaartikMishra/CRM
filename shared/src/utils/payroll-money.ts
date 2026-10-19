/**
 * Payroll arithmetic — exact, in integer paise, with the rounding policy named.
 *
 * ### Why this file exists alongside `money.ts`
 *
 * `money.ts` is the sanctioned money layer and this file does not replace it:
 * `addAmount`, `subtractAmount`, `sumAmounts` and `compareAmount` are reused
 * directly by the payroll services and nothing here duplicates them.
 *
 * What payroll needs and sales did not:
 *
 *   - **Fractional percentages.** `taxOnExclusive` takes a whole number of
 *     percent, correctly, because all six GST rates are integers. A payroll
 *     component is routinely 0.75% or 4.81%, so the rate has to survive two
 *     decimal places of its own.
 *   - **A named rounding mode.** GST rounds half-up by law. Payroll rounding is
 *     a business decision that moves real money in aggregate, differs between
 *     employers, and must be recorded on each period so a finalised payslip
 *     still reconciles after the policy changes.
 *   - **Division by a day count.** A monthly salary over 28, 30, 31 or a
 *     configured working-day figure, which `money.ts` has no reason to do.
 *
 * ### Everything stays in integer paise
 *
 * No function here performs floating-point arithmetic, and none accepts a
 * `number` where an amount is expected. A payroll that computes 0.1 + 0.2 in
 * binary floating point produces 0.30000000000000004, and a cent of drift
 * repeated across a thousand employees and twelve months is a reconciliation
 * failure that takes days to find.
 *
 * ### What is deliberately not here
 *
 * No PF rate, no ESI threshold, no TDS slab, no overtime multiplier, no
 * statutory anything. This file knows how to multiply an amount by a configured
 * rate and how to round the result. It does not know what any rate *should* be,
 * and that ignorance is the point — see `PAYROLL-SCOPE.md`.
 */

import type { MonetaryRoundingMode } from '../enums.js';
import { normaliseAmount } from './money.js';

/**
 * Exact paise, in and out.
 *
 * Duplicated from `money.ts` rather than exported from it because they are that
 * file's private representation, and widening its public surface to serve this
 * one would make every future change to it a cross-module concern. Both
 * implementations are three lines and agree by construction with
 * `normaliseAmount`, which *is* shared.
 */
const toPaise = (amount: string): bigint => {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith('-');
  const paise = BigInt(normaliseAmount(negative ? trimmed.slice(1) : trimmed).replace('.', ''));
  return negative ? -paise : paise;
};

const fromPaise = (paise: bigint): string => {
  const negative = paise < 0n;
  const digits = (negative ? -paise : paise).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/**
 * Integer division under a named rounding mode, sign-correct.
 *
 * All three modes operate on the magnitude and reapply the sign, so a recovery
 * of -100.005 rounds away from zero by the same rule a payment of 100.005 does.
 * Rounding magnitudes rather than signed values is what stops HALF_UP from
 * quietly becoming "round toward positive infinity", which would make a
 * deduction and an equal arrear disagree by a paisa.
 */
const divRound = (
  numerator: bigint,
  denominator: bigint,
  mode: MonetaryRoundingMode,
): bigint => {
  if (denominator === 0n) {
    throw new Error('Payroll division by zero: a day count or divisor was zero.');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;

  let rounded: bigint;
  switch (mode) {
    case 'DOWN':
      // Truncate toward zero: the remainder is simply discarded.
      rounded = quotient;
      break;
    case 'HALF_EVEN': {
      const twice = remainder * 2n;
      if (twice > d) rounded = quotient + 1n;
      else if (twice < d) rounded = quotient;
      // Exactly half: go to the even neighbour.
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
    case 'HALF_UP':
    default:
      rounded = remainder * 2n >= d ? quotient + 1n : quotient;
      break;
  }

  return negative ? -rounded : rounded;
};

/**
 * A percentage of an amount, where the rate itself may have two decimals.
 *
 * `ratePercent` arrives as a decimal string ("12", "0.75", "4.81") for the same
 * reason amounts do: a rate parsed from a float has already lost precision
 * before this function sees it. Internally the rate becomes basis points ×100 —
 * i.e. hundredths of a percent — so 0.75% is 75 and nothing is approximated.
 *
 *   percentOfAmount('50000.00', '12', 'HALF_UP')   -> '6000.00'
 *   percentOfAmount('21000.00', '0.75', 'HALF_UP') -> '157.50'
 */
export function percentOfAmount(
  amount: string,
  ratePercent: string,
  mode: MonetaryRoundingMode = 'HALF_UP',
): string {
  const rateHundredths = toPaise(ratePercent); // "0.75" -> 75n hundredths of a percent
  if (rateHundredths === 0n) return '0.00';
  // amount × rate% = amount × (rateHundredths / 10000)
  return fromPaise(divRound(toPaise(amount) * rateHundredths, 10_000n, mode));
}

/**
 * One day's worth of a monthly amount.
 *
 * `days` is the configured divisor — calendar days, working days, or a flat 30 —
 * and is never defaulted here. A caller that does not know its own basis has a
 * configuration bug, and silently picking one would produce a payslip whose
 * arithmetic nobody can reproduce.
 */
export function dailyRate(
  monthlyAmount: string,
  days: number,
  mode: MonetaryRoundingMode = 'HALF_UP',
): string {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`A daily rate needs a positive whole day count, got: ${days}`);
  }
  return fromPaise(divRound(toPaise(monthlyAmount), BigInt(days), mode));
}

/**
 * An amount prorated to a number of payable days out of a divisor.
 *
 * Computed as one division rather than `dailyRate × payableDays`, deliberately.
 * Rounding to a daily figure first and then multiplying magnifies the rounding
 * error by the day count: at 30 days a half-paisa becomes fifteen. One division
 * rounds once, at the end, on the figure that is actually paid.
 */
export function prorateAmount(
  monthlyAmount: string,
  payableDays: number,
  divisorDays: number,
  mode: MonetaryRoundingMode = 'HALF_UP',
): string {
  if (!Number.isInteger(divisorDays) || divisorDays <= 0) {
    throw new Error(`Proration needs a positive whole divisor, got: ${divisorDays}`);
  }
  if (!Number.isInteger(payableDays) || payableDays < 0) {
    throw new Error(`Proration needs a non-negative whole day count, got: ${payableDays}`);
  }
  if (payableDays === 0) return '0.00';
  // Full month short-circuits so a present-all-month employee is paid their
  // stated salary exactly, with no rounding applied to it at all.
  if (payableDays >= divisorDays) return normaliseAmount(monthlyAmount);

  return fromPaise(
    divRound(toPaise(monthlyAmount) * BigInt(payableDays), BigInt(divisorDays), mode),
  );
}

/**
 * What a number of overtime minutes is worth.
 *
 * ### One function, one rounding
 *
 * An earlier shape of this split the work into a per-minute rate and a
 * multiplication. That was a mistake twice over: it rounded an intermediate and
 * then multiplied the error by the minute count, and the scaling needed to avoid
 * that was invisible across the two function bodies — the kind of arithmetic
 * nobody can check by reading. Everything now happens in one expression with one
 * division, so the only rounding is on the figure actually paid.
 *
 * The computation is:
 *
 *   dailyAmount ÷ minutesPerDay × minutes × multiplier
 *
 * carried out as a single numerator over a single denominator in integer paise.
 *
 * ### The multiplier is never defaulted
 *
 * There is no "standard" overtime rate in this codebase. 1.0, 1.5 and 2.0 are
 * all real policies, the applicable one is frequently statutory, and none is
 * assumed here. A caller with no configured multiplier must not value overtime
 * at all — the service reports it as unvalued rather than guessing.
 */
export function overtimeValue(
  dailyAmount: string,
  minutesPerDay: number,
  minutes: number,
  multiplier: string,
  mode: MonetaryRoundingMode = 'HALF_UP',
): string {
  if (!Number.isInteger(minutesPerDay) || minutesPerDay <= 0) {
    throw new Error(`Overtime needs a positive working day in minutes, got: ${minutesPerDay}`);
  }
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`Overtime needs a non-negative whole minute count, got: ${minutes}`);
  }
  if (minutes === 0) return '0.00';

  // The multiplier is in hundredths ("1.50" -> 150n), so the denominator carries
  // a matching 100n to divide it back out.
  const multHundredths = toPaise(multiplier);
  if (multHundredths <= 0n) return '0.00';

  const numerator = toPaise(dailyAmount) * BigInt(minutes) * multHundredths;
  const denominator = BigInt(minutesPerDay) * 100n;
  return fromPaise(divRound(numerator, denominator, mode));
}

/**
 * Rounds an amount of arbitrary precision down to two decimal places.
 *
 * This is the one function here that accepts more than two decimals, because it
 * is the only one whose job is to *remove* them: a figure arriving from a
 * Prisma `Decimal` division, or a rate sheet quoted to four places, has to land
 * on a payable number under the period's policy.
 *
 * It therefore parses digits itself rather than going through `toPaise`, which
 * delegates to `normaliseAmount` and correctly rejects "2.005" — that rejection
 * is right for an *entered* amount and wrong for a value being rounded.
 *
 *   roundAmount('2.005', 'HALF_UP')   -> '2.01'
 *   roundAmount('2.005', 'HALF_EVEN') -> '2.00'
 *   roundAmount('2.005', 'DOWN')      -> '2.00'
 */
export function roundAmount(amount: string, mode: MonetaryRoundingMode = 'HALF_UP'): string {
  const trimmed = amount.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Not a roundable amount: ${amount}`);
  }
  const [, sign, whole, fraction = ''] = match;

  // Already at or below two decimals: pad and return, so no rounding mode can
  // perturb a figure that needs none.
  if (fraction.length <= MONEY_SCALE_LOCAL) {
    return `${sign}${whole}.${fraction.padEnd(MONEY_SCALE_LOCAL, '0')}`;
  }

  // Scale the whole value to the fraction's precision, then divide back down to
  // paise in one rounded step.
  const scaled = BigInt(`${whole}${fraction}`);
  const divisor = 10n ** BigInt(fraction.length - MONEY_SCALE_LOCAL);
  const paise = divRound(scaled, divisor, mode);
  return `${sign}${fromPaise(paise).replace('-', '')}`;
}

/** Local copy of the scale, so this file does not import from enums at runtime. */
const MONEY_SCALE_LOCAL = 2;

/**
 * Whether an amount is negative.
 *
 * Payroll needs this where sales did not: a net pay that comes out below zero
 * means deductions exceeded earnings, which is a real and reportable condition
 * rather than an arithmetic error, and the service must be able to detect and
 * refuse to finalise it rather than paying a negative figure.
 */
export function isNegativeAmount(amount: string): boolean {
  return toPaise(amount) < 0n;
}

/**
 * The number of days in a month, from a year and a 1-indexed month.
 *
 * Leap years included, via `Date.UTC` day-zero of the following month rather
 * than a divisibility rule — the rule is easy to write slightly wrong and this
 * cannot be.
 */
export function calendarDaysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Not a month: ${year}-${month}`);
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
