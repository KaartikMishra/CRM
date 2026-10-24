/**
 * Deciding whether two customer rows might be one customer.
 *
 * `Customer` enforces no uniqueness on phone, email or GSTIN, and that is
 * deliberate rather than an oversight: two real people share a landline, two
 * real firms share a name, and the same GSTIN legitimately appears on more than
 * one row. `createCustomer` has never deduplicated either. So duplicates exist,
 * and `lookupCustomersByPhone` already hands its caller every match rather than
 * silently picking one.
 *
 * ### This module suggests. It never merges.
 *
 * Nothing here writes, merges, rewrites or deletes a customer. It scores a pair
 * and explains the score; a person decides, and the decision is recorded. That
 * boundary is the whole safety property: a wrong automatic merge would fold one
 * customer's orders, enquiries and leads into another's with no way back, and no
 * scoring rule is good enough to earn that.
 *
 * ### Why a single weak identifier is not enough
 *
 * A shared phone number is ordinary — a family, one office line, a reseller
 * placing orders for several buyers. A shared company name is ordinary too. So
 * one weak signal alone never reaches the suggestion threshold; it needs
 * corroboration. A matching GSTIN is strong but still not conclusive on its own,
 * for the reason the schema records.
 *
 * Missing identifiers never match. Two customers who both have no email are not
 * similar on email — they are simply unknown, and treating absence as agreement
 * would pair every incomplete row with every other.
 */

import { normalizePhone } from './phone.js';

/** The fields a comparison reads. Everything else about a customer is ignored. */
export type DuplicateCandidateInput = {
  id: string;
  name: string;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  gstNumber?: string | null;
  state?: string | null;
};

/** Which identifiers agreed, in the order they are scored. */
export type DuplicateMatchKind = 'phone' | 'email' | 'gstNumber' | 'companyAndState';

export type DuplicateScore = {
  /** 0-100. The database CHECK keeps a stored score inside this range too. */
  score: number;
  matchedOn: DuplicateMatchKind[];
  /**
   * A digest of the VALUES that matched.
   *
   * This is what makes a dismissal durable but not permanent. A pair dismissed
   * as "different people" stays dismissed while it is the same pair of facts; if
   * somebody later corrects a phone number or fills in an email, the digest
   * changes and the scan reopens the pair, because the earlier decision was made
   * about data that no longer exists.
   */
  identifierFingerprint: string;
};

/**
 * Weights, and why these numbers.
 *
 * A normalized phone is the strongest single signal the CRM holds — it is how
 * the lead form already looks a customer up, and it is the one identifier the
 * rest of the CRM already treats as an identity. So phone alone may raise a
 * suggestion.
 *
 * Nothing else may, and the GSTIN weight is deliberately below the threshold
 * because of it. A GSTIN identifies a registered business and is good evidence,
 * but the schema records that the same GSTIN legitimately appears on more than
 * one row — a head office and a branch, or two buyers under one registration —
 * so on its own it would pair rows that are correctly separate. It is
 * supporting evidence: it carries real weight in combination and raises nothing
 * by itself.
 *
 * Email is shared by couples and shops often enough to be weak alone. Company
 * name plus state is the weakest of all: a guess that two similarly named firms
 * in one state are the same firm.
 *
 * So, against SUGGESTION_THRESHOLD of 50: phone (60) suggests alone; GSTIN
 * (40), email (45) and company+state (20) do not; and any two of them together
 * do. Every one of those boundaries is asserted in the tests, because a weight
 * nudged without re-reading this comment is how GSTIN-alone would quietly start
 * suggesting again.
 */
const WEIGHTS: Record<DuplicateMatchKind, number> = {
  phone: 60,
  email: 45,
  /*
    Below the threshold on purpose — see above. This is the one weight whose
    exact value carries a rule rather than a judgement: raising it to 50 would
    make a shared registration enough to suggest a duplicate, which the business
    has explicitly ruled out.
  */
  gstNumber: 40,
  companyAndState: 20,
};

/**
 * The score at or above which a pair is worth a human's attention.
 *
 * Set so that phone alone (60) qualifies, GSTIN alone (50) qualifies, email
 * alone (45) does not, and company+state alone (20) does not — but email plus
 * company+state (65) does. A threshold any lower would fill the queue with
 * coincidences; any higher and a shared mobile number would go unreviewed.
 */
export const SUGGESTION_THRESHOLD = 50;

const clean = (value: string | null | undefined): string =>
  (value ?? '').trim().toLowerCase();

/**
 * Compares two customers.
 *
 * Returns a score of 0 with no matches when nothing agrees, which the caller
 * reads as "not a candidate" rather than as a weak one.
 */
export function scoreDuplicatePair(
  a: DuplicateCandidateInput,
  b: DuplicateCandidateInput,
): DuplicateScore {
  const matchedOn: DuplicateMatchKind[] = [];
  const parts: string[] = [];

  // Digits only, via the same fold the lead lookup uses, so the two cannot
  // disagree about what "the same number" means. Empty never matches.
  const phoneA = normalizePhone(a.phone);
  const phoneB = normalizePhone(b.phone);
  if (phoneA !== '' && phoneA === phoneB) {
    matchedOn.push('phone');
    parts.push(`phone:${phoneA}`);
  }

  const emailA = clean(a.email);
  const emailB = clean(b.email);
  if (emailA !== '' && emailA === emailB) {
    matchedOn.push('email');
    parts.push(`email:${emailA}`);
  }

  // GSTINs are stored uppercase; compared case-insensitively anyway so a
  // hand-typed lowercase value is not treated as a different registration.
  const gstA = clean(a.gstNumber);
  const gstB = clean(b.gstNumber);
  if (gstA !== '' && gstA === gstB) {
    matchedOn.push('gstNumber');
    parts.push(`gst:${gstA}`);
  }

  /*
    Company AND state together, never company alone. "Sharma Traders" occurs all
    over India; "Sharma Traders" in one state is a narrower claim. Both values
    must be present — a company with no state recorded is not a match.
  */
  const companyA = clean(a.companyName);
  const companyB = clean(b.companyName);
  const stateA = clean(a.state);
  const stateB = clean(b.state);
  if (companyA !== '' && companyA === companyB && stateA !== '' && stateA === stateB) {
    matchedOn.push('companyAndState');
    parts.push(`company:${companyA}|state:${stateA}`);
  }

  const score = Math.min(
    100,
    matchedOn.reduce((total, kind) => total + WEIGHTS[kind], 0),
  );

  return {
    score,
    matchedOn,
    // Sorted so the digest describes the facts, not the order they were found.
    identifierFingerprint: parts.length > 0 ? [...parts].sort().join(';') : '',
  };
}

/** Whether a scored pair belongs in the review queue. */
export function isDuplicateCandidate(score: DuplicateScore): boolean {
  return score.matchedOn.length > 0 && score.score >= SUGGESTION_THRESHOLD;
}

/**
 * The pair in its stored order: lower id first.
 *
 * (A, B) and (B, A) are the same pair, and storing both would let one be
 * dismissed while the other stayed suggested. A fixed order plus the unique
 * index on the two columns makes a second spelling impossible, and makes a
 * rescan an upsert of the row already written rather than a twin of it.
 */
export function orderedPair(
  aId: string,
  bId: string,
): { customerAId: string; customerBId: string } {
  return aId < bId
    ? { customerAId: aId, customerBId: bId }
    : { customerAId: bId, customerBId: aId };
}

/**
 * What a rescan should do with a pair it has already seen.
 *
 * SUGGESTED and CONFIRMED are refreshed in place: a new score or a new list of
 * matching identifiers is better information about the same open question.
 *
 * DISMISSED is the interesting one. It is honoured — the reviewer said these are
 * different people — unless the identifiers that produced the suggestion have
 * themselves changed, in which case the dismissal was about data that no longer
 * exists and the pair reopens as SUGGESTED.
 */
export function nextStatusAfterRescan(
  current: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED',
  storedFingerprint: string,
  freshFingerprint: string,
): 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED' {
  if (current !== 'DISMISSED') return current;
  return storedFingerprint === freshFingerprint ? 'DISMISSED' : 'SUGGESTED';
}
