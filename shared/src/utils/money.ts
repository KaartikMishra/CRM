/**
 * §35 — money never travels as a float.
 *
 * Rates cross the wire as decimal strings and are stored as Postgres NUMERIC.
 * These helpers are the only sanctioned way to move between the two, so no
 * arithmetic ever happens in binary floating point.
 */

const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

export function isValidAmount(value: string): boolean {
  return AMOUNT_PATTERN.test(value);
}

/** Normalises a user-entered amount to a canonical two-decimal string. */
export function normaliseAmount(value: string | number): string {
  const raw = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!isValidAmount(raw)) {
    throw new Error(`Not a valid amount: ${raw}`);
  }
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Multiplies a decimal-string rate by an integer quantity without float drift. */
export function lineTotal(ratePerUnit: string, quantity: number): string {
  const paise = BigInt(normaliseAmount(ratePerUnit).replace('.', ''));
  const total = paise * BigInt(quantity);
  const asString = total.toString().padStart(3, '0');
  return `${asString.slice(0, -2)}.${asString.slice(-2)}`;
}

/**
 * Exact paise. Every calculation below goes through these two, so no arithmetic
 * in this file ever touches binary floating point.
 */
const toPaise = (amount: string): bigint => {
  /*
    A leading minus is handled here rather than in normaliseAmount, which must
    keep rejecting negatives: it is what isValidAmount uses to police entered
    amounts, and a negative price is never a legitimate input.

    But subtractAmount deliberately RETURNS negatives — a pending balance going
    below zero means an invariant broke upstream, and clamping it would hide
    that. So these helpers have to be able to read their own output back, or
    compareAmount(subtractAmount(a, b), '0.00') throws instead of answering.
  */
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

/** Exact addition — what accumulates a partial payment onto what is already paid. */
export function addAmount(a: string, b: string): string {
  return fromPaise(toPaise(a) + toPaise(b));
}

/**
 * Exact subtraction — what turns a total and a paid amount into a pending one.
 *
 * A negative result is returned rather than clamped: pending money going
 * negative means an invariant was violated upstream, and hiding that here would
 * turn a caught bug into a silently wrong balance.
 */
export function subtractAmount(a: string, b: string): string {
  return fromPaise(toPaise(a) - toPaise(b));
}

/** -1 when a is less than b, 0 when equal, 1 when greater. Exact, never a float. */
export function compareAmount(a: string, b: string): -1 | 0 | 1 {
  const left = toPaise(a);
  const right = toPaise(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Display formatting only — never feed the result back into a calculation. */
export function formatINR(amount: string): string {
  const [whole = '0', fraction = '00'] = normaliseAmount(amount).split('.');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`
    : lastThree;
  return `₹${grouped}.${fraction}`;
}

// ---------------------------------------------------------------------------
//  Tax arithmetic
//
//  Every function below is exact: whole paise as BigInt, one explicit rounding
//  step, and no binary floating point at any stage. The rounding rule is
//  half-up, which is what Postgres `ROUND(numeric, 2)` does for a positive
//  value — the money guard trigger recomputes these same figures in SQL, and
//  the two must agree to the paise or an order that the API says is fully paid
//  would be refused by the database.
// ---------------------------------------------------------------------------

/**
 * Integer division rounding halves away from zero, for non-negative operands.
 *
 * floor((2n + d) / 2d) is floor(n/d + 1/2) — the definition of half-up — done
 * without ever leaving integer arithmetic.
 */
const divRoundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator * 2n + denominator) / (denominator * 2n);

/**
 * The tax to ADD to a taxable value — the GST Excluded case.
 *
 * `percent` is a whole number of percent, taken from GST_RATES, and never a
 * float: the six permitted rates are all integers, so nothing here has to
 * represent 2.5% and nothing does.
 */
export function taxOnExclusive(taxableValue: string, percent: number): string {
  if (percent <= 0) return '0.00';
  return fromPaise(divRoundHalfUp(toPaise(taxableValue) * BigInt(percent), 100n));
}

/**
 * Works a gross figure back into its taxable value and tax — GST Included.
 *
 * The tax is the remainder rather than a second rounded calculation, which is
 * what guarantees `base + tax === gross` exactly. Rounding both halves
 * independently would let them miss each other by a paisa, and an invoice
 * whose parts do not add up to its total is not one to hand a customer.
 */
export function splitInclusive(gross: string, percent: number): { base: string; tax: string } {
  if (percent <= 0) return { base: normaliseAmount(gross), tax: '0.00' };
  const grossPaise = toPaise(gross);
  const basePaise = divRoundHalfUp(grossPaise * 100n, BigInt(100 + percent));
  return { base: fromPaise(basePaise), tax: fromPaise(grossPaise - basePaise) };
}

/**
 * Splits a tax figure into the CGST and SGST halves of an intra-state sale.
 *
 * An odd number of paise cannot be halved evenly, so the extra one goes to
 * CGST and SGST takes the remainder. Which head receives it is arbitrary; that
 * the two add back to the whole is not.
 */
export function halveTax(tax: string): { cgst: string; sgst: string } {
  const taxPaise = toPaise(tax);
  const cgstPaise = divRoundHalfUp(taxPaise, 2n);
  return { cgst: fromPaise(cgstPaise), sgst: fromPaise(taxPaise - cgstPaise) };
}

/** Sums a list of decimal strings exactly. Empty sums to zero, not to NaN. */
export function sumAmounts(amounts: readonly string[]): string {
  return amounts.reduce((running, amount) => addAmount(running, amount), '0.00');
}

/** True when the amount is exactly zero, whatever its written form. */
export function isZeroAmount(amount: string): boolean {
  return toPaise(amount) === 0n;
}
