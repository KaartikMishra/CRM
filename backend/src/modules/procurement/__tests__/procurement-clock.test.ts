/**
 * The Procurement Clock: T+2, coverage, and the four states.
 *
 * Four things this suite exists to hold down, in order of how badly each would
 * hurt if it broke:
 *
 *   1. PARTIAL COVERAGE IS NOT COVERAGE. An order with three lines and two of
 *      them procured is UNFULFILLED, not fulfilled. Getting this wrong would tell
 *      a business its customer's order was ready when a third of it was missing.
 *
 *   2. A CANCELLED ORDER IS NOT A SUCCESS. Once every line is called off the
 *      remaining requirement is zero, so naive arithmetic reports the order as
 *      covered. It must not: nothing was ever bought.
 *
 *   3. THE DEADLINE NEVER MOVES; THE RESULT CAN. T+2 is computed once from
 *      orderDate. The completion result is written when coverage reaches zero and
 *      CLEARED when coverage is lost — an order that is no longer covered must not
 *      go on claiming it was fulfilled.
 *
 *   4. NO SECOND LEDGER. Required, purchased and outstanding are read from the
 *      order's own lines and their allocations. The clock stores none of them.
 *
 * Amounts are kept boring so a failure means a rule broke rather than that the
 * arithmetic was hard to follow.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcurementClockDetail, ProcurementClockSummary } from '@rs/shared';
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

const DAY = 86_400_000;

type Line = { quantity: number; rsProductId?: string };
type OrderBody = { order: { id: string; items: { id: string; rsProductId: string | null }[] } };

/**
 * An order whose own orderDate decides its deadline.
 *
 * `daysAgo` is how the past is reached without waiting: the clock's T is the
 * order's orderDate, so an order dated eight days ago is already well past its
 * T+2 — no fixture rewrites a deadline, and none can, which is the point.
 */
async function makeOrder(
  lines: Line[],
  daysAgo = 0,
): Promise<{ id: string; items: { id: string }[] }> {
  const orderDate = new Date(Date.now() - daysAgo * DAY);
  const res = await api<OrderBody>('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customer.id, {
      items: lines.map((line, i) => ({
        productName: `zz-test clock line ${i + 1}`,
        ...(line.rsProductId ? { rsProductId: line.rsProductId } : {}),
        quantity: line.quantity,
        price: '100.00',
        gstMode: 'EXCLUSIVE',
      })),
      paidAmount: '0',
      orderDate: orderDate.toISOString(),
      // The dispatch deadline is a separate rule; kept at or after orderDate so
      // sales_dispatch_not_before_order is satisfied.
      toBeDispatchedBy: new Date(orderDate.getTime() + 30 * DAY).toISOString(),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
}

const clock = async (orderId: string): Promise<ProcurementClockDetail> => {
  const res = await api<{ order: ProcurementClockDetail }>(
    'GET',
    `/api/procurement/clock/${orderId}`,
    { token },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data!.order;
};

const board = async (query = ''): Promise<ProcurementClockSummary[]> => {
  const res = await api<{ orders: ProcurementClockSummary[] }>(
    'GET',
    `/api/procurement/clock${query}`,
    { token },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data!.orders;
};

/** Records supply that came from stock rather than a purchase. */
const supplyByHand = (itemId: string, qty: number) =>
  api('PATCH', `/api/procurement/order-lines/${itemId}/fulfillment`, {
    token,
    body: { alreadyFulfilled: qty },
  });

/** An approved, fully received bill line allocated to one order line. */
async function allocate(
  rsProductId: string,
  salesOrderItemId: string,
  quantity: number,
): Promise<{ billId: string; itemId: string; allocationId: string }> {
  const billed = await api<{ bill: { id: string; items: { id: string }[] } }>(
    'POST',
    '/api/procurement/bills',
    {
      token,
      body: purchaseBillPayload(vendor.id, rsProductId, {
        items: [
          {
            productName: 'zz-test clock purchase',
            rsProductId,
            orderedQty: quantity,
            receivedQty: quantity,
            rate: '10.00',
          },
        ],
      }),
    },
  );
  expect(billed.status, JSON.stringify(billed.body)).toBe(201);
  const bill = billed.body.data!.bill;
  trackPurchaseBill(bill.id);
  await approvePurchaseBill(bill.id);

  const res = await api<{ bill: { items: { id: string; allocations: { id: string }[] }[] } }>(
    'POST',
    `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`,
    { token, body: { salesOrderItemId, quantity } },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const line = res.body.data!.bill.items[0]!;
  return { billId: bill.id, itemId: bill.items[0]!.id, allocationId: line.allocations[0]!.id };
}

const releaseAllocation = (billId: string, itemId: string, allocationId: string) =>
  api('PATCH', `/api/procurement/bills/${billId}/items/${itemId}/allocations/${allocationId}`, {
    token,
    body: { quantity: 0 },
  });

/** The end of the IST day two days after `orderDate`, computed independently. */
function expectedDeadline(orderDate: Date): number {
  const IST = 330 * 60_000;
  const shifted = orderDate.getTime() + 2 * DAY + IST;
  return Math.floor(shifted / DAY) * DAY + DAY - 1 - IST;
}

// ===========================================================================
//  A — the clock starts with the order
// ===========================================================================

describe('a sales order arrives on the clock', () => {
  it('gets a clock the moment it is created, without being asked', async () => {
    const order = await makeOrder([{ quantity: 3 }]);
    const view = await clock(order.id);

    expect(view.orderId).toBe(order.id);
    expect(view.state).toBe('UNFULFILLED');
    expect(view.completedAt).toBeNull();
    expect(view.verdict).toBeNull();
  });

  it('sets the deadline to T+2, where T is the order date', async () => {
    const orderDate = new Date(Date.now() - 4 * DAY);
    const res = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        orderDate: orderDate.toISOString(),
        toBeDispatchedBy: new Date(orderDate.getTime() + 30 * DAY).toISOString(),
        items: [{ productName: 'zz-test deadline', quantity: 1, price: '100.00', gstMode: 'EXCLUSIVE' }],
        paidAmount: '0',
      }),
    });
    expect(res.status).toBe(201);
    trackSalesOrder(res.body.data!.order.id);

    const view = await clock(res.body.data!.order.id);
    expect(new Date(view.deadline).getTime()).toBe(expectedDeadline(orderDate));
  });

  it('appears on the board with the customer and the order number', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    const row = (await board()).find((r) => r.orderId === order.id);

    expect(row).toBeDefined();
    expect(row!.customerName).toBe(customer.name);
    expect(row!.outstandingQty).toBe(2);
    expect(row!.itemCount).toBe(1);
  });

  it('keeps exactly one clock per order', async () => {
    const order = await makeOrder([{ quantity: 1 }]);
    expect(await prisma.procurementClock.count({ where: { orderId: order.id } })).toBe(1);
  });
});

// ===========================================================================
//  B — the four states
// ===========================================================================

describe('the four states, and the two delayed ones kept apart', () => {
  it('is UNFULFILLED while the deadline is still ahead', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    expect((await clock(order.id)).state).toBe('UNFULFILLED');
  });

  it('becomes UNFULFILLED_WITH_DELAY once the deadline passes with work outstanding', async () => {
    // Dated eight days ago, so its T+2 is six days gone.
    const order = await makeOrder([{ quantity: 2 }], 8);
    const view = await clock(order.id);

    expect(view.state).toBe('UNFULFILLED_WITH_DELAY');
    // Still genuinely unfulfilled — the order is owed goods, not merely late.
    expect(view.completedAt).toBeNull();
    expect(view.outstandingQty).toBe(2);
  });

  it('is FULFILLED_ON_TIME when covered before the deadline', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    expect((await supplyByHand(order.items[0]!.id, 2)).status).toBe(200);

    const view = await clock(order.id);
    expect(view.state).toBe('FULFILLED_ON_TIME');
    expect(view.verdict).toBe('ON_TIME');
    expect(view.completedAt).not.toBeNull();
    expect(view.completionEstimated).toBe(false);
  });

  it('is FULFILLED_DELAYED when covered after it', async () => {
    const order = await makeOrder([{ quantity: 2 }], 8);
    expect((await supplyByHand(order.items[0]!.id, 2)).status).toBe(200);

    const view = await clock(order.id);
    expect(view.state).toBe('FULFILLED_DELAYED');
    expect(view.verdict).toBe('DELAYED');
    expect(view.outstandingQty).toBe(0);
  });

  it('never reports the same order as both late and short and covered late', async () => {
    // The two delayed outcomes are mutually exclusive by construction, and the
    // point of the test is that one order can only be in one of them.
    const late = await makeOrder([{ quantity: 1 }], 8);
    expect((await clock(late.id)).state).toBe('UNFULFILLED_WITH_DELAY');

    await supplyByHand(late.items[0]!.id, 1);
    expect((await clock(late.id)).state).toBe('FULFILLED_DELAYED');
  });

  it('filters the board by state', async () => {
    const order = await makeOrder([{ quantity: 1 }], 8);
    const rows = await board('?state=UNFULFILLED_WITH_DELAY');

    expect(rows.every((row) => row.state === 'UNFULFILLED_WITH_DELAY')).toBe(true);
    expect(rows.some((row) => row.orderId === order.id)).toBe(true);
  });
});

// ===========================================================================
//  C — partial procurement, at item and quantity level
// ===========================================================================

describe('partial procurement is tracked per item and per unit', () => {
  it('leaves A and B covered and C outstanding, and the order unfulfilled', async () => {
    // The brief's own example: three lines, two supplied, one not.
    const order = await makeOrder([{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }]);
    const [a, b, c] = order.items;

    expect((await supplyByHand(a!.id, 1)).status).toBe(200);
    expect((await supplyByHand(b!.id, 1)).status).toBe(200);

    const view = await clock(order.id);
    expect(view.items.map((item) => item.status)).toEqual([
      'FULFILLED',
      'FULFILLED',
      'UNFULFILLED',
    ]);
    expect(view.items.map((item) => item.outstandingQty)).toEqual([0, 0, 1]);

    // The order is NOT fulfilled because two thirds of it are.
    expect(view.state).toBe('UNFULFILLED');
    expect(view.completedAt).toBeNull();
    expect(view.outstandingQty).toBe(1);
    expect(view.outstandingLines).toBe(1);
    expect(c!.id).toBe(view.items[2]!.salesOrderItemId);
  });

  it('counts part of a line as partial, not as done', async () => {
    const order = await makeOrder([{ quantity: 5 }]);
    expect((await supplyByHand(order.items[0]!.id, 3)).status).toBe(200);

    const view = await clock(order.id);
    expect(view.items[0]!.status).toBe('PARTIAL');
    expect(view.items[0]!.outstandingQty).toBe(2);
    expect(view.state).toBe('UNFULFILLED');
  });

  it('adds the two supply routes together rather than picking one', async () => {
    const product = await makeRsProduct({ crmStockQty: 10, inventoryQty: 10 });
    const order = await makeOrder([{ quantity: 4, rsProductId: product.id }]);

    expect((await supplyByHand(order.items[0]!.id, 1)).status).toBe(200);
    await allocate(product.id, order.items[0]!.id, 3);

    const view = await clock(order.id);
    expect(view.items[0]!.alreadyFulfilled).toBe(1);
    expect(view.items[0]!.allocatedQty).toBe(3);
    expect(view.items[0]!.totalFulfilled).toBe(4);
    expect(view.items[0]!.outstandingQty).toBe(0);
    expect(view.state).toBe('FULFILLED_ON_TIME');
  });

  it('reports what was ordered, what was cancelled and what is left as three figures', async () => {
    const order = await makeOrder([{ quantity: 5 }]);
    expect(
      (
        await api('POST', `/api/sales/${order.id}/cancel-items`, {
          token,
          body: { reason: 'zz-test cut the order down', lines: [{ itemId: order.items[0]!.id, quantity: 2 }] },
        })
      ).status,
    ).toBe(200);

    const view = await clock(order.id);
    expect(view.items[0]!.orderedQty).toBe(5);
    expect(view.items[0]!.cancelledQty).toBe(2);
    // The clock asks procurement for what is left, not for what was ordered.
    expect(view.items[0]!.requiredQty).toBe(3);
    expect(view.items[0]!.outstandingQty).toBe(3);
  });
});

// ===========================================================================
//  D — the deadline never moves; the result can be invalidated
// ===========================================================================

describe('the deadline is immutable and the completion result is not', () => {
  it('does not move the deadline when the order is edited', async () => {
    const order = await makeOrder([{ quantity: 1 }]);
    const before = (await clock(order.id)).deadline;

    const edited = await api('PATCH', `/api/sales/${order.id}`, {
      token,
      body: { toBeDispatchedBy: new Date(Date.now() + 90 * DAY).toISOString() },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    expect((await clock(order.id)).deadline).toBe(before);
  });

  it('invalidates the result when an allocation is released', async () => {
    const product = await makeRsProduct({ crmStockQty: 5, inventoryQty: 5 });
    const order = await makeOrder([{ quantity: 2, rsProductId: product.id }]);
    const alloc = await allocate(product.id, order.items[0]!.id, 2);

    const covered = await clock(order.id);
    expect(covered.state).toBe('FULFILLED_ON_TIME');
    const deadline = covered.deadline;

    expect((await releaseAllocation(alloc.billId, alloc.itemId, alloc.allocationId)).status).toBe(200);

    const after = await clock(order.id);
    // No longer covered, so it must not go on claiming it was.
    expect(after.completedAt).toBeNull();
    expect(after.verdict).toBeNull();
    expect(after.state).toBe('UNFULFILLED');
    expect(after.outstandingQty).toBe(2);
    // And the bar it will be measured against again is the same one.
    expect(after.deadline).toBe(deadline);
  });

  it('decides a re-completion against the same deadline, so a late one is DELAYED', async () => {
    const product = await makeRsProduct({ crmStockQty: 5, inventoryQty: 5 });
    // Dated in the past, so any completion is already late.
    const order = await makeOrder([{ quantity: 2, rsProductId: product.id }], 8);
    const alloc = await allocate(product.id, order.items[0]!.id, 2);

    expect((await clock(order.id)).verdict).toBe('DELAYED');

    await releaseAllocation(alloc.billId, alloc.itemId, alloc.allocationId);
    expect((await clock(order.id)).verdict).toBeNull();

    await allocate(product.id, order.items[0]!.id, 2);
    expect((await clock(order.id)).verdict).toBe('DELAYED');
  });
});

// ===========================================================================
//  E — cancellation stops the clock
// ===========================================================================

describe('a cancelled order is not a procurement success', () => {
  it('stops the clock rather than reporting the order as covered', async () => {
    const order = await makeOrder([{ quantity: 3 }]);

    const cancelled = await api('POST', `/api/sales/${order.id}/cancel`, {
      token,
      body: { reason: 'zz-test customer called it off' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const view = await clock(order.id);
    // Every line is cancelled, so the remaining requirement is zero — and this
    // is exactly where naive arithmetic would announce a success.
    expect(view.completedAt).toBeNull();
    expect(view.verdict).toBeNull();
    expect(view.state).toBeNull();
    expect(view.orderStatus).toBe('CANCELLED');
    expect(view.readyForDispatch).toBe(false);
  });

  it('stops accruing delay once cancelled, even well past the deadline', async () => {
    const order = await makeOrder([{ quantity: 1 }], 8);
    expect((await clock(order.id)).state).toBe('UNFULFILLED_WITH_DELAY');

    await api('POST', `/api/sales/${order.id}/cancel`, {
      token,
      body: { reason: 'zz-test abandoned' },
    });

    expect((await clock(order.id)).state).toBeNull();
  });

  it('clears a completion that had already been recorded', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    await supplyByHand(order.items[0]!.id, 2);
    expect((await clock(order.id)).verdict).toBe('ON_TIME');

    await api('POST', `/api/sales/${order.id}/cancel`, {
      token,
      body: { reason: 'zz-test cancelled after covering' },
    });

    const view = await clock(order.id);
    expect(view.completedAt).toBeNull();
    expect(view.state).toBeNull();
  });

  it('can complete when cancelling the last outstanding units', async () => {
    // Nothing is owed any more, which is the clock's only question.
    const order = await makeOrder([{ quantity: 4 }]);
    await supplyByHand(order.items[0]!.id, 1);

    const res = await api('POST', `/api/sales/${order.id}/cancel-items`, {
      token,
      body: { reason: 'zz-test cut the rest', lines: [{ itemId: order.items[0]!.id, quantity: 3 }] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const view = await clock(order.id);
    expect(view.items[0]!.requiredQty).toBe(1);
    expect(view.items[0]!.outstandingQty).toBe(0);
    expect(view.state).toBe('FULFILLED_ON_TIME');
    expect(view.orderStatus).toBe('OPEN');
  });
});

// ===========================================================================
//  F — no second ledger, and the handoff signal
// ===========================================================================

describe('the clock keeps no copy of anything', () => {
  it('stores only a deadline and a result — no quantity columns at all', async () => {
    const order = await makeOrder([{ quantity: 7 }]);
    const row = await prisma.procurementClock.findUnique({ where: { orderId: order.id } });

    expect(row).not.toBeNull();
    // If a quantity ever appears on this row, the clock has become a second
    // answer to what the customer ordered.
    expect(Object.keys(row!).sort()).toEqual(
      [
        'completedAt',
        'completionEstimated',
        'createdAt',
        'deadline',
        'id',
        'orderId',
        'updatedAt',
        'verdict',
      ].sort(),
    );
  });

  it('leaves CRM stock to Procurement — covering by hand moves none of it', async () => {
    const product = await makeRsProduct({ crmStockQty: 6, inventoryQty: 6 });
    const order = await makeOrder([{ quantity: 2, rsProductId: product.id }]);

    const before = await prisma.shopifyVariant.aggregate({
      where: { rsProductId: product.id },
      _sum: { crmStockQty: true },
    });
    await supplyByHand(order.items[0]!.id, 2);
    const after = await prisma.shopifyVariant.aggregate({
      where: { rsProductId: product.id },
      _sum: { crmStockQty: true },
    });

    expect(after._sum.crmStockQty).toBe(before._sum.crmStockQty);
  });

  it('publishes readyForDispatch only once the order is covered and still live', async () => {
    const order = await makeOrder([{ quantity: 2 }]);
    expect((await clock(order.id)).readyForDispatch).toBe(false);

    await supplyByHand(order.items[0]!.id, 2);
    expect((await clock(order.id)).readyForDispatch).toBe(true);
  });

  it('refuses a clock for an order that does not exist', async () => {
    const res = await api('GET', '/api/procurement/clock/cmzzzzzzzzzzzzzzzzzzzzzzz', { token });
    expect(res.status).toBe(404);
  });
});
