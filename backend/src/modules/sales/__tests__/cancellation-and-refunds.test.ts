/**
 * Cancelling an order, cancelling part of one, and the money that follows.
 *
 * Three things this suite exists to hold down, in order of how badly each would
 * hurt if it broke:
 *
 *   1. CANCELLING REFUNDS NOTHING. An order called off leaves money the customer
 *      has paid sitting as *refundable*, and only a SalesRefund that somebody
 *      recorded — and then settled, with the reference it went out with — turns
 *      that into refunded. Pretending otherwise would tell a business it had
 *      paid people back when it had not.
 *
 *   2. HISTORY SURVIVES. `quantity` keeps meaning what was ORDERED, for ever.
 *      Cancelling accumulates into `cancelledQty` beside it, so the line still
 *      says what was agreed. Nothing is deleted: not the order, not a line, not
 *      a payment.
 *
 *   3. THE PAYABLE DOES NOT MOVE. sales_order_money_guard prices the ordered
 *      quantities, and cancelling deliberately leaves them alone — so a
 *      part-paid order can always be cancelled, where reducing the quantity
 *      would have been refused at COMMIT for leaving paid > payable. The last
 *      block pays an order in full, cancels half of it, and proves the trigger
 *      never objects.
 *
 * Amounts are kept boring — 100.00 a unit, no GST unless a case is about GST —
 * so an assertion failing means the rule broke rather than the arithmetic being
 * hard to follow.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SalesOrderDetail } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  approvePurchaseBill,
  cleanup,
  makeCustomer,
  makeRsProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { order: SalesOrderDetail };

let admin: TestUser;
let token: string;
let customer: { id: string; name: string };
let vendor: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  token = await mintToken(admin.id, { role: 'ADMIN' });
  customer = await makeCustomer('BULK');
  vendor = await makeVendor();
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type Line = { quantity: number; price?: string; rsProductId?: string; gstRate?: string };

async function makeOrder(lines: Line[], paidAmount = '0'): Promise<SalesOrderDetail> {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customer.id, {
      items: lines.map((line, i) => ({
        productName: `zz-test line ${i + 1}`,
        ...(line.rsProductId ? { rsProductId: line.rsProductId } : {}),
        quantity: line.quantity,
        price: line.price ?? '100.00',
        ...(line.gstRate ? { gstRate: line.gstRate } : {}),
        gstMode: 'EXCLUSIVE',
      })),
      paidAmount,
      ...(paidAmount === '0' ? {} : { paymentMethod: 'PREPAID' }),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
}

const pay = (id: string, body: Record<string, unknown>) =>
  api<Wrapped>('POST', `/api/sales/${id}/payments`, { token, body });

const cancelOrder = (id: string, reason = 'zz-test customer called it off') =>
  api<Wrapped>('POST', `/api/sales/${id}/cancel`, { token, body: { reason } });

const cancelItems = (id: string, lines: { itemId: string; quantity: number }[], reason = 'zz-test partial') =>
  api<Wrapped>('POST', `/api/sales/${id}/cancel-items`, { token, body: { reason, lines } });

const refund = (id: string, body: Record<string, unknown>) =>
  api<Wrapped>('POST', `/api/sales/${id}/refunds`, { token, body });

const settle = (id: string, refundId: string, body: Record<string, unknown>) =>
  api<Wrapped>('POST', `/api/sales/${id}/refunds/${refundId}/settle`, { token, body });

const reject = (id: string, refundId: string, body: Record<string, unknown> = {}) =>
  api<Wrapped>('POST', `/api/sales/${id}/refunds/${refundId}/reject`, { token, body });

const detail = async (id: string): Promise<SalesOrderDetail> => {
  const res = await api<Wrapped>('GET', `/api/sales/${id}`, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data!.order;
};

/** An approved bill for `product`, fully received, ready to allocate from. */
async function allocateTo(rsProductId: string, lineId: string, quantity: number): Promise<void> {
  const billed = await api('POST', '/api/procurement/bills', {
    token,
    body: purchaseBillPayload(vendor.id, rsProductId, {
      items: [
        {
          productName: 'zz-test purchase',
          rsProductId,
          orderedQty: quantity,
          receivedQty: quantity,
          rate: '10.00',
        },
      ],
    }),
  });
  expect(billed.status, JSON.stringify(billed.body)).toBe(201);

  const bill = (billed.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  await approvePurchaseBill(bill.id);

  const res = await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`, {
    token,
    body: { salesOrderItemId: lineId, quantity },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// ===========================================================================
//  B — payment details
// ===========================================================================

describe('a payment carries the reference it arrived with', () => {
  it('records the reference, the method and who took it', async () => {
    const order = await makeOrder([{ quantity: 2 }]);

    const res = await pay(order.id, {
      amount: '50.00',
      method: 'PREPAID',
      reference: 'UTR-zz-test-4417829301',
      note: 'zz-test UPI from the customer',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const payments = res.body.data!.order.payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]!.amount).toBe('50.00');
    expect(payments[0]!.reference).toBe('UTR-zz-test-4417829301');
    expect(payments[0]!.method).toBe('PREPAID');
    expect(payments[0]!.note).toBe('zz-test UPI from the customer');
    expect(payments[0]!.recordedBy.id).toBe(admin.id);
  });

  it('keeps each reference with its own instalment', async () => {
    // The whole reason this is a table: an order paid twice has two references,
    // and a column on the order could hold one of them at most.
    const order = await makeOrder([{ quantity: 3 }]);

    await pay(order.id, { amount: '100.00', method: 'PARTIAL_COD', reference: 'zz-test-FIRST' });
    await pay(order.id, { amount: '60.00', method: 'COD', reference: 'zz-test-SECOND' });

    const after = await detail(order.id);
    expect(after.payments.map((p) => p.reference)).toEqual(['zz-test-FIRST', 'zz-test-SECOND']);
    expect(after.payments.map((p) => p.amount)).toEqual(['100.00', '60.00']);
  });

  it('leaves partial payments and the pending amount exactly as they were', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    expect(order.money.total).toBe('300.00');

    await pay(order.id, { amount: '100.00' });
    const half = await detail(order.id);
    expect(half.money.paid).toBe('100.00');
    expect(half.money.pending).toBe('200.00');
    expect(half.money.fullyPaid).toBe(false);

    await pay(order.id, { amount: '200.00' });
    const full = await detail(order.id);
    expect(full.money.paid).toBe('300.00');
    expect(full.money.pending).toBe('0.00');
    expect(full.money.fullyPaid).toBe(true);
  });

  it('keeps the ledger equal to the figure the database enforces', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    await pay(order.id, { amount: '30.00', reference: 'zz-test-a' });
    await pay(order.id, { amount: '70.00', reference: 'zz-test-b' });

    const row = await prisma.salesOrder.findUnique({
      where: { id: order.id },
      select: { paidAmount: true, payments: { select: { amount: true } } },
    });
    const ledger = row!.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    expect(ledger).toBe(Number(row!.paidAmount));
    expect(ledger).toBe(100);
  });

  it('still refuses a payment past the total, reference or not', async () => {
    const order = await makeOrder([{ quantity: 1 }]);

    const res = await pay(order.id, { amount: '500.00', reference: 'zz-test-too-much' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');

    // And nothing was written on the way to being refused.
    expect((await detail(order.id)).payments).toHaveLength(0);
  });
});

// ===========================================================================
//  C — full cancellation
// ===========================================================================

describe('cancelling a whole order', () => {
  it('records who, when and why, and keeps every line', async () => {
    const order = await makeOrder([{ quantity: 3 }, { quantity: 2 }]);

    const res = await cancelOrder(order.id, 'zz-test customer changed their mind');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = res.body.data!.order;
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledBy!.id).toBe(admin.id);
    expect(after.cancelledAt).not.toBeNull();
    expect(after.cancellationReason).toBe('zz-test customer changed their mind');

    // Nothing deleted. Both lines still there, still saying what was ordered.
    expect(after.items).toHaveLength(2);
    expect(after.items.map((i) => i.quantity)).toEqual([3, 2]);
    // And every unit is accounted for as cancelled.
    expect(after.items.map((i) => i.cancelledQty)).toEqual([3, 2]);
    expect(after.items.map((i) => i.remainingQty)).toEqual([0, 0]);
  });

  it('is not treated as a live order afterwards', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    await cancelOrder(order.id);

    // No edit, no dispatch, no second cancellation.
    const edited = await api('PATCH', `/api/sales/${order.id}`, {
      token,
      body: { toBeDispatchedBy: new Date(Date.now() + 864e5).toISOString() },
    });
    expect(edited.status).toBe(409);
    expect(edited.body.code).toBe('ORDER_CANCELLED');

    expect((await api('POST', `/api/sales/${order.id}/dispatch`, { token })).status).toBe(409);
    expect((await cancelOrder(order.id)).status).toBe(409);
  });

  it('can be cancelled after it has already gone out', async () => {
    // A customer refusing delivery cancels an order that was already dispatched.
    const order = await makeOrder([{ quantity: 1 }]);
    expect((await api('POST', `/api/sales/${order.id}/dispatch`, { token })).status).toBe(200);

    const res = await cancelOrder(order.id, 'zz-test refused at the door');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.status).toBe('CANCELLED');
  });

  it('refuses a cancellation with no reason', async () => {
    const order = await makeOrder([{ quantity: 1 }]);
    const res = await api('POST', `/api/sales/${order.id}/cancel`, { token, body: { reason: '  ' } });
    expect(res.status).toBe(422);
  });

  it('keeps the payments and the paid figure untouched', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    await pay(order.id, { amount: '150.00', method: 'PREPAID', reference: 'zz-test-keepme' });

    const after = (await cancelOrder(order.id)).body.data!.order;

    expect(after.money.paid).toBe('150.00');
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]!.reference).toBe('zz-test-keepme');
  });
});

// ===========================================================================
//  D — partial cancellation
// ===========================================================================

describe('cancelling part of an order', () => {
  it('preserves ordered, cancelled and remaining separately', async () => {
    const order = await makeOrder([{ quantity: 3 }, { quantity: 2 }]);
    const [a, b] = order.items;

    const res = await cancelItems(order.id, [{ itemId: a!.id, quantity: 1 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = res.body.data!.order;
    // Product A: ordered 3, cancelled 1, remaining 2 — the brief's example.
    expect(after.items[0]!.quantity).toBe(3);
    expect(after.items[0]!.cancelledQty).toBe(1);
    expect(after.items[0]!.remainingQty).toBe(2);
    // Product B: untouched.
    expect(after.items[1]!.quantity).toBe(2);
    expect(after.items[1]!.cancelledQty).toBe(0);
    expect(after.items[1]!.remainingQty).toBe(2);
    expect(after.items[1]!.id).toBe(b!.id);

    // The order is still live: only some of it was called off.
    expect(after.status).toBe('OPEN');
  });

  it('accumulates across several cancellations', async () => {
    const order = await makeOrder([{ quantity: 5 }]);
    const line = order.items[0]!;

    await cancelItems(order.id, [{ itemId: line.id, quantity: 2 }]);
    await cancelItems(order.id, [{ itemId: line.id, quantity: 1 }]);

    const after = await detail(order.id);
    expect(after.items[0]!.cancelledQty).toBe(3);
    expect(after.items[0]!.remainingQty).toBe(2);
    // The ordered quantity never moved.
    expect(after.items[0]!.quantity).toBe(5);
  });

  it('cannot cancel more than was ordered, however it is split up', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    const line = order.items[0]!;

    await cancelItems(order.id, [{ itemId: line.id, quantity: 2 }]);

    const over = await cancelItems(order.id, [{ itemId: line.id, quantity: 2 }]);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('CANCEL_EXCEEDS_REMAINING');

    // Refused entirely — the first two are still the only ones cancelled.
    expect((await detail(order.id)).items[0]!.cancelledQty).toBe(2);
  });

  it('refuses a single request larger than the whole line', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    const res = await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 3 }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCEL_EXCEEDS_REMAINING');
  });

  it('refuses a line belonging to another order', async () => {
    const mine = await makeOrder([{ quantity: 2 }]);
    const theirs = await makeOrder([{ quantity: 2 }]);

    const res = await cancelItems(mine.id, [{ itemId: theirs.items[0]!.id, quantity: 1 }]);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ITEM_NOT_FOUND');
  });

  it('cancels the order itself once nothing is left to send', async () => {
    // Cancelling every remaining unit IS cancelling the order; leaving it OPEN
    // would put it on the dispatch board with nothing to dispatch.
    const order = await makeOrder([{ quantity: 2 }]);

    const res = await cancelItems(
      order.id,
      [{ itemId: order.items[0]!.id, quantity: 2 }],
      'zz-test everything went',
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.status).toBe('CANCELLED');
    expect(res.body.data!.order.cancellationReason).toBe('zz-test everything went');
  });
});

// ===========================================================================
//  E + F — the money that follows, and the money that must not move
// ===========================================================================

describe('what cancelling does to the money', () => {
  it('moves value from active to cancelled and leaves the ordered total alone', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    expect(order.money.total).toBe('300.00');
    expect(order.money.activeTotal).toBe('300.00');
    expect(order.money.cancelledTotal).toBe('0.00');

    await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 1 }]);
    const after = await detail(order.id);

    // `total` keeps meaning what was ORDERED — it is what the money guard
    // prices, and the record of what was agreed.
    expect(after.money.total).toBe('300.00');
    expect(after.money.activeTotal).toBe('200.00');
    expect(after.money.cancelledTotal).toBe('100.00');
  });

  it('turns money already paid into refundable, and refunds none of it', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    await pay(order.id, { amount: '300.00', method: 'PREPAID', reference: 'zz-test-paid' });

    await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 1 }]);
    const after = await detail(order.id);

    expect(after.money.paid).toBe('300.00');
    expect(after.money.activeTotal).toBe('200.00');
    expect(after.money.refundable).toBe('100.00');
    // THE POINT: nothing has been paid back.
    expect(after.money.refunded).toBe('0.00');
    expect(after.money.refundPending).toBe('0.00');
    expect(after.refunds).toHaveLength(0);
    // And the customer no longer owes anything on what is left.
    expect(after.money.pending).toBe('0.00');
  });

  it('makes the whole paid amount refundable when the order is called off', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    await pay(order.id, { amount: '200.00', method: 'PREPAID' });

    const after = (await cancelOrder(order.id)).body.data!.order;

    expect(after.money.activeTotal).toBe('0.00');
    expect(after.money.refundable).toBe('200.00');
    expect(after.money.refunded).toBe('0.00');
  });

  it('never lets the payable move, so a paid order can still be cancelled', async () => {
    /*
      The trigger check. sales_order_money_guard refuses paid > payable, and it
      prices the ORDERED quantities. Paying in full and then cancelling half is
      exactly the transaction that would be refused if cancelling reduced the
      quantity — so if this commits, the design holds.
    */
    const order = await makeOrder([{ quantity: 4 }]);
    await pay(order.id, { amount: '400.00', method: 'PREPAID' });

    const res = await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 2 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await prisma.salesOrderItem.findUnique({
      where: { id: order.items[0]!.id },
      select: { quantity: true, cancelledQty: true },
    });
    expect(row!.quantity).toBe(4);
    expect(row!.cancelledQty).toBe(2);
  });

  it('leaves GST exactly as it was', async () => {
    // Cancellation is not a tax change. The heads, the rate and the tax on the
    // ordered value all stay put; only the active value moves.
    const order = await makeOrder([{ quantity: 2, price: '1000.00', gstRate: '18' }]);
    const before = order.money;

    await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 1 }]);
    const after = (await detail(order.id)).money;

    expect(after.taxSplit).toBe(before.taxSplit);
    expect(after.taxTotal).toBe(before.taxTotal);
    expect(after.cgstTotal).toBe(before.cgstTotal);
    expect(after.sgstTotal).toBe(before.sgstTotal);
    expect(after.igstTotal).toBe(before.igstTotal);
    expect(after.total).toBe(before.total);
    // Half the goods called off, so half the value — tax included.
    expect(after.activeTotal).toBe('1180.00');
    expect(after.cancelledTotal).toBe('1180.00');
  });
});

// ===========================================================================
//  E — refunds
// ===========================================================================

describe('recording money going back', () => {
  async function cancelledAndPaid(): Promise<SalesOrderDetail> {
    const order = await makeOrder([{ quantity: 2 }]);
    await pay(order.id, { amount: '200.00', method: 'PREPAID' });
    await cancelOrder(order.id);
    return detail(order.id);
  }

  it('records a refund as owed, not as sent', async () => {
    const order = await cancelledAndPaid();

    const res = await refund(order.id, { amount: '200.00', reason: 'zz-test order cancelled' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const after = res.body.data!.order;
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]!.status).toBe('PENDING');
    expect(after.refunds[0]!.reference).toBeNull();
    expect(after.refunds[0]!.requestedBy.id).toBe(admin.id);
    // Agreed, not gone. The customer is still owed.
    expect(after.money.refundPending).toBe('200.00');
    expect(after.money.refunded).toBe('0.00');
    expect(after.money.refundable).toBe('0.00');
  });

  it('counts it as refunded only once it is settled, with a reference', async () => {
    const order = await cancelledAndPaid();
    const created = await refund(order.id, { amount: '200.00', reason: 'zz-test cancelled' });
    const refundId = created.body.data!.order.refunds[0]!.id;

    const res = await settle(order.id, refundId, { reference: 'zz-test-UTR-99881' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = res.body.data!.order;
    expect(after.refunds[0]!.status).toBe('COMPLETED');
    expect(after.refunds[0]!.reference).toBe('zz-test-UTR-99881');
    expect(after.refunds[0]!.settledBy!.id).toBe(admin.id);
    expect(after.refunds[0]!.settledAt).not.toBeNull();
    expect(after.money.refunded).toBe('200.00');
    expect(after.money.refundPending).toBe('0.00');
  });

  it('refuses to settle without saying how the money went', async () => {
    const order = await cancelledAndPaid();
    const created = await refund(order.id, { amount: '50.00', reason: 'zz-test part' });
    const refundId = created.body.data!.order.refunds[0]!.id;

    expect((await settle(order.id, refundId, {})).status).toBe(422);
    expect((await settle(order.id, refundId, { reference: '  ' })).status).toBe(422);
  });

  it('refuses more than is refundable, counting what is already promised', async () => {
    const order = await cancelledAndPaid();

    const over = await refund(order.id, { amount: '250.00', reason: 'zz-test too much' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('REFUND_EXCEEDS_REFUNDABLE');

    // Half now; the other half is still refundable, and no more than that.
    await refund(order.id, { amount: '120.00', reason: 'zz-test first half' });
    const second = await refund(order.id, { amount: '100.00', reason: 'zz-test second' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REFUND_EXCEEDS_REFUNDABLE');

    const ok = await refund(order.id, { amount: '80.00', reason: 'zz-test the rest' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data!.order.money.refundable).toBe('0.00');
  });

  it('refuses a refund on an order with nothing refundable', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    await pay(order.id, { amount: '200.00', method: 'PREPAID' });

    // Paid in full and nothing cancelled: the customer is owed nothing.
    const res = await refund(order.id, { amount: '10.00', reason: 'zz-test unearned' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_REFUNDABLE');
  });

  it('gives the money back to the refundable pool when a refund is rejected', async () => {
    const order = await cancelledAndPaid();
    const created = await refund(order.id, { amount: '200.00', reason: 'zz-test agreed' });
    const refundId = created.body.data!.order.refunds[0]!.id;
    expect(created.body.data!.order.money.refundable).toBe('0.00');

    const res = await reject(order.id, refundId, { note: 'zz-test settled as credit instead' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = res.body.data!.order;
    expect(after.refunds[0]!.status).toBe('REJECTED');
    expect(after.money.refunded).toBe('0.00');
    expect(after.money.refundPending).toBe('0.00');
    // Nothing went anywhere, so it is owed again.
    expect(after.money.refundable).toBe('200.00');
  });

  it('decides a refund exactly once', async () => {
    const order = await cancelledAndPaid();
    const created = await refund(order.id, { amount: '200.00', reason: 'zz-test' });
    const refundId = created.body.data!.order.refunds[0]!.id;

    await settle(order.id, refundId, { reference: 'zz-test-first' });

    const again = await settle(order.id, refundId, { reference: 'zz-test-second' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REFUND_ALREADY_SETTLED');
  });

  it('refuses a refund belonging to another order', async () => {
    const mine = await cancelledAndPaid();
    const theirs = await cancelledAndPaid();
    const created = await refund(theirs.id, { amount: '50.00', reason: 'zz-test theirs' });
    const refundId = created.body.data!.order.refunds[0]!.id;

    const res = await settle(mine.id, refundId, { reference: 'zz-test-wrong-order' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_REFUND_NOT_FOUND');
  });
});

// ===========================================================================
//  G — Procurement stock safety
// ===========================================================================

describe('cancelling a line that purchased stock is committed to', () => {
  it('is refused rather than reconciled in Sales', async () => {
    /*
      Procurement took these goods out of free CRM stock when it allocated them,
      and PurchaseBillItem.stockedQty records exactly how much this line
      consumed. Sales cannot put that right — releasing an allocation is
      Procurement's own operation, and its reconcile is the single writer of
      crmStockQty — so Sales refuses and names the step.
    */
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const order = await makeOrder([{ quantity: 2, rsProductId: rs.id }]);
    await allocateTo(rs.id, order.items[0]!.id, 2);

    const partial = await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 1 }]);
    expect(partial.status, JSON.stringify(partial.body)).toBe(409);
    expect(partial.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');

    const whole = await cancelOrder(order.id);
    expect(whole.status).toBe(409);
    expect(whole.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');
  });

  it('leaves the allocation, the stock ledger and CRM stock untouched', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const order = await makeOrder([{ quantity: 3, rsProductId: rs.id }]);
    await allocateTo(rs.id, order.items[0]!.id, 3);

    const crmBefore = await prisma.shopifyVariant.aggregate({
      where: { rsProductId: rs.id },
      _sum: { crmStockQty: true },
    });
    const billLines = await prisma.purchaseBillItem.findMany({
      where: { allocations: { some: { salesOrderItemId: order.items[0]!.id } } },
      select: { id: true, stockedQty: true, receivedQty: true },
    });

    await cancelItems(order.id, [{ itemId: order.items[0]!.id, quantity: 1 }]);
    await cancelOrder(order.id);

    // No allocation released, no stock moved, no line cancelled.
    expect(
      await prisma.purchaseAllocation.count({ where: { salesOrderItemId: order.items[0]!.id } }),
    ).toBe(1);

    const crmAfter = await prisma.shopifyVariant.aggregate({
      where: { rsProductId: rs.id },
      _sum: { crmStockQty: true },
    });
    expect(crmAfter._sum.crmStockQty).toBe(crmBefore._sum.crmStockQty);

    for (const line of billLines) {
      const now = await prisma.purchaseBillItem.findUnique({
        where: { id: line.id },
        select: { stockedQty: true },
      });
      expect(now!.stockedQty).toBe(line.stockedQty);
      // received − allocated, which is the rule the figure holds.
      expect(now!.stockedQty).toBe(line.receivedQty - 3);
    }

    const item = await prisma.salesOrderItem.findUnique({
      where: { id: order.items[0]!.id },
      select: { cancelledQty: true },
    });
    expect(item!.cancelledQty).toBe(0);
  });

  it('still cancels a line with no allocation on the same order', async () => {
    // The guard is about committed stock, not about cancellation in general.
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const order = await makeOrder([
      { quantity: 2, rsProductId: rs.id },
      { quantity: 2 },
    ]);
    await allocateTo(rs.id, order.items[0]!.id, 2);

    const res = await cancelItems(order.id, [{ itemId: order.items[1]!.id, quantity: 1 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.items[1]!.cancelledQty).toBe(1);
    expect(res.body.data!.order.items[0]!.cancelledQty).toBe(0);
  });
});
