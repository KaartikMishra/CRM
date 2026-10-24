/**
 * All Customers — attribution, metrics and duplicate scoring.
 *
 * Pure: no database, no HTTP. These run on an empty database, which matters
 * right now — the development branch holds no customers, so this is the suite
 * that can prove the rules are right before any data exists.
 *
 * Every case below exists because getting it wrong would misreport a customer:
 * counting a cancelled order inflates purchase value, returning '0.00' for an
 * average order value invents a measurement, a non-deterministic tie-break
 * makes a first-touch source flip between page loads, and an automatic merge on
 * a shared phone number would fold two real customers into one.
 */

import { describe, expect, it } from 'vitest';
import {
  attributionFor,
  customerConversionMetrics,
  customerPurchaseMetrics,
  isDuplicateCandidate,
  nextStatusAfterRescan,
  orderedPair,
  scoreDuplicatePair,
  sourceLabel,
  SUGGESTION_THRESHOLD,
  UNKNOWN_SOURCE,
  type CustomerLeadFact,
  type CustomerOrderFact,
  type SourceEvent,
} from '@rs/shared';

const at = (iso: string): Date => new Date(iso);

const leadEvent = (over: Partial<SourceEvent> = {}): SourceEvent => ({
  origin: 'LEAD',
  recordId: 'lead-1',
  source: 'CALL',
  channel: 'INDIAMART',
  at: at('2026-03-01T10:00:00.000Z'),
  ...over,
});

const enquiryEvent = (over: Partial<SourceEvent> = {}): SourceEvent => ({
  origin: 'ENQUIRY',
  recordId: 'enq-1',
  source: 'WEBSITE',
  at: at('2026-04-01T10:00:00.000Z'),
  ...over,
});

const order = (over: Partial<CustomerOrderFact> = {}): CustomerOrderFact => ({
  orderId: 'o1',
  orderDate: at('2026-05-01T00:00:00.000Z'),
  status: 'CLOSED',
  money: {
    activeTotal: '1000.00',
    refunded: '0.00',
    refundPending: '0.00',
    paid: '1000.00',
    fullyPaid: true,
  },
  ...over,
});

describe('attribution', () => {
  it('reports UNKNOWN when the customer has no source event at all', () => {
    // Not null and not OTHER. Null renders as a blank that reads like missing
    // data; OTHER would claim somebody chose "other" when nobody chose anything.
    const { firstTouch, lastTouch } = attributionFor([]);
    expect(firstTouch.source).toBe(UNKNOWN_SOURCE);
    expect(lastTouch.source).toBe(UNKNOWN_SOURCE);
    expect(firstTouch.origin).toBeNull();
    expect(firstTouch.at).toBeNull();
  });

  it('treats a single event as both first and last touch', () => {
    const { firstTouch, lastTouch } = attributionFor([leadEvent()]);
    expect(firstTouch.source).toBe('CALL');
    expect(lastTouch.source).toBe('CALL');
  });

  it('orders by timestamp, oldest first', () => {
    const { firstTouch, lastTouch } = attributionFor([enquiryEvent(), leadEvent()]);
    expect(firstTouch.source).toBe('CALL');
    expect(lastTouch.source).toBe('WEBSITE');
  });

  it('is independent of input order', () => {
    // The same set shuffled must give the same answer, or a customer's source
    // would depend on how the database happened to return the rows.
    const a = attributionFor([leadEvent(), enquiryEvent()]);
    const b = attributionFor([enquiryEvent(), leadEvent()]);
    expect(a).toEqual(b);
  });

  it('breaks a timestamp tie in favour of the LEAD', () => {
    /*
      Lead.sourceAt is a business instant somebody recorded; ProductEnquiry
      .createdAt is when the row was written. When both claim the same moment,
      the deliberately recorded one is the better evidence of what happened.
    */
    const same = '2026-03-01T10:00:00.000Z';
    const { firstTouch } = attributionFor([
      enquiryEvent({ at: at(same) }),
      leadEvent({ at: at(same) }),
    ]);
    expect(firstTouch.origin).toBe('LEAD');
  });

  it('breaks a same-origin, same-timestamp tie on record id', () => {
    const same = '2026-03-01T10:00:00.000Z';
    const { firstTouch } = attributionFor([
      leadEvent({ recordId: 'lead-b', at: at(same), source: 'EMAIL' }),
      leadEvent({ recordId: 'lead-a', at: at(same), source: 'CALL' }),
    ]);
    expect(firstTouch.source).toBe('CALL');
  });

  it('preserves the original source value rather than remapping it', () => {
    // INDIAMART is a channel on a lead and a source on an enquiry. Neither is
    // rewritten here; reconciling the vocabularies is a business decision.
    const { firstTouch } = attributionFor([leadEvent({ source: 'WHATSAPP' })]);
    expect(firstTouch.source).toBe('WHATSAPP');
    expect(firstTouch.channel).toBe('INDIAMART');
  });

  it('carries the free text for OTHER and OTHERS alike', () => {
    // LeadSource spells it OTHER, EnquirySource spells it OTHERS. Both are real.
    expect(sourceLabel('OTHER', 'Trade fair')).toBe('Trade fair');
    expect(sourceLabel('OTHERS', 'Walk-in')).toBe('Walk-in');
    expect(sourceLabel('CALL', null)).toBe('CALL');
    expect(sourceLabel(UNKNOWN_SOURCE, null)).toBe('Unknown');
  });
});

describe('purchase metrics', () => {
  it('counts a placed but unpaid order as a purchase', () => {
    // The goods were agreed. Payment is tracked separately.
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '500.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
    ]);
    expect(metrics.validOrderCount).toBe(1);
    expect(metrics.verifiedPurchaseValue).toBe('500.00');
    expect(metrics.paidOrderCount).toBe(0);
  });

  it('excludes a cancelled order from both the count and the value', () => {
    const metrics = customerPurchaseMetrics([
      order(),
      order({
        orderId: 'o2',
        status: 'CANCELLED',
        // toMoney already reports 0.00 for a cancelled order; asserted here so
        // a change in that contract fails loudly rather than silently.
        money: { activeTotal: '0.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false },
      }),
    ]);
    expect(metrics.validOrderCount).toBe(1);
    expect(metrics.cancelledOrderCount).toBe(1);
    expect(metrics.verifiedPurchaseValue).toBe('1000.00');
  });

  it('subtracts completed refunds and reports pending ones separately', () => {
    const metrics = customerPurchaseMetrics([
      order({
        money: { activeTotal: '1000.00', refunded: '250.00', refundPending: '100.00', paid: '1000.00', fullyPaid: true },
      }),
    ]);
    expect(metrics.grossPurchaseValue).toBe('1000.00');
    expect(metrics.verifiedPurchaseValue).toBe('750.00');
    expect(metrics.pendingRefundValue).toBe('100.00');
  });

  it('never reports a negative purchase value', () => {
    // Refunds can exceed the remaining value once units are cancelled. A
    // negative here would read as a debt the customer owes.
    const metrics = customerPurchaseMetrics([
      order({
        money: { activeTotal: '100.00', refunded: '400.00', refundPending: '0.00', paid: '400.00', fullyPaid: true },
      }),
    ]);
    expect(metrics.verifiedPurchaseValue).toBe('0.00');
  });

  it('returns null, not zero, for the average with no valid orders', () => {
    // Zero would be a measurement nobody took, and would drag a cohort average
    // down with a figure that is not a figure.
    expect(customerPurchaseMetrics([]).averageOrderValue).toBeNull();
    expect(
      customerPurchaseMetrics([order({ status: 'CANCELLED' })]).averageOrderValue,
    ).toBeNull();
  });

  it('averages over valid orders only', () => {
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '1000.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
      order({ orderId: 'o2', money: { activeTotal: '500.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
      order({ orderId: 'o3', status: 'CANCELLED', money: { activeTotal: '0.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
    ]);
    // 1500.00 over two valid orders, not three.
    expect(metrics.averageOrderValue).toBe('750.00');
  });

  it('rounds the average half-up at two decimal places', () => {
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '10.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
      order({ orderId: 'o2', money: { activeTotal: '10.01', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
      order({ orderId: 'o3', money: { activeTotal: '10.01', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
    ]);
    // 30.02 / 3 = 10.006666… -> 10.01
    expect(metrics.averageOrderValue).toBe('10.01');
  });

  it('calls two valid orders a repeat customer, and one not', () => {
    expect(customerPurchaseMetrics([order()]).isRepeatCustomer).toBe(false);
    expect(
      customerPurchaseMetrics([order(), order({ orderId: 'o2' })]).isRepeatCustomer,
    ).toBe(true);
  });

  it('does not let a cancelled order make somebody a repeat customer', () => {
    const metrics = customerPurchaseMetrics([
      order(),
      order({ orderId: 'o2', status: 'CANCELLED' }),
    ]);
    expect(metrics.isRepeatCustomer).toBe(false);
  });

  it('takes the last purchase date from valid orders only', () => {
    const metrics = customerPurchaseMetrics([
      order({ orderDate: at('2026-01-01T00:00:00.000Z') }),
      order({ orderId: 'o2', orderDate: at('2026-09-01T00:00:00.000Z'), status: 'CANCELLED' }),
    ]);
    expect(metrics.lastPurchaseAt).toBe('2026-01-01T00:00:00.000Z');
    expect(metrics.firstPurchaseAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('has no purchase dates at all when nothing is valid', () => {
    const metrics = customerPurchaseMetrics([order({ status: 'CANCELLED' })]);
    expect(metrics.lastPurchaseAt).toBeNull();
    expect(metrics.firstPurchaseAt).toBeNull();
  });
});

describe('conversion metrics', () => {
  const lead = (over: Partial<CustomerLeadFact> = {}): CustomerLeadFact => ({
    leadId: 'l1',
    dealStatus: 'INPROCESS',
    salesOrderId: null,
    linkedOrderCancelled: null,
    ...over,
  });

  it('counts a lead linked to a surviving order as converted', () => {
    const m = customerConversionMetrics([
      lead({ salesOrderId: 'o1', linkedOrderCancelled: false }),
    ]);
    expect(m.convertedLeadCount).toBe(1);
    expect(m.conversionRate).toBe(100);
  });

  it('does NOT count a lead whose linked order was cancelled', () => {
    // A cancelled order is not a sale, so the lead did not convert.
    const m = customerConversionMetrics([
      lead({ salesOrderId: 'o1', linkedOrderCancelled: true }),
    ]);
    expect(m.convertedLeadCount).toBe(0);
    expect(m.conversionRate).toBe(0);
  });

  it('does not count an unlinked lead, whatever its deal status', () => {
    const m = customerConversionMetrics([lead({ dealStatus: 'WON' })]);
    expect(m.convertedLeadCount).toBe(0);
    // WON is still reported — the discrepancy is the useful part.
    expect(m.wonLeadCount).toBe(1);
  });

  it('keeps WON and converted apart when they disagree', () => {
    /*
      Both directions are real: a lead can be marked WON before its order
      exists, and an order can be cancelled after its lead was marked WON.
      Collapsing the two would hide exactly that.
    */
    const m = customerConversionMetrics([
      lead({ leadId: 'a', dealStatus: 'WON', salesOrderId: 'o1', linkedOrderCancelled: true }),
      lead({ leadId: 'b', dealStatus: 'INPROCESS', salesOrderId: 'o2', linkedOrderCancelled: false }),
    ]);
    expect(m.wonLeadCount).toBe(1);
    expect(m.convertedLeadCount).toBe(1);
  });

  it('returns a null conversion rate with no leads', () => {
    expect(customerConversionMetrics([]).conversionRate).toBeNull();
  });
});

describe('duplicate scoring', () => {
  const base = { id: 'c1', name: 'Ravi Kumar' };

  it('matches a phone across different spellings', () => {
    const score = scoreDuplicatePair(
      { ...base, phone: '+91 85288 85250' },
      { id: 'c2', name: 'R Kumar', phone: '8528885250' },
    );
    // normalizePhone strips the separators AND the country code digits are kept,
    // so these differ — the documented limitation. Same spelling, same digits:
    expect(score.matchedOn).not.toContain('phone');

    const same = scoreDuplicatePair(
      { ...base, phone: '+91 85288 85250' },
      { id: 'c2', name: 'R Kumar', phone: '+91-85288-85250' },
    );
    expect(same.matchedOn).toContain('phone');
    expect(same.score).toBe(60);
  });

  it('never matches on a missing identifier', () => {
    // Two customers who both have no email are unknown, not similar.
    const score = scoreDuplicatePair(
      { ...base, email: null, phone: null },
      { id: 'c2', name: 'Ravi Kumar', email: null, phone: null },
    );
    expect(score.matchedOn).toEqual([]);
    expect(score.score).toBe(0);
    expect(isDuplicateCandidate(score)).toBe(false);
  });

  it('does not suggest a pair on a shared company name alone', () => {
    // "Sharma Traders" occurs all over India.
    const score = scoreDuplicatePair(
      { ...base, companyName: 'Sharma Traders', state: 'Delhi' },
      { id: 'c2', name: 'Other', companyName: 'Sharma Traders', state: 'Delhi' },
    );
    expect(score.matchedOn).toEqual(['companyAndState']);
    expect(score.score).toBeLessThan(SUGGESTION_THRESHOLD);
    expect(isDuplicateCandidate(score)).toBe(false);
  });

  it('does not match company without a state on both sides', () => {
    const score = scoreDuplicatePair(
      { ...base, companyName: 'Sharma Traders', state: null },
      { id: 'c2', name: 'Other', companyName: 'Sharma Traders', state: 'Delhi' },
    );
    expect(score.matchedOn).toEqual([]);
  });

  it('suggests on a shared phone, which the CRM already treats as identity', () => {
    const score = scoreDuplicatePair(
      { ...base, phone: '9999999999' },
      { id: 'c2', name: 'Someone', phone: '9999999999' },
    );
    expect(isDuplicateCandidate(score)).toBe(true);
  });

  it('does not suggest on email alone, but does with corroboration', () => {
    const emailOnly = scoreDuplicatePair(
      { ...base, email: 'a@b.com' },
      { id: 'c2', name: 'X', email: 'A@B.COM' },
    );
    expect(emailOnly.score).toBe(45);
    expect(isDuplicateCandidate(emailOnly)).toBe(false);

    const corroborated = scoreDuplicatePair(
      { ...base, email: 'a@b.com', companyName: 'Acme', state: 'Delhi' },
      { id: 'c2', name: 'X', email: 'a@b.com', companyName: 'Acme', state: 'Delhi' },
    );
    expect(corroborated.score).toBe(65);
    expect(isDuplicateCandidate(corroborated)).toBe(true);
  });

  /*
    The four rules, each asserted at its boundary.

    These are the cases a tuned weight would break silently. A GSTIN is shared
    legitimately — a head office and a branch, two buyers under one
    registration — so it must never raise a suggestion by itself however strong
    it looks as evidence.
  */
  it('does NOT suggest on a shared GSTIN alone', () => {
    const score = scoreDuplicatePair(
      { ...base, gstNumber: '07AABCU9603R1ZM' },
      { id: 'c2', name: 'Branch Office', gstNumber: '07AABCU9603R1ZM' },
    );
    expect(score.matchedOn).toEqual(['gstNumber']);
    expect(score.score).toBeLessThan(SUGGESTION_THRESHOLD);
    expect(isDuplicateCandidate(score)).toBe(false);
  });

  it('still lets a GSTIN carry real weight in combination', () => {
    // Supporting evidence, not ignored evidence: with any second signal it
    // crosses the threshold.
    const withCompany = scoreDuplicatePair(
      { ...base, gstNumber: '07AABCU9603R1ZM', companyName: 'Acme', state: 'Delhi' },
      { id: 'c2', name: 'X', gstNumber: '07AABCU9603R1ZM', companyName: 'Acme', state: 'Delhi' },
    );
    expect(withCompany.score).toBe(60);
    expect(isDuplicateCandidate(withCompany)).toBe(true);
  });

  it('suggests on phone alone and on nothing else alone', () => {
    // The whole of Clarification 1's single-identifier rule, in one assertion.
    const single = (over: Record<string, string>) =>
      isDuplicateCandidate(
        scoreDuplicatePair({ ...base, ...over }, { id: 'c2', name: 'X', ...over }),
      );
    expect(single({ phone: '9999999999' })).toBe(true);
    expect(single({ email: 'a@b.com' })).toBe(false);
    expect(single({ gstNumber: '07AABCU9603R1ZM' })).toBe(false);
    expect(single({ companyName: 'Acme', state: 'Delhi' })).toBe(false);
  });

  it('caps the score at 100 when everything matches', () => {
    const score = scoreDuplicatePair(
      { ...base, phone: '9999999999', email: 'a@b.com', gstNumber: '07AABCU9603R1ZM', companyName: 'Acme', state: 'Delhi' },
      { id: 'c2', name: 'X', phone: '9999999999', email: 'a@b.com', gstNumber: '07AABCU9603R1ZM', companyName: 'Acme', state: 'Delhi' },
    );
    expect(score.score).toBe(100);
  });

  it('builds a fingerprint from the matched values, order-independently', () => {
    const a = scoreDuplicatePair(
      { ...base, phone: '9999999999', email: 'a@b.com' },
      { id: 'c2', name: 'X', phone: '9999999999', email: 'a@b.com' },
    );
    const b = scoreDuplicatePair(
      { id: 'c2', name: 'X', email: 'a@b.com', phone: '9999999999' },
      { ...base, email: 'a@b.com', phone: '9999999999' },
    );
    expect(a.identifierFingerprint).toBe(b.identifierFingerprint);
    expect(a.identifierFingerprint).not.toBe('');
  });
});

describe('the stored pair order', () => {
  it('puts the lower id first, whichever way round it is asked', () => {
    // (A,B) and (B,A) are the same pair. One spelling could otherwise be
    // dismissed while the other stayed suggested.
    expect(orderedPair('b', 'a')).toEqual({ customerAId: 'a', customerBId: 'b' });
    expect(orderedPair('a', 'b')).toEqual({ customerAId: 'a', customerBId: 'b' });
  });
});

describe('what a rescan does with a decided pair', () => {
  it('leaves a dismissal alone while the identifiers are unchanged', () => {
    expect(nextStatusAfterRescan('DISMISSED', 'phone:999', 'phone:999')).toBe('DISMISSED');
  });

  it('reopens a dismissal once the matched identifiers change', () => {
    // The decision was about data that no longer exists.
    expect(nextStatusAfterRescan('DISMISSED', 'phone:999', 'phone:999;email:a@b.com')).toBe(
      'SUGGESTED',
    );
  });

  it('refreshes suggested and confirmed pairs in place', () => {
    expect(nextStatusAfterRescan('SUGGESTED', 'x', 'y')).toBe('SUGGESTED');
    expect(nextStatusAfterRescan('CONFIRMED', 'x', 'y')).toBe('CONFIRMED');
  });
});
