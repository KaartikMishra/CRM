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
const toPaise = (amount: string): bigint => BigInt(normaliseAmount(amount).replace('.', ''));

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
