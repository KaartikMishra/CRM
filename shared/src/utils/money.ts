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
