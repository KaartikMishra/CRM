import { normalizePhone, type CustomerView } from '@rs/shared';

/**
 * The decisions the Create Lead form makes, as pure functions.
 *
 * Kept out of the component on purpose, exactly as dispatch-logic.ts is: these
 * are rules worth testing on their own, and the frontend test suite has no DOM.
 * A rule embedded in JSX can only be tested by rendering it; a rule here can be
 * asserted directly.
 *
 * Nothing here decides anything the backend decides. The API validates every
 * field again and owns whether a customer exists; these functions only answer
 * what to *show*.
 */

/**
 * How many digits a number needs before it is worth looking up.
 *
 * Seven is the shortest real phone number, and it is also what the lookup
 * schema requires — so a shorter one would be refused by the API anyway.
 * Checking here means the form does not spend a round trip discovering that.
 */
export const MIN_LOOKUP_DIGITS = 7;

/**
 * The five states the customer lookup can be in.
 *
 * MANY_MATCHES exists because the live data contains duplicate phone numbers.
 * A phone is meant to identify one customer, but dummy and historical rows
 * broke that, so the form has to be able to say "several" rather than silently
 * picking one and attaching the lead to the wrong person.
 */
export type LookupState =
  | 'IDLE'
  | 'SEARCHING'
  | 'NOT_FOUND'
  | 'ONE_MATCH'
  | 'MANY_MATCHES';

export function lookupState({
  phone,
  searching,
  searched,
  matchCount,
}: {
  phone: string;
  searching: boolean;
  searched: boolean;
  matchCount: number;
}): LookupState {
  // Too few digits to be a number: no lookup, and nothing to report.
  if (normalizePhone(phone).length < MIN_LOOKUP_DIGITS) return 'IDLE';
  if (searching) return 'SEARCHING';
  // Before the first answer comes back, the form has nothing to say either.
  if (!searched) return 'IDLE';
  if (matchCount === 0) return 'NOT_FOUND';
  if (matchCount === 1) return 'ONE_MATCH';
  return 'MANY_MATCHES';
}

/**
 * Whether a lookup should run at all for this input.
 *
 * Separate from the state above because it answers a different question: that
 * one says what to render, this says whether to spend a request.
 */
export function shouldLookup(phone: string): boolean {
  return normalizePhone(phone).length >= MIN_LOOKUP_DIGITS;
}

/**
 * Whether a match may be linked without asking.
 *
 * Exactly one, and never more. The whole point of the many-matches case is that
 * the form does not choose — so this returns an id only when there is no choice
 * to make.
 */
export function autoLinkedCustomerId(matches: CustomerView[]): string | null {
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/**
 * Enough of a customer to tell two apart.
 *
 * Deliberately not every field: this appears in a picker, and a reviewer
 * distinguishing duplicates needs the name, what kind of customer they are, and
 * where they are — not a GSTIN. Missing parts are simply left out rather than
 * rendered as "null".
 */
export function customerLabel(customer: CustomerView): string {
  const parts: string[] = [customer.name];

  if (customer.companyName) parts.push(customer.companyName);
  if (customer.email) parts.push(customer.email);

  const place = [customer.state, customer.country].filter(Boolean).join(', ');
  if (place) parts.push(place);

  return parts.join(' · ');
}
