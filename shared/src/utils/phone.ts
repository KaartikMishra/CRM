/**
 * Comparing two phone numbers that were typed by different people.
 *
 * The same number is written a dozen ways — `+91 85288 85250`,
 * `+91-85288-85250`, `(91) 85288.85250` — and a lead form that only found the
 * customer when the punctuation matched would be useless. So matching happens
 * on the digits and nothing else.
 *
 * ### What this deliberately does NOT do
 *
 * **No country-code intelligence.** `9999999999` and `+919999999999` are
 * different values here, and that is the honest answer for Phase 1: the CRM
 * holds no dialling-code data and no phone library, so inferring `+91` would be
 * this function guessing which numbers are the same number. A customer stored
 * with a country code is simply not found by a bare local number, which is
 * visible and correctable, rather than quietly matching the wrong person.
 *
 * **No fuzzy matching.** Digits are compared exactly. A near-miss is a
 * different customer, not a probable one.
 *
 * Country-aware parsing is a later enhancement; it needs a dialling-code list
 * the CRM does not yet own, and adding one is a decision about data, not a
 * detail of this feature.
 */

/**
 * The digits of a phone number, with every separator removed.
 *
 * Strips everything that is not a digit — spaces, hyphens, parentheses, dots,
 * and the leading `+` — so two spellings of one number reduce to one string.
 * Returns an empty string for input with no digits at all, which callers read
 * as "nothing to look up" rather than as a match-everything query.
 */
export function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

/** Whether two numbers are the same number, by the rule above. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePhone(a);
  if (left === '') return false;
  return left === normalizePhone(b);
}
