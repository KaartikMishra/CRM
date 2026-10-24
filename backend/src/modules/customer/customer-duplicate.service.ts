/**
 * All Customers — duplicate review.
 *
 * Suggests pairs, records decisions, and does nothing else. Specifically: it
 * never merges, never edits a customer, never deletes one. Confirming a
 * candidate records that somebody looked at the pair and agreed they are one
 * customer; it changes no customer row, enquiry, lead or order.
 *
 * That boundary is the safety property of the whole feature. A wrong automatic
 * merge would fold one customer's history into another's with no way back, and
 * no scoring rule is good enough to earn that. The two customer foreign keys on
 * the candidate table are RESTRICT for the same reason — a customer named by a
 * decision is referenced history.
 *
 * ### The phone limitation, stated where it bites
 *
 * Phone matching reads `Customer.phoneNormalized`. That column is populated on
 * write, but **existing rows predate it and have not been backfilled**, so a
 * customer whose `phone` is set and whose `phoneNormalized` is null is
 * invisible to phone matching. `scanCoverage` below reports exactly how many
 * rows are in that state, and the API returns it beside every scan, so the
 * caller is never told a scan was complete when it was not.
 */

import {
  isDuplicateCandidate,
  nextStatusAfterRescan,
  orderedPair,
  scoreDuplicatePair,
  type CustomerDuplicateCandidateView,
  type CustomerDuplicateStatusValue,
  type DuplicateCandidateInput,
  type DuplicateSideView,
} from '@rs/shared';
import { AppError } from '../../utils/AppError.js';
import * as repo from './customer.repository.js';

type SideRecord = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  gstNumber: string | null;
  state: string | null;
  createdAt: Date;
  _count: { salesOrders: number; enquiries: number; leads: number };
};

const toSide = (row: SideRecord): DuplicateSideView => ({
  id: row.id,
  name: row.name,
  companyName: row.companyName,
  phone: row.phone,
  email: row.email,
  gstNumber: row.gstNumber,
  state: row.state,
  orderCount: row._count.salesOrders,
  enquiryCount: row._count.enquiries,
  leadCount: row._count.leads,
  createdAt: row.createdAt.toISOString(),
});

type CandidateRecord = {
  id: string;
  score: number;
  matchedOn: string;
  status: CustomerDuplicateStatusValue;
  decidedAt: Date | null;
  createdAt: Date;
  decidedBy: { id: string; name: string } | null;
  customerA: SideRecord;
  customerB: SideRecord;
};

const toView = (row: CandidateRecord): CustomerDuplicateCandidateView => ({
  id: row.id,
  score: row.score,
  matchedOn: row.matchedOn,
  status: row.status,
  customerA: toSide(row.customerA),
  customerB: toSide(row.customerB),
  decidedBy: row.decidedBy ? { userId: row.decidedBy.id, name: row.decidedBy.name } : null,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** A page of candidates at one status, with the counts for every status. */
export async function listCandidates(
  status: CustomerDuplicateStatusValue,
  limit: number,
  cursor?: string,
): Promise<{
  candidates: CustomerDuplicateCandidateView[];
  nextCursor: string | null;
  counts: { SUGGESTED: number; CONFIRMED: number; DISMISSED: number };
}> {
  const [rows, counts] = await Promise.all([
    repo.listDuplicateCandidates(status, limit, cursor),
    repo.duplicateCandidateCounts(),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    candidates: page.map((row) => toView(row as CandidateRecord)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    counts,
  };
}

/** One candidate, or the standard 404. */
export async function getCandidate(id: string): Promise<CustomerDuplicateCandidateView> {
  const row = await repo.findDuplicateCandidate(id);
  if (!row) {
    throw AppError.notFound('DUPLICATE_CANDIDATE_NOT_FOUND', 'That candidate was not found.');
  }
  return toView(row as CandidateRecord);
}

/**
 * Records a confirm or dismiss decision.
 *
 * Deliberately cannot set a pair back to SUGGESTED. Reopening happens one way
 * only — a rescan finding that the matched identifiers themselves changed — so
 * a dismissal cannot be quietly undone while the facts behind it stand.
 *
 * Re-deciding an already decided pair is allowed and overwrites the reviewer
 * and timestamp: a reviewer correcting their own mistake is a legitimate act,
 * and refusing it would leave the wrong decision standing.
 */
export async function decideCandidate(
  id: string,
  status: 'CONFIRMED' | 'DISMISSED',
  decidedById: string,
): Promise<CustomerDuplicateCandidateView> {
  // 404 before writing, so an unknown id is not reported as a decision made.
  await getCandidate(id);
  await repo.decideDuplicateCandidate(id, status, decidedById);
  return getCandidate(id);
}

/** What a scan would do, and what it could not see. */
export type DuplicateScanPlan = {
  /** Pairs scoring at or above the threshold. */
  candidates: {
    customerAId: string;
    customerBId: string;
    score: number;
    matchedOn: string;
    identifierFingerprint: string;
    /** What should happen to an existing row for this pair. */
    action: 'CREATE' | 'REFRESH' | 'REOPEN' | 'KEEP_DISMISSED';
  }[];
  /** How complete the scan could be. See the phone limitation above. */
  coverage: {
    customersScanned: number;
    phoneWithValue: number;
    phoneNormalized: number;
    /** Rows with a phone the scan cannot match on, because it is not normalised. */
    phonePendingNormalization: number;
  };
};

/**
 * Works out which pairs are candidates, and what a rescan should do with each.
 *
 * Returns a plan rather than writing it. Two reasons: the plan is reviewable
 * before anything is persisted, and the write needs the migrations applied —
 * which has not been authorised — so a caller can see the result today without
 * a database change.
 *
 * O(n²) over identifier-bearing customers. Honest about that: it is a scan, not
 * a request-path query, and the comparison is cheap. If the customer count ever
 * makes it slow, the fix is to bucket by identifier first rather than to weaken
 * the comparison.
 */
export async function planDuplicateScan(): Promise<DuplicateScanPlan> {
  const [customers, existing, coverage] = await Promise.all([
    repo.customersForDuplicateScan(),
    repo.existingCandidateFingerprints(),
    repo.phoneNormalizationCoverage(),
  ]);

  /*
    Keyed by the canonical pair, so a pair is looked up the same way it is
    stored. `orderedPair` is the single definition of that ordering.
  */
  const byPair = new Map(
    existing.map((row) => [`${row.customerAId}|${row.customerBId}`, row] as const),
  );

  const candidates: DuplicateScanPlan['candidates'] = [];

  for (let i = 0; i < customers.length; i += 1) {
    for (let j = i + 1; j < customers.length; j += 1) {
      const left = customers[i]!;
      const right = customers[j]!;

      /*
        `phoneNormalized` is passed as the phone, because that is the value the
        scorer should compare — it is the stored fold of the real number. A null
        reaches `normalizePhone` as an empty string and matches nothing, which
        is the behaviour the coverage figures above explain.
      */
      const asInput = (row: typeof left): DuplicateCandidateInput => ({
        id: row.id,
        name: row.name,
        companyName: row.companyName,
        phone: row.phoneNormalized,
        email: row.email,
        gstNumber: row.gstNumber,
        state: row.state,
      });

      const score = scoreDuplicatePair(asInput(left), asInput(right));
      if (!isDuplicateCandidate(score)) continue;

      const pair = orderedPair(left.id, right.id);
      const found = byPair.get(`${pair.customerAId}|${pair.customerBId}`);

      let action: DuplicateScanPlan['candidates'][number]['action'];
      if (!found) {
        action = 'CREATE';
      } else {
        const next = nextStatusAfterRescan(
          found.status,
          found.identifierFingerprint,
          score.identifierFingerprint,
        );
        action =
          found.status === 'DISMISSED' && next === 'SUGGESTED'
            ? 'REOPEN'
            : found.status === 'DISMISSED'
              ? 'KEEP_DISMISSED'
              : 'REFRESH';
      }

      candidates.push({
        ...pair,
        score: score.score,
        matchedOn: score.matchedOn.join(','),
        identifierFingerprint: score.identifierFingerprint,
        action,
      });
    }
  }

  return {
    candidates,
    coverage: {
      customersScanned: customers.length,
      phoneWithValue: coverage.withPhone,
      phoneNormalized: coverage.normalized,
      phonePendingNormalization: coverage.pending,
    },
  };
}
