/**
 * The two delay-reason chains, and the wall between them.
 *
 *   PURCHASE      per LINE.  submit PROCUREMENT EDIT  ->  decide PROCUREMENT ASSIGN
 *   PROCUREMENT   per ORDER. submit PROCUREMENT ASSIGN ->  decide ADMIN
 *
 * What this suite is really guarding:
 *
 *   1. THE CHAINS DO NOT CROSS. A purchase person's reason is never routed to an
 *      administrator, and procurement's own account of a late order is never
 *      decided by the capability that caused it.
 *
 *   2. AN APPROVAL IS NOT A PARDON. Deciding a reason records that an explanation
 *      was accepted. It cannot move `completedAt`, cannot move the deadline, and
 *      cannot turn DELAYED into ON_TIME. A business that could clear a late
 *      delivery by approving a note about it would have no delivery record at all.
 *
 *   3. UNFULFILLED_WITH_DELAY HAS NO ORDER-LEVEL WORKFLOW. An order still owed
 *      goods is explained line by line. The order-level chain opens only once the
 *      order has actually been covered late.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcurementClockDetail } from '@rs/shared';
import { prisma } from '../../../config/database.js';
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
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

const DAY = 86_400_000;

let admin: TestUser;
let admin2: TestUser;
/** The purchase person: EDIT but deliberately not ASSIGN. */
let purchaser: TestUser;
/** The procurement person: ASSIGN, but not an administrator. */
let procurer: TestUser;

let adminToken: string;
let admin2Token: string;
let purchaserToken: string;
let procurerToken: string;
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  admin2 = await makeUser('ADMIN');
  purchaser = await makeUser('USER');
  procurer = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  admin2Token = await mintToken(admin2.id, { role: 'ADMIN' });
  purchaserToken = await mintToken(purchaser.id, { role: 'USER' });
  procurerToken = await mintToken(procurer.id, { role: 'USER' });
  customer = await makeCustomer('BULK');

  /*
    USER holds nothing on PROCUREMENT by default, so both people are granted
    exactly what their role in the workflow needs and nothing more. That is the
    whole point of the matrix: the purchase person can report a delay and cannot
    approve one, and the procurement person can approve one and is still not an
    administrator.
  */
  await prisma.userModulePermission.createMany({
    data: [
      ...(['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: purchaser.id,
        module: 'PROCUREMENT' as const,
        action,
        allowed: true,
      })),
      ...(['VIEW', 'CREATE', 'EDIT', 'ASSIGN'] as const).map((action) => ({
        userId: procurer.id,
        module: 'PROCUREMENT' as const,
        action,
        allowed: true,
      })),
    ],
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type OrderBody = { order: { id: string; items: { id: string }[] } };

async function makeOrder(daysAgo = 0, quantity = 2): Promise<{ id: string; items: { id: string }[] }> {
  const orderDate = new Date(Date.now() - daysAgo * DAY);
  const res = await api<OrderBody>('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test delay line', quantity, price: '100.00', gstMode: 'EXCLUSIVE' }],
      paidAmount: '0',
      orderDate: orderDate.toISOString(),
      toBeDispatchedBy: new Date(orderDate.getTime() + 30 * DAY).toISOString(),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  trackSalesOrder(res.body.data!.order.id);
  return res.body.data!.order;
}

const REASON = 'zz-test the vendor could not deliver before the festival week';

const submitPurchase = (itemId: string, token: string, reason = REASON) =>
  api<{ order: ProcurementClockDetail }>(
    'POST',
    `/api/procurement/clock/items/${itemId}/delay-reason`,
    { token, body: { reason } },
  );

const decidePurchase = (id: string, decision: 'approve' | 'reject', token: string, note?: string) =>
  api<{ order: ProcurementClockDetail }>(
    'POST',
    `/api/procurement/clock/purchase-delays/${id}/${decision}`,
    { token, body: note ? { note } : {} },
  );

const submitProcurement = (orderId: string, token: string, reason = REASON) =>
  api<{ order: ProcurementClockDetail }>(
    'POST',
    `/api/procurement/clock/${orderId}/delay-reason`,
    { token, body: { reason } },
  );

const decideProcurement = (
  id: string,
  decision: 'approve' | 'reject',
  token: string,
  note?: string,
) =>
  api<{ order: ProcurementClockDetail }>(
    'POST',
    `/api/procurement/clock/procurement-delays/${id}/${decision}`,
    { token, body: note ? { note } : {} },
  );

const clock = async (orderId: string, token = adminToken): Promise<ProcurementClockDetail> => {
  const res = await api<{ order: ProcurementClockDetail }>(
    'GET',
    `/api/procurement/clock/${orderId}`,
    { token },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data!.order;
};

/** Covers a whole line by hand, which is what makes an order complete. */
const cover = (itemId: string, qty: number) =>
  api('PATCH', `/api/procurement/order-lines/${itemId}/fulfillment`, {
    token: adminToken,
    body: { alreadyFulfilled: qty },
  });

// ===========================================================================
//  A — the purchase chain: EDIT submits, ASSIGN decides
// ===========================================================================

describe('the purchase person explains one line', () => {
  it('records the reason against the line, with who wrote it', async () => {
    const order = await makeOrder();
    const res = await submitPurchase(order.items[0]!.id, purchaserToken);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = res.body.data!.order.items[0]!;
    expect(line.pendingDelayReason).not.toBeNull();
    expect(line.pendingDelayReason!.reason).toBe(REASON);
    expect(line.pendingDelayReason!.status).toBe('PENDING');
    expect(line.pendingDelayReason!.requestedBy.id).toBe(purchaser.id);
    expect(line.pendingDelayReason!.reviewedBy).toBeNull();
  });

  it('can be submitted before the deadline, for a delay already known about', async () => {
    const order = await makeOrder();
    expect((await clock(order.id)).state).toBe('UNFULFILLED');
    expect((await submitPurchase(order.items[0]!.id, purchaserToken)).status).toBe(201);
  });

  it('is refused on a line that is already covered', async () => {
    const order = await makeOrder();
    expect((await cover(order.items[0]!.id, 2)).status).toBe(200);

    const res = await submitPurchase(order.items[0]!.id, purchaserToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOCK_LINE_COVERED');
  });

  it('is refused on a cancelled order', async () => {
    const order = await makeOrder();
    await api('POST', `/api/sales/${order.id}/cancel`, {
      token: adminToken,
      body: { reason: 'zz-test called off' },
    });

    const res = await submitPurchase(order.items[0]!.id, purchaserToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_CANCELLED');
  });

  it('allows only one undecided reason per line', async () => {
    const order = await makeOrder();
    expect((await submitPurchase(order.items[0]!.id, purchaserToken)).status).toBe(201);

    const second = await submitPurchase(order.items[0]!.id, purchaserToken);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PURCHASE_DELAY_ALREADY_PENDING');
  });

  it('demands an actual explanation', async () => {
    const order = await makeOrder();
    const res = await submitPurchase(order.items[0]!.id, purchaserToken, 'late');
    expect(res.status).toBe(422);
  });
});

describe('deciding a purchase delay is PROCUREMENT ASSIGN, and never Admin-routed', () => {
  it('lets the procurement person approve it', async () => {
    const order = await makeOrder();
    const submitted = await submitPurchase(order.items[0]!.id, purchaserToken);
    const id = submitted.body.data!.order.items[0]!.pendingDelayReason!.id;

    const res = await decidePurchase(id, 'approve', procurerToken, 'zz-test accepted');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const line = res.body.data!.order.items[0]!;
    expect(line.pendingDelayReason).toBeNull();
    expect(line.delayReasons[0]!.status).toBe('APPROVED');
    expect(line.delayReasons[0]!.reviewedBy!.id).toBe(procurer.id);
    expect(line.delayReasons[0]!.reviewNote).toBe('zz-test accepted');
  });

  it('refuses the purchase person who only holds EDIT', async () => {
    const order = await makeOrder();
    const submitted = await submitPurchase(order.items[0]!.id, purchaserToken);
    const id = submitted.body.data!.order.items[0]!.pendingDelayReason!.id;

    // Somebody else submitted it, so this is a permission refusal and not the
    // self-review rule.
    const res = await decidePurchase(id, 'approve', purchaserToken);
    expect(res.status).toBe(403);
  });

  it('refuses the person who submitted it, even holding ASSIGN', async () => {
    const order = await makeOrder();
    const submitted = await submitPurchase(order.items[0]!.id, procurerToken);
    const id = submitted.body.data!.order.items[0]!.pendingDelayReason!.id;

    const res = await decidePurchase(id, 'approve', procurerToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_REVIEW_NOT_ALLOWED');
  });

  it('decides a reason exactly once', async () => {
    const order = await makeOrder();
    const submitted = await submitPurchase(order.items[0]!.id, purchaserToken);
    const id = submitted.body.data!.order.items[0]!.pendingDelayReason!.id;

    expect((await decidePurchase(id, 'approve', procurerToken)).status).toBe(200);

    const again = await decidePurchase(id, 'reject', procurerToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PURCHASE_DELAY_NOT_PENDING');
  });

  it('keeps a rejected reason as history and frees the line for another', async () => {
    const order = await makeOrder();
    const first = await submitPurchase(order.items[0]!.id, purchaserToken);
    const id = first.body.data!.order.items[0]!.pendingDelayReason!.id;

    expect((await decidePurchase(id, 'reject', procurerToken, 'zz-test not good enough')).status).toBe(200);

    const second = await submitPurchase(order.items[0]!.id, purchaserToken, `${REASON} — second try`);
    expect(second.status).toBe(201);
    expect(second.body.data!.order.items[0]!.delayReasons).toHaveLength(2);
  });

  it('changes no quantity and no clock result', async () => {
    const order = await makeOrder();
    const before = await clock(order.id);

    const submitted = await submitPurchase(order.items[0]!.id, purchaserToken);
    const id = submitted.body.data!.order.items[0]!.pendingDelayReason!.id;
    await decidePurchase(id, 'approve', procurerToken);

    const after = await clock(order.id);
    expect(after.state).toBe(before.state);
    expect(after.completedAt).toBe(before.completedAt);
    expect(after.verdict).toBe(before.verdict);
    expect(after.deadline).toBe(before.deadline);
    expect(after.outstandingQty).toBe(before.outstandingQty);
  });
});

// ===========================================================================
//  B — the procurement chain: ASSIGN submits, ADMIN decides
// ===========================================================================

describe('procurement accounts for an order it covered late', () => {
  /** An order that is genuinely FULFILLED_DELAYED. */
  async function lateCoveredOrder(): Promise<{ id: string; items: { id: string }[] }> {
    const order = await makeOrder(8);
    expect((await cover(order.items[0]!.id, 2)).status).toBe(200);
    expect((await clock(order.id)).verdict).toBe('DELAYED');
    return order;
  }

  it('is required once the verdict is DELAYED, and reported as such', async () => {
    const order = await lateCoveredOrder();
    const view = await clock(order.id);

    expect(view.state).toBe('FULFILLED_DELAYED');
    expect(view.procurementDelayRequired).toBe(true);
    expect(view.procurementDelay).toBeNull();
  });

  it('is refused while the order is merely late and still short', async () => {
    // This is the rule that keeps UNFULFILLED_WITH_DELAY out of this workflow.
    const order = await makeOrder(8);
    expect((await clock(order.id)).state).toBe('UNFULFILLED_WITH_DELAY');

    const res = await submitProcurement(order.id, procurerToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROCUREMENT_DELAY_NOT_APPLICABLE');
  });

  it('is refused on an order that was covered on time', async () => {
    const order = await makeOrder();
    await cover(order.items[0]!.id, 2);
    expect((await clock(order.id)).verdict).toBe('ON_TIME');

    const res = await submitProcurement(order.id, procurerToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROCUREMENT_DELAY_NOT_APPLICABLE');
  });

  it('needs ASSIGN to submit — the purchase person cannot', async () => {
    const order = await lateCoveredOrder();
    expect((await submitProcurement(order.id, purchaserToken)).status).toBe(403);
  });

  it('is decided by an administrator, not by the procurement person', async () => {
    const order = await lateCoveredOrder();
    const submitted = await submitProcurement(order.id, procurerToken);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const id = submitted.body.data!.order.procurementDelay!.id;

    // ASSIGN is the highest capability inside the module and is still not enough.
    expect((await decideProcurement(id, 'approve', procurerToken)).status).toBe(403);

    const res = await decideProcurement(id, 'approve', adminToken, 'zz-test noted');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.procurementDelays[0]!.status).toBe('APPROVED');
    expect(res.body.data!.order.procurementDelays[0]!.reviewedBy!.id).toBe(admin.id);
  });

  it('refuses an administrator deciding their own reason', async () => {
    const order = await lateCoveredOrder();
    // Submitted by an administrator, who also holds ASSIGN by role.
    const submitted = await submitProcurement(order.id, adminToken);
    const id = submitted.body.data!.order.procurementDelay!.id;

    const own = await decideProcurement(id, 'approve', adminToken);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('SELF_REVIEW_NOT_ALLOWED');

    // A different administrator can.
    expect((await decideProcurement(id, 'approve', admin2Token)).status).toBe(200);
  });

  it('allows only one undecided reason per order', async () => {
    const order = await lateCoveredOrder();
    expect((await submitProcurement(order.id, procurerToken)).status).toBe(201);

    const second = await submitProcurement(order.id, procurerToken);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PROCUREMENT_DELAY_ALREADY_PENDING');
  });

  it('decides it exactly once', async () => {
    const order = await lateCoveredOrder();
    const id = (await submitProcurement(order.id, procurerToken)).body.data!.order.procurementDelay!.id;

    expect((await decideProcurement(id, 'approve', adminToken)).status).toBe(200);
    const again = await decideProcurement(id, 'reject', adminToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PROCUREMENT_DELAY_NOT_PENDING');
  });
});

// ===========================================================================
//  C — an approval is not a pardon
// ===========================================================================

describe('approving a reason changes the record, never the result', () => {
  it('leaves the order covered late after the reason is approved', async () => {
    const order = await makeOrder(8);
    await cover(order.items[0]!.id, 2);

    const before = await clock(order.id);
    expect(before.verdict).toBe('DELAYED');

    const id = (await submitProcurement(order.id, procurerToken)).body.data!.order.procurementDelay!.id;
    const decided = await decideProcurement(id, 'approve', adminToken);
    expect(decided.status).toBe(200);

    const after = decided.body.data!.order;
    // The whole point: the explanation was accepted and the order is still late.
    expect(after.verdict).toBe('DELAYED');
    expect(after.state).toBe('FULFILLED_DELAYED');
    expect(after.completedAt).toBe(before.completedAt);
    expect(after.deadline).toBe(before.deadline);
    // And it is no longer outstanding as a thing to do.
    expect(after.procurementDelayRequired).toBe(false);
  });

  it('keeps the reason outstanding when it is rejected', async () => {
    const order = await makeOrder(8);
    await cover(order.items[0]!.id, 2);

    const id = (await submitProcurement(order.id, procurerToken)).body.data!.order.procurementDelay!.id;
    const decided = await decideProcurement(id, 'reject', adminToken, 'zz-test explain properly');
    expect(decided.status).toBe(200);

    const after = decided.body.data!.order;
    expect(after.verdict).toBe('DELAYED');
    // Somebody still has to account for it.
    expect(after.procurementDelayRequired).toBe(true);
    expect(after.procurementDelay).toBeNull();
  });

  it('writes nothing on the clock row itself', async () => {
    const order = await makeOrder(8);
    await cover(order.items[0]!.id, 2);
    const before = await prisma.procurementClock.findUnique({ where: { orderId: order.id } });

    const id = (await submitProcurement(order.id, procurerToken)).body.data!.order.procurementDelay!.id;
    await decideProcurement(id, 'approve', adminToken);

    const after = await prisma.procurementClock.findUnique({ where: { orderId: order.id } });
    expect(after!.completedAt?.toISOString()).toBe(before!.completedAt?.toISOString());
    expect(after!.verdict).toBe(before!.verdict);
    expect(after!.deadline.toISOString()).toBe(before!.deadline.toISOString());
  });
});

// ===========================================================================
//  D — the queues
// ===========================================================================

describe('the two queues stay separate', () => {
  it('lists an undecided purchase reason with enough context to judge it', async () => {
    const order = await makeOrder();
    await submitPurchase(order.items[0]!.id, purchaserToken);

    const res = await api<{ reasons: { id: string; orderId: string; productName: string }[] }>(
      'GET',
      '/api/procurement/clock/queues/purchase-delays',
      { token: procurerToken },
    );
    expect(res.status).toBe(200);
    const row = res.body.data!.reasons.find((r) => r.orderId === order.id);
    expect(row).toBeDefined();
    expect(row!.productName).toBe('zz-test delay line');
  });

  it('never lists a purchase reason in the procurement queue', async () => {
    const order = await makeOrder();
    await submitPurchase(order.items[0]!.id, purchaserToken);

    const res = await api<{ reasons: { orderId: string }[] }>(
      'GET',
      '/api/procurement/clock/queues/procurement-delays',
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    expect(res.body.data!.reasons.some((r) => r.orderId === order.id)).toBe(false);
  });

  it('drops a reason out of its queue once decided', async () => {
    const order = await makeOrder();
    const id = (await submitPurchase(order.items[0]!.id, purchaserToken)).body.data!.order.items[0]!
      .pendingDelayReason!.id;
    await decidePurchase(id, 'approve', procurerToken);

    const res = await api<{ reasons: { id: string }[] }>(
      'GET',
      '/api/procurement/clock/queues/purchase-delays',
      { token: procurerToken },
    );
    expect(res.body.data!.reasons.some((r) => r.id === id)).toBe(false);
  });
});
