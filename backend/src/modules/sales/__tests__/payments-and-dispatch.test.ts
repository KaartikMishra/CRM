import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SalesOrderDetail } from '@rs/shared';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  backdateDispatchDeadline,
  cleanup,
  makeCustomer,
  makeUser,
  residualTestRows,
  salesItemPayload,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { order: SalesOrderDetail };

let owner: TestUser;
let ownerToken: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  owner = await makeUser('USER');
  ownerToken = await mintToken(owner.id, { role: 'USER' });
  customerId = (await makeCustomer('RETAIL')).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/** A fresh order per test, so one test's state cannot leak into another. */
/** A single-line order worth exactly 1000.00, unless overridden. */
async function newOrder(overrides: Record<string, unknown> = {}): Promise<SalesOrderDetail> {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token: ownerToken,
    body: salesOrderPayload(customerId, {
      items: [salesItemPayload({ quantity: 10, price: '100.00' })],
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
}

const pay = (id: string, amount: string) =>
  api<Wrapped>('POST', `/api/sales/${id}/payments`, { token: ownerToken, body: { amount } });

const dispatch = (id: string) =>
  api<Wrapped>('POST', `/api/sales/${id}/dispatch`, { token: ownerToken });

const close = (id: string) =>
  api<Wrapped>('POST', `/api/sales/${id}/close`, { token: ownerToken });

/**
 * Pays an order off in full.
 *
 * Closing now requires a zero balance, so any test that is really about the
 * lifecycle has to settle first. Kept explicit rather than folded into
 * `newOrder`, so the tests that are about the settlement rule itself can still
 * create a part-paid order.
 */
async function settle(order: SalesOrderDetail): Promise<void> {
  const res = await pay(order.id, order.money.pending);
  expect(res.status).toBe(201);
  expect(res.body.data!.order.money.fullyPaid).toBe(true);
}

describe('partial payments', () => {
  it('accumulates payments rather than replacing them', async () => {
    const order = await newOrder(); // total 1000.00

    const first = await pay(order.id, '300.00');
    expect(first.status).toBe(201);
    expect(first.body.data!.order.money.paid).toBe('300.00');
    expect(first.body.data!.order.money.pending).toBe('700.00');

    const second = await pay(order.id, '250.50');
    expect(second.body.data!.order.money.paid).toBe('550.50');
    expect(second.body.data!.order.money.pending).toBe('449.50');
    expect(second.body.data!.order.money.fullyPaid).toBe(false);
  });

  it('settles an order exactly, leaving nothing pending', async () => {
    const order = await newOrder();

    await pay(order.id, '400.00');
    const final = await pay(order.id, '600.00');

    expect(final.body.data!.order.money.pending).toBe('0.00');
    expect(final.body.data!.order.money.fullyPaid).toBe(true);
  });

  it('refuses a payment that would exceed the total', async () => {
    const order = await newOrder();
    await pay(order.id, '900.00');

    const res = await pay(order.id, '200.00');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');
  });

  it('refuses any further payment once settled', async () => {
    const order = await newOrder();
    await pay(order.id, '1000.00');

    const res = await pay(order.id, '0.01');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_FULLY_PAID');
  });

  it('refuses a payment that is zero or negative', async () => {
    const order = await newOrder();

    expect((await pay(order.id, '0')).status).toBe(422);
    expect((await pay(order.id, '-50.00')).status).toBe(422);
  });
});

/*
 * The two tests that lived here PATCHed an item and expected the total to move
 * immediately. That was the defect, not the specification: an owner could
 * rewrite a live product with no review. Direct item mutation no longer exists,
 * so the equivalent coverage — that a reduction below what is paid is refused —
 * now lives in item-change-requests.test.ts against the approval path.
 */

describe('dispatch freezes the efficiency verdict', () => {
  it('records ON_TIME when dispatched before the deadline', async () => {
    const order = await newOrder();

    const res = await dispatch(order.id);
    expect(res.status).toBe(200);
    expect(res.body.data!.order.status).toBe('DISPATCHED');
    expect(res.body.data!.order.efficiency).toBe('ON_TIME');
    expect(res.body.data!.order.dispatchedAt).not.toBeNull();
  });

  it('records DELAYED when the deadline has already passed', async () => {
    const order = await newOrder();
    await backdateDispatchDeadline(order.id, 3);

    const res = await dispatch(order.id);
    expect(res.body.data!.order.efficiency).toBe('DELAYED');
  });

  it('treats a dispatch on the deadline day itself as on time', async () => {
    // The deadline is a date, so any moment during that day still counts.
    const today = new Date().toISOString();
    const order = await newOrder({ orderDate: today, toBeDispatchedBy: today });

    const res = await dispatch(order.id);
    expect(res.body.data!.order.efficiency).toBe('ON_TIME');
  });

  it('never rewrites the verdict — a second dispatch is refused', async () => {
    const order = await newOrder();
    const first = await dispatch(order.id);
    const frozen = first.body.data!.order.efficiency;

    const second = await dispatch(order.id);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INVALID_STATUS_TRANSITION');

    const after = await api<Wrapped>('GET', `/api/sales/${order.id}`, { token: ownerToken });
    expect(after.body.data!.order.efficiency).toBe(frozen);
  });

  it('leaves the verdict alone when the deadline is edited afterwards', async () => {
    const order = await newOrder();
    await dispatch(order.id);
    await backdateDispatchDeadline(order.id, 30);

    const after = await api<Wrapped>('GET', `/api/sales/${order.id}`, { token: ownerToken });
    // Still ON_TIME: efficiency was frozen, not recomputed on read.
    expect(after.body.data!.order.efficiency).toBe('ON_TIME');
  });
});

describe('status lifecycle', () => {
  it('runs OPEN -> DISPATCHED -> CLOSED', async () => {
    const order = await newOrder();
    expect(order.status).toBe('OPEN');

    expect((await dispatch(order.id)).body.data!.order.status).toBe('DISPATCHED');

    await settle(order);

    const closed = await close(order.id);
    expect(closed.status).toBe(200);
    expect(closed.body.data!.order.status).toBe('CLOSED');
    expect(closed.body.data!.order.closedAt).not.toBeNull();
    expect(closed.body.data!.order.closedBy?.id).toBe(owner.id);
  });

  it('refuses to close an order that was never dispatched', async () => {
    const order = await newOrder();

    const res = await close(order.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  describe('closing requires full settlement', () => {
    it('refuses to close while any balance is outstanding', async () => {
      const order = await newOrder(); // total 1000.00
      await dispatch(order.id);
      await pay(order.id, '400.00');

      const res = await close(order.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_OUTSTANDING');
    });

    it('refuses to close an entirely unpaid order', async () => {
      const order = await newOrder();
      await dispatch(order.id);

      const res = await close(order.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_OUTSTANDING');
    });

    it('refuses over a single paisa short', async () => {
      // The requirement's own example, scaled: 999.99 against a 1000.00 total.
      const order = await newOrder();
      await dispatch(order.id);
      await pay(order.id, '999.99');

      const res = await close(order.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_OUTSTANDING');
      // And the message names what is actually left.
      expect(res.body.message).toContain('0.01');
    });

    it('allows the close at exactly zero pending', async () => {
      const order = await newOrder();
      await dispatch(order.id);
      await pay(order.id, '999.99');
      await pay(order.id, '0.01');

      const res = await close(order.id);
      expect(res.status).toBe(200);
      expect(res.body.data!.order.status).toBe('CLOSED');
      expect(res.body.data!.order.money.pending).toBe('0.00');
    });

    it('lets a refused close succeed once the balance is settled', async () => {
      const order = await newOrder();
      await dispatch(order.id);
      await pay(order.id, '600.00');

      expect((await close(order.id)).body.code).toBe('PAYMENT_OUTSTANDING');

      await pay(order.id, '400.00');
      expect((await close(order.id)).status).toBe(200);
    });
  });

  it('refuses every change once closed', async () => {
    const order = await newOrder();
    await dispatch(order.id);
    await settle(order);
    await close(order.id);

    const edit = await api<Wrapped>('PATCH', `/api/sales/${order.id}`, {
      token: ownerToken,
      body: { productName: 'renamed' },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('ORDER_CLOSED');

    const payment = await pay(order.id, '10.00');
    expect(payment.status).toBe(409);
    expect(payment.body.code).toBe('ORDER_CLOSED');
  });

  it('has no reopen path', async () => {
    const order = await newOrder();
    await dispatch(order.id);
    await settle(order);
    await close(order.id);

    const res = await api('POST', `/api/sales/${order.id}/reopen`, { token: ownerToken });
    expect(res.status).toBe(404);
  });
});

describe('overdue is derived, not stored', () => {
  it('flags an undispatched order past its deadline', async () => {
    const order = await newOrder();
    await backdateDispatchDeadline(order.id, 2);

    const res = await api<Wrapped>('GET', `/api/sales/${order.id}`, { token: ownerToken });
    expect(res.body.data!.order.overdue).toBe(true);
    // Overdue is a live fact; efficiency is still unset because it never shipped.
    expect(res.body.data!.order.efficiency).toBeNull();
  });

  it('stops flagging once the order is dispatched', async () => {
    const order = await newOrder();
    await backdateDispatchDeadline(order.id, 2);
    await dispatch(order.id);

    const res = await api<Wrapped>('GET', `/api/sales/${order.id}`, { token: ownerToken });
    expect(res.body.data!.order.overdue).toBe(false);
    expect(res.body.data!.order.efficiency).toBe('DELAYED');
  });
});
