/**
 * Timeline ordering, and the financial consistency of the profile aggregate.
 *
 * Both are pure, which is deliberate: the development database holds no
 * customer history, so the rules have to be provable without one. Ordering is
 * also exactly the kind of logic that looks right and is subtly wrong — a
 * comparator that returns 0 for two entries lets them come back in whichever
 * order the queries happened to produce, and the timeline then reshuffles
 * itself between page loads.
 */

import { describe, expect, it } from 'vitest';
import {
  compareTimelineEntries,
  customerPurchaseMetrics,
  sortTimeline,
  TIMELINE_KINDS,
  type CustomerOrderFact,
  type OrderableEntry,
  type TimelineKind,
} from '@rs/shared';

const entry = (id: string, at: string, kind: TimelineKind = 'ORDER_PLACED'): OrderableEntry => ({
  id,
  at,
  kind,
});

describe('timeline ordering', () => {
  it('puts the newest entry first', () => {
    const sorted = sortTimeline([
      entry('a', '2026-01-01T00:00:00.000Z'),
      entry('b', '2026-06-01T00:00:00.000Z'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the array it was given', () => {
    const input = [entry('a', '2026-01-01T00:00:00.000Z'), entry('b', '2026-06-01T00:00:00.000Z')];
    sortTimeline(input);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('is deterministic for entries sharing a timestamp', () => {
    /*
      A bulk import can stamp several events with one instant. Without a
      tiebreaker these would come back in query order, which is not stable.
    */
    const same = '2026-03-01T10:00:00.000Z';
    const a = sortTimeline([
      entry('order:2', same, 'ORDER_PLACED'),
      entry('enquiry:1', same, 'ENQUIRY_RAISED'),
      entry('payment:3', same, 'PAYMENT_RECORDED'),
    ]);
    const b = sortTimeline([
      entry('payment:3', same, 'PAYMENT_RECORDED'),
      entry('order:2', same, 'ORDER_PLACED'),
      entry('enquiry:1', same, 'ENQUIRY_RAISED'),
    ]);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it('orders a shared timestamp by the life of the relationship', () => {
    // Enquiry, then lead, then order, then payment — not alphabetical, and not
    // whichever query returned first.
    const same = '2026-03-01T10:00:00.000Z';
    const sorted = sortTimeline([
      entry('z', same, 'PAYMENT_RECORDED'),
      entry('y', same, 'ORDER_PLACED'),
      entry('x', same, 'LEAD_CAPTURED'),
      entry('w', same, 'ENQUIRY_RAISED'),
    ]);
    expect(sorted.map((e) => e.kind)).toEqual([
      'ENQUIRY_RAISED',
      'LEAD_CAPTURED',
      'ORDER_PLACED',
      'PAYMENT_RECORDED',
    ]);
  });

  it('places a cancellation after the payment it followed, at equal timestamps', () => {
    const same = '2026-03-01T10:00:00.000Z';
    const sorted = sortTimeline([
      entry('c', same, 'ORDER_CANCELLED'),
      entry('p', same, 'PAYMENT_RECORDED'),
    ]);
    expect(sorted.map((e) => e.kind)).toEqual(['PAYMENT_RECORDED', 'ORDER_CANCELLED']);
  });

  it('falls back to the entry id when timestamp and kind both tie', () => {
    const same = '2026-03-01T10:00:00.000Z';
    const sorted = sortTimeline([
      entry('order:b', same, 'ORDER_PLACED'),
      entry('order:a', same, 'ORDER_PLACED'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['order:a', 'order:b']);
  });

  it('never reports two entries as equal', () => {
    /*
      The property that makes the order total. Any pair comparing 0 would be a
      pair whose relative order is undefined.
    */
    const same = '2026-03-01T10:00:00.000Z';
    const all = TIMELINE_KINDS.map((kind, i) => entry(`${kind}:${i}`, same, kind));
    for (const a of all) {
      for (const b of all) {
        if (a.id === b.id) continue;
        expect(compareTimelineEntries(a, b)).not.toBe(0);
      }
    }
  });

  it('handles an empty timeline', () => {
    // A customer with no recorded activity. Not an error, and not a fabricated
    // "account created" entry either.
    expect(sortTimeline([])).toEqual([]);
  });
});

describe('profile purchase value matches the Sales calculation', () => {
  /*
    The aggregate's job is to add up what `toMoney` produced, never to recompute
    it. These cases pin the aggregation rules against figures as `toMoney` would
    report them, so a change in how the profile totals orders fails here rather
    than in production beside an invoice that disagrees.
  */
  const order = (over: Partial<CustomerOrderFact> = {}): CustomerOrderFact => ({
    orderId: 'o1',
    orderDate: new Date('2026-05-01T00:00:00.000Z'),
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

  it('sums exactly the activeTotal values it was handed', () => {
    // activeTotal already includes charges and nets out cancelled quantities,
    // which is why nothing here adds shipping or subtracts a cancelled line.
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '1180.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
      order({ orderId: 'o2', money: { activeTotal: '2360.00', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
    ]);
    expect(metrics.grossPurchaseValue).toBe('3540.00');
    expect(metrics.verifiedPurchaseValue).toBe('3540.00');
  });

  it('includes an order with shipping and packing charges at its full value', () => {
    // toMoney folds charges into activeTotal; the aggregate must not strip them.
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '1250.50', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false } }),
    ]);
    expect(metrics.verifiedPurchaseValue).toBe('1250.50');
  });

  it('counts a partially cancelled order at its remaining value', () => {
    // toMoney reports activeTotal net of cancelledQty; the order still counts
    // as one valid order, at the reduced figure.
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '600.00', refunded: '0.00', refundPending: '0.00', paid: '1000.00', fullyPaid: true } }),
    ]);
    expect(metrics.validOrderCount).toBe(1);
    expect(metrics.verifiedPurchaseValue).toBe('600.00');
  });

  it('keeps a pending refund out of the total and reports it beside it', () => {
    const metrics = customerPurchaseMetrics([
      order({ money: { activeTotal: '1000.00', refunded: '0.00', refundPending: '400.00', paid: '1000.00', fullyPaid: true } }),
    ]);
    // Nothing has left the business yet, so the purchase value is unchanged.
    expect(metrics.verifiedPurchaseValue).toBe('1000.00');
    expect(metrics.pendingRefundValue).toBe('400.00');
  });

  it('handles fractional paise without drift across many orders', () => {
    /*
      Fixed-point strings throughout, never floats. 0.01 added a hundred times
      in binary floating point is famously not 1.00.
    */
    const orders = Array.from({ length: 100 }, (_, i) =>
      order({
        orderId: `o${i}`,
        money: { activeTotal: '0.01', refunded: '0.00', refundPending: '0.00', paid: '0.00', fullyPaid: false },
      }),
    );
    expect(customerPurchaseMetrics(orders).verifiedPurchaseValue).toBe('1.00');
  });

  it('reports an empty history honestly', () => {
    // Zeros for counts, but null — not '0.00' — for the average, and no dates.
    const metrics = customerPurchaseMetrics([]);
    expect(metrics.validOrderCount).toBe(0);
    expect(metrics.verifiedPurchaseValue).toBe('0.00');
    expect(metrics.averageOrderValue).toBeNull();
    expect(metrics.lastPurchaseAt).toBeNull();
    expect(metrics.isRepeatCustomer).toBe(false);
  });
});
