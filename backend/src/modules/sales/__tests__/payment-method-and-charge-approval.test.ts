/**
 * How the money arrived, and who may change what it came to.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *   A payment method is asked for exactly when money is recorded. Never on an
 *   order that has taken none — making everybody answer a question that does
 *   not apply to them is how a required field stops meaning anything.
 *
 *   Charges apply straight away the first time and need approval every time
 *   after. Entering a financial record is ordinary work; changing one somebody
 *   has already been told about is not.
 *
 * The sharpest check here is the one about a PENDING request: the order must go
 * on charging exactly what it charged before. If a proposal could move the
 * payable, then a user without SALES ASSIGN could change an order's money by
 * asking to — which is the whole thing the approval exists to prevent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SalesOrderDetail } from '@rs/shared';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  makeCustomer,
  makeUser,
  residualTestRows,
  salesItemPayload,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type OrderBody = { order: SalesOrderDetail };

let admin: TestUser;
let token: string;
/** A second reviewer, because nobody may decide their own request. */
let otherAdmin: TestUser;
let otherToken: string;
let staff: TestUser;
let staffToken: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  token = await mintToken(admin.id, { role: 'ADMIN' });
  otherAdmin = await makeUser('ADMIN');
  otherToken = await mintToken(otherAdmin.id, { role: 'ADMIN' });
  staff = await makeUser('USER');
  staffToken = await mintToken(staff.id, { role: 'USER' });
  customerId = (await makeCustomer('BULK', { state: 'Karnataka', country: 'India' })).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const createOrder = async (overrides: Record<string, unknown> = {}): Promise<SalesOrderDetail> => {
  const res = await api<OrderBody>('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customerId, {
      items: [salesItemPayload({ quantity: 1, price: '1000.00', gstRate: 'NONE' })],
      ...overrides,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
};

const charge = (amount: string, type = 'SHIPPING') => ({ type, amount });

// ===========================================================================
//  A — payment method
// ===========================================================================

describe('a payment says how it arrived, and only when there is one', () => {
  it('creates an order with nothing paid and no method at all', async () => {
    const order = await createOrder({ paidAmount: '0' });
    expect(order.money.paymentMethod).toBeNull();
  });

  it('refuses a paid amount at creation with no method', async () => {
    const res = await api('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customerId, {
        items: [salesItemPayload({ quantity: 1, price: '1000.00', gstRate: 'NONE' })],
        paidAmount: '500.00',
      }),
    });

    expect(res.status).toBe(422);
  });

  it('persists the method given at creation', async () => {
    const order = await createOrder({ paidAmount: '400.00', paymentMethod: 'PARTIAL_COD' });

    expect(order.money.paymentMethod).toBe('PARTIAL_COD');
    expect(order.money.paid).toBe('400.00');
    // The arithmetic is untouched by any of this.
    expect(order.money.pending).toBe('600.00');
  });

  it('survives a reload', async () => {
    const created = await createOrder({ paidAmount: '1000.00', paymentMethod: 'PREPAID' });
    const res = await api<OrderBody>('GET', `/api/sales/${created.id}`, { token });

    expect(res.body.data!.order.money.paymentMethod).toBe('PREPAID');
    expect(res.body.data!.order.money.fullyPaid).toBe(true);
  });

  it('leaves an existing arrangement unchanged when a payment states none', async () => {
    /*
      Optional on the wire on purpose. The form always sends one, but requiring
      it here would have changed more than it fixed: validation runs before
      authorization, so a caller with no right to the order would start getting
      422 where they used to get 403 — which leaks that the order exists. Every
      payment recorded before this field existed would fail on replay too.
    */
    const order = await createOrder({ paidAmount: '100.00', paymentMethod: 'COD' });

    const res = await api<OrderBody>('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '100.00' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data!.order.money.paid).toBe('200.00');
    // Silence changed nothing about how the money is being collected.
    expect(res.body.data!.order.money.paymentMethod).toBe('COD');
  });

  it('records the method with the payment', async () => {
    const order = await createOrder();
    const res = await api<OrderBody>('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '250.00', method: 'COD' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data!.order.money.paymentMethod).toBe('COD');
    expect(res.body.data!.order.money.paid).toBe('250.00');
    expect(res.body.data!.order.money.pending).toBe('750.00');
  });

  it('rejects a method outside the list', async () => {
    const order = await createOrder();
    const res = await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '10.00', method: 'BANK_TRANSFER' },
    });

    expect(res.status).toBe(422);
  });

  it('leaves the payment ceiling exactly where it was', async () => {
    // A method changes nothing about how much may be paid.
    const order = await createOrder();
    const res = await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '1000.01', method: 'PREPAID' },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');
  });
});

// ===========================================================================
//  B — the first charges apply; changing them needs approval
// ===========================================================================

describe('entering charges is ordinary work, changing them is not', () => {
  it('applies the first set straight away, with no approval', async () => {
    const order = await createOrder();

    const res = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('150.00')] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body.data!.order;
    expect(after.charges).toHaveLength(1);
    expect(after.money.chargesTotal).toBe('150.00');
    expect(after.money.total).toBe('1150.00');
    expect(after.chargeChangeRequests).toHaveLength(0);
  });

  it('does not require approval for charges entered with the order itself', async () => {
    const order = await createOrder({ charges: [charge('75.00')] });

    expect(order.charges).toHaveLength(1);
    expect(order.chargeChangeRequests).toHaveLength(0);
    expect(order.money.total).toBe('1075.00');
  });

  it('turns a change to an existing set into a request, moving no money', async () => {
    const order = await createOrder({ charges: [charge('150.00')] });

    const res = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('900.00')] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body.data!.order;

    // The proposal exists...
    expect(after.chargeChangeRequests).toHaveLength(1);
    expect(after.chargeChangeRequests[0]!.status).toBe('PENDING');
    expect(after.chargeChangeRequests[0]!.proposedTotal).toBe('900.00');
    expect(after.chargeChangeRequests[0]!.currentTotal).toBe('150.00');

    // ...and nothing about the order's money has moved.
    expect(after.charges[0]!.amount).toBe('150.00');
    expect(after.money.chargesTotal).toBe('150.00');
    expect(after.money.total).toBe('1150.00');
  });

  it('keeps the payment ceiling on the effective charges while a request is pending', async () => {
    const order = await createOrder({ charges: [charge('150.00')] });
    await api('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('900.00')] },
    });

    // The ceiling is still 1150, not the proposed 1900.
    const tooMuch = await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '1150.01', method: 'PREPAID' },
    });
    expect(tooMuch.status).toBe(409);

    const exact = await api<OrderBody>('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '1150.00', method: 'PREPAID' },
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body.data!.order.money.fullyPaid).toBe(true);
  });

  it('refuses a second proposal while one is still pending', async () => {
    const order = await createOrder({ charges: [charge('150.00')] });
    await api('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('200.00')] },
    });

    const second = await api('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('300.00')] },
    });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CHARGE_CHANGE_ALREADY_PENDING');
  });
});

// ===========================================================================
//  C — who may decide, and what a decision does
// ===========================================================================

describe('only a reviewer decides, and never their own request', () => {
  const pending = async (): Promise<{ orderId: string; requestId: string }> => {
    const order = await createOrder({ charges: [charge('150.00')] });
    const res = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [charge('400.00')] },
    });
    return { orderId: order.id, requestId: res.body.data!.order.chargeChangeRequests[0]!.id };
  };

  it('refuses a non-admin trying to approve directly', async () => {
    const { orderId, requestId } = await pending();

    const res = await api('POST', `/api/sales/${orderId}/charge-requests/${requestId}/approve`, {
      token: staffToken,
      body: {},
    });

    expect(res.status).toBe(403);
  });

  it('leaves a non-admin no way to apply a charge edit directly either', async () => {
    /*
      On an order the user owns, so the existing ownership rule is not what
      stops them — a USER may only edit orders they created, and borrowing
      somebody else's order here would prove that rule instead of this one.

      The point being made: even on their own order, and even holding SALES
      EDIT, the route they can reach files a request rather than applying it.
    */
    const own = await api<OrderBody>('POST', '/api/sales', {
      token: staffToken,
      body: salesOrderPayload(customerId, {
        items: [salesItemPayload({ quantity: 1, price: '1000.00', gstRate: 'NONE' })],
        charges: [charge('150.00')],
      }),
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const orderId = own.body.data!.order.id;
    trackSalesOrder(orderId);

    const res = await api<OrderBody>('PUT', `/api/sales/${orderId}/charges`, {
      token: staffToken,
      body: { charges: [charge('999.00')] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.money.chargesTotal).toBe('150.00');
    expect(res.body.data!.order.chargeChangeRequests[0]!.status).toBe('PENDING');
  });

  it('refuses the requester deciding their own request', async () => {
    const { orderId, requestId } = await pending();

    const res = await api('POST', `/api/sales/${orderId}/charge-requests/${requestId}/approve`, {
      token,
      body: {},
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_REVIEW_NOT_ALLOWED');
  });

  it('applies the change on approval and recalculates the payable', async () => {
    const { orderId, requestId } = await pending();

    const res = await api<OrderBody>(
      'POST',
      `/api/sales/${orderId}/charge-requests/${requestId}/approve`,
      { token: otherToken, body: { note: 'Agreed with the customer.' } },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body.data!.order;

    expect(after.charges).toHaveLength(1);
    expect(after.charges[0]!.amount).toBe('400.00');
    expect(after.money.chargesTotal).toBe('400.00');
    // 1000 goods + 400 charges. The derived total moved with the charge.
    expect(after.money.total).toBe('1400.00');
    expect(after.chargeChangeRequests[0]!.status).toBe('APPROVED');
    expect(after.chargeChangeRequests[0]!.reviewNote).toBe('Agreed with the customer.');
  });

  it('leaves the original values standing on rejection', async () => {
    const { orderId, requestId } = await pending();

    const res = await api<OrderBody>(
      'POST',
      `/api/sales/${orderId}/charge-requests/${requestId}/reject`,
      { token: otherToken, body: { note: 'Not agreed.' } },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body.data!.order;

    expect(after.charges[0]!.amount).toBe('150.00');
    expect(after.money.chargesTotal).toBe('150.00');
    expect(after.money.total).toBe('1150.00');
    expect(after.chargeChangeRequests[0]!.status).toBe('REJECTED');
  });

  it('refuses to decide the same request twice', async () => {
    const { orderId, requestId } = await pending();
    await api('POST', `/api/sales/${orderId}/charge-requests/${requestId}/reject`, {
      token: otherToken,
      body: {},
    });

    const again = await api('POST', `/api/sales/${orderId}/charge-requests/${requestId}/approve`, {
      token: otherToken,
      body: {},
    });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CHARGE_CHANGE_NOT_PENDING');
  });

  it('lets a new request be filed once the last one is decided', async () => {
    const { orderId, requestId } = await pending();
    await api('POST', `/api/sales/${orderId}/charge-requests/${requestId}/reject`, {
      token: otherToken,
      body: {},
    });

    const res = await api<OrderBody>('PUT', `/api/sales/${orderId}/charges`, {
      token,
      body: { charges: [charge('250.00')] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.data!.order.chargeChangeRequests.filter((r) => r.status === 'PENDING'),
    ).toHaveLength(1);
  });

  it('refuses an approval that would take the order below what is paid', async () => {
    // The guard a direct edit passes, re-run at approval because the order can
    // move while a request sits pending.
    const order = await createOrder({ charges: [charge('500.00')] });
    await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '1500.00', method: 'PREPAID' },
    });

    const filed = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [{ type: 'DISCOUNT', amount: '400.00' }] },
    });
    const requestId = filed.body.data!.order.chargeChangeRequests[0]!.id;

    const res = await api('POST', `/api/sales/${order.id}/charge-requests/${requestId}/approve`, {
      token: otherToken,
      body: {},
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');

    // And the order is untouched by the refusal.
    const after = await api<OrderBody>('GET', `/api/sales/${order.id}`, { token });
    expect(after.body.data!.order.money.total).toBe('1500.00');
    expect(after.body.data!.order.money.paid).toBe('1500.00');
  });
});
