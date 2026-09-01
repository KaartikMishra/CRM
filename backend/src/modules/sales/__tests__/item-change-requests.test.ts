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
  addRequestPayload,
  cleanup,
  editRequestPayload,
  makeCustomer,
  makeUser,
  removeRequestPayload,
  residualTestRows,
  salesItemPayload,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { order: SalesOrderDetail };

let admin: TestUser;
let owner: TestUser;
let stranger: TestUser;
let adminToken: string;
let ownerToken: string;
let strangerToken: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  owner = await makeUser('USER');
  stranger = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  ownerToken = await mintToken(owner.id, { role: 'USER' });
  strangerToken = await mintToken(stranger.id, { role: 'USER' });
  customerId = (await makeCustomer('BULK')).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/** A two-line order owned by `owner`: 10 x 100.00 and 2 x 250.00 = 1500.00. */
async function newOrder(overrides: Record<string, unknown> = {}): Promise<SalesOrderDetail> {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token: ownerToken,
    body: salesOrderPayload(customerId, {
      items: [
        salesItemPayload({ quantity: 10, price: '100.00' }),
        salesItemPayload({ quantity: 2, price: '250.00' }),
      ],
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  trackSalesOrder(res.body.data!.order.id);
  return res.body.data!.order;
}

const request = (orderId: string, token: string, body: Record<string, unknown>) =>
  api<Wrapped>('POST', `/api/sales/${orderId}/change-requests`, { token, body });

const approve = (orderId: string, reqId: string, token: string, note?: string) =>
  api<Wrapped>('POST', `/api/sales/${orderId}/change-requests/${reqId}/approve`, {
    token,
    body: note ? { note } : {},
  });

const reject = (orderId: string, reqId: string, token: string, note?: string) =>
  api<Wrapped>('POST', `/api/sales/${orderId}/change-requests/${reqId}/reject`, {
    token,
    body: note ? { note } : {},
  });

const pending = (order: SalesOrderDetail) =>
  order.changeRequests.find((r) => r.status === 'PENDING')!;

const reload = async (id: string) =>
  (await api<Wrapped>('GET', `/api/sales/${id}`, { token: ownerToken })).body.data!.order;

// ---------------------------------------------------------------------------
//  ADD
// ---------------------------------------------------------------------------

describe('ADD request', () => {
  it('creates no product and leaves the total alone', async () => {
    const order = await newOrder();

    const res = await request(order.id, ownerToken, addRequestPayload());
    expect(res.status).toBe(201);

    const after = res.body.data!.order;
    expect(after.items).toHaveLength(2); // no new line
    expect(after.money.total).toBe('1500.00');
    expect(after.money.pending).toBe('1500.00');

    const req = pending(after);
    expect(req.type).toBe('ADD');
    expect(req.current).toBeNull();
    expect(req.proposed!.lineTotal).toBe('100.00');
    expect(req.requestedBy.id).toBe(owner.id);
  });

  it('creates the product on approval and moves the total', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    const res = await approve(order.id, req.id, adminToken);
    expect(res.status).toBe(200);

    const after = res.body.data!.order;
    expect(after.items).toHaveLength(3);
    expect(after.money.total).toBe('1600.00');
    expect(after.changeRequests.find((r) => r.id === req.id)!.status).toBe('APPROVED');
    // Line numbering continues rather than colliding.
    expect(after.items.map((i) => i.lineNo)).toEqual([1, 2, 3]);
  });

  it('creates nothing on rejection, and the record survives', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    const res = await reject(order.id, req.id, adminToken, 'Not this quarter');
    expect(res.status).toBe(200);

    const after = res.body.data!.order;
    expect(after.items).toHaveLength(2);
    expect(after.money.total).toBe('1500.00');

    const decided = after.changeRequests.find((r) => r.id === req.id)!;
    expect(decided.status).toBe('REJECTED');
    expect(decided.reviewedBy!.id).toBe(admin.id);
    expect(decided.reviewedAt).not.toBeNull();
    expect(decided.reviewNote).toBe('Not this quarter');
  });
});

// ---------------------------------------------------------------------------
//  EDIT
// ---------------------------------------------------------------------------

describe('EDIT request', () => {
  it('leaves the live product and the total completely untouched', async () => {
    const order = await newOrder();
    const target = order.items[0]!; // 10 x 100.00

    const res = await request(order.id, ownerToken, editRequestPayload(target.id, { quantity: 3, price: '100.00' }));
    expect(res.status).toBe(201);

    const after = res.body.data!.order;
    const live = after.items.find((i) => i.id === target.id)!;
    expect(live.quantity).toBe(10); // unchanged
    expect(live.price).toBe('100.00'); // unchanged
    expect(live.lineTotal).toBe('1000.00'); // unchanged
    expect(after.money.total).toBe('1500.00'); // unchanged

    // Both sides are carried, so the UI can render CURRENT -> PROPOSED.
    const req = pending(after);
    expect(req.current!.quantity).toBe(10);
    expect(req.proposed!.quantity).toBe(3);
  });

  it('applies to the real product on approval and recalculates', async () => {
    const order = await newOrder();
    const target = order.items[0]!;
    const req = pending(
      (await request(order.id, ownerToken, editRequestPayload(target.id, { quantity: 20, price: '100.00' })))
        .body.data!.order,
    );

    const res = await approve(order.id, req.id, adminToken);
    expect(res.status).toBe(200);

    const live = res.body.data!.order.items.find((i) => i.id === target.id)!;
    expect(live.quantity).toBe(20);
    expect(live.lineTotal).toBe('2000.00');
    expect(res.body.data!.order.money.total).toBe('2500.00');
  });

  it('leaves the product exactly as it was on rejection', async () => {
    const order = await newOrder();
    const target = order.items[0]!;
    const req = pending(
      (await request(order.id, ownerToken, editRequestPayload(target.id, { quantity: 99, price: '100.00' })))
        .body.data!.order,
    );

    await reject(order.id, req.id, adminToken);

    const after = await reload(order.id);
    const live = after.items.find((i) => i.id === target.id)!;
    expect(live.quantity).toBe(10);
    expect(after.money.total).toBe('1500.00');
    expect(after.changeRequests.find((r) => r.id === req.id)!.status).toBe('REJECTED');
  });
});

// ---------------------------------------------------------------------------
//  REMOVE
// ---------------------------------------------------------------------------

describe('REMOVE request', () => {
  it('keeps the product and the total while pending', async () => {
    const order = await newOrder();
    const target = order.items[1]!; // 2 x 250.00

    const res = await request(order.id, ownerToken, removeRequestPayload(target.id));
    expect(res.status).toBe(201);

    const after = res.body.data!.order;
    expect(after.items).toHaveLength(2);
    expect(after.items.some((i) => i.id === target.id)).toBe(true);
    expect(after.money.total).toBe('1500.00');

    const req = pending(after);
    expect(req.type).toBe('REMOVE');
    expect(req.current!.id).toBe(target.id);
    expect(req.proposed).toBeNull();
  });

  it('removes the product on approval and recalculates', async () => {
    const order = await newOrder();
    const target = order.items[1]!;
    const req = pending((await request(order.id, ownerToken, removeRequestPayload(target.id))).body.data!.order);

    const res = await approve(order.id, req.id, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data!.order.items).toHaveLength(1);
    expect(res.body.data!.order.money.total).toBe('1000.00');
  });

  it('keeps the product on rejection', async () => {
    const order = await newOrder();
    const target = order.items[1]!;
    const req = pending((await request(order.id, ownerToken, removeRequestPayload(target.id))).body.data!.order);

    await reject(order.id, req.id, adminToken);

    const after = await reload(order.id);
    expect(after.items.some((i) => i.id === target.id)).toBe(true);
    expect(after.money.total).toBe('1500.00');
  });

  it('will not empty an order', async () => {
    const single = await newOrder({ items: [salesItemPayload({ quantity: 1, price: '10.00' })] });
    const req = pending(
      (await request(single.id, ownerToken, removeRequestPayload(single.items[0]!.id))).body.data!.order,
    );

    const res = await approve(single.id, req.id, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ACTIVE_ITEM');
  });
});

// ---------------------------------------------------------------------------
//  Money safety
// ---------------------------------------------------------------------------

describe('approval cannot leave an order worth less than is paid', () => {
  it('refuses an EDIT that would drop the total below what is paid', async () => {
    const order = await newOrder(); // 1500.00
    await api('POST', `/api/sales/${order.id}/payments`, {
      token: ownerToken,
      body: { amount: '1400.00' },
    });

    // 1 x 100.00 + 500.00 = 600.00, well below the 1400.00 paid.
    const req = pending(
      (await request(order.id, ownerToken, editRequestPayload(order.items[0]!.id, { quantity: 1, price: '100.00' })))
        .body.data!.order,
    );

    const res = await approve(order.id, req.id, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOTAL_BELOW_PAID');

    // And nothing was applied.
    const after = await reload(order.id);
    expect(after.items.find((i) => i.id === order.items[0]!.id)!.quantity).toBe(10);
    expect(after.money.total).toBe('1500.00');
  });

  it('refuses a REMOVE that would drop the total below what is paid', async () => {
    const order = await newOrder();
    await api('POST', `/api/sales/${order.id}/payments`, {
      token: ownerToken,
      body: { amount: '1400.00' },
    });

    const req = pending(
      (await request(order.id, ownerToken, removeRequestPayload(order.items[0]!.id))).body.data!.order,
    );

    const res = await approve(order.id, req.id, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOTAL_BELOW_PAID');
    expect((await reload(order.id)).items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
//  Authorization
// ---------------------------------------------------------------------------

describe('who may request', () => {
  it('lets any SALES EDIT holder raise one on an order they did not create', async () => {
    // Deliberately not gated on ownership: filing a request changes nothing and
    // cannot be self-approved, so a colleague can flag a wrong line on someone
    // else's order. Approving it is still SALES ASSIGN.
    const order = await newOrder(); // created by `owner`

    const res = await request(order.id, strangerToken, addRequestPayload());
    expect(res.status).toBe(201);

    const after = res.body.data!.order;
    expect(pending(after).requestedBy.id).toBe(stranger.id);
    // And it still moved nothing.
    expect(after.items).toHaveLength(2);
    expect(after.money.total).toBe('1500.00');
  });

  it('still refuses a non-owner every order-level mutation', async () => {
    // The widening is scoped to change requests. Dates, payment and dispatch
    // keep their ownership rule untouched.
    const order = await newOrder();

    expect(
      (await api('PATCH', `/api/sales/${order.id}`, {
        token: strangerToken,
        body: { toBeDispatchedBy: new Date(Date.now() + 30 * 864e5).toISOString() },
      })).status,
      'dates',
    ).toBe(403);

    expect(
      (await api('POST', `/api/sales/${order.id}/payments`, {
        token: strangerToken,
        body: { amount: '10.00' },
      })).status,
      'payment',
    ).toBe(403);

    expect(
      (await api('POST', `/api/sales/${order.id}/dispatch`, { token: strangerToken })).status,
      'dispatch',
    ).toBe(403);
  });

  it('refuses someone whose SALES EDIT has been revoked', async () => {
    const order = await newOrder();
    await prisma.userModulePermission.create({
      data: { userId: owner.id, module: 'SALES', action: 'EDIT', allowed: false },
    });

    const res = await request(order.id, ownerToken, addRequestPayload());
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: owner.id } });
  });

  it('refuses any request on a closed order', async () => {
    const order = await newOrder();
    await api('POST', `/api/sales/${order.id}/payments`, {
      token: ownerToken,
      body: { amount: '1500.00' },
    });
    await api('POST', `/api/sales/${order.id}/dispatch`, { token: ownerToken });
    await api('POST', `/api/sales/${order.id}/close`, { token: ownerToken });

    const res = await request(order.id, ownerToken, addRequestPayload());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_CLOSED');
  });
});

describe('who may decide', () => {
  it('refuses a reviewer without SALES ASSIGN', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    const res = await approve(order.id, req.id, strangerToken);
    expect(res.status).toBe(403);
    expect((await reload(order.id)).items).toHaveLength(2);
  });

  it('refuses the requester reviewing their own request, even holding SALES ASSIGN', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    // Grant the requester the reviewing capability outright.
    await prisma.userModulePermission.create({
      data: { userId: owner.id, module: 'SALES', action: 'ASSIGN', allowed: true },
    });

    const selfApprove = await approve(order.id, req.id, ownerToken);
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('SELF_REVIEW_NOT_ALLOWED');

    const selfReject = await reject(order.id, req.id, ownerToken);
    expect(selfReject.status).toBe(403);
    expect(selfReject.body.code).toBe('SELF_REVIEW_NOT_ALLOWED');

    // Still pending, still not applied.
    const after = await reload(order.id);
    expect(after.items).toHaveLength(2);
    expect(after.changeRequests.find((r) => r.id === req.id)!.status).toBe('PENDING');

    await prisma.userModulePermission.deleteMany({ where: { userId: owner.id } });
  });

  it('lets an admin who did not request it decide', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    expect((await approve(order.id, req.id, adminToken)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  No bypass, no duplicates, no double-apply
// ---------------------------------------------------------------------------

describe('the approval workflow cannot be bypassed', () => {
  it('has no direct item mutation route at all', async () => {
    const order = await newOrder();
    const itemId = order.items[0]!.id;

    for (const method of ['PATCH', 'DELETE']) {
      const res = await api(method, `/api/sales/${order.id}/items/${itemId}`, {
        token: ownerToken,
        ...(method === 'PATCH' ? { body: { quantity: 99 } } : {}),
      });
      expect(res.status, `${method} should not exist`).toBe(404);
    }

    // The product is exactly as created.
    const after = await reload(order.id);
    expect(after.items.find((i) => i.id === itemId)!.quantity).toBe(10);
    expect(after.money.total).toBe('1500.00');
  });

  it('refuses a second pending request against the same product', async () => {
    const order = await newOrder();
    const target = order.items[0]!;

    expect((await request(order.id, ownerToken, editRequestPayload(target.id))).status).toBe(201);

    const second = await request(order.id, ownerToken, removeRequestPayload(target.id));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CHANGE_REQUEST_ALREADY_PENDING');
  });

  it('allows a fresh request once the previous one is decided', async () => {
    const order = await newOrder();
    const target = order.items[0]!;
    const first = pending((await request(order.id, ownerToken, editRequestPayload(target.id))).body.data!.order);
    await reject(order.id, first.id, adminToken);

    expect((await request(order.id, ownerToken, editRequestPayload(target.id))).status).toBe(201);
  });

  it('cannot apply the same request twice', async () => {
    const order = await newOrder();
    const req = pending((await request(order.id, ownerToken, addRequestPayload())).body.data!.order);

    expect((await approve(order.id, req.id, adminToken)).status).toBe(200);

    const again = await approve(order.id, req.id, adminToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CHANGE_REQUEST_NOT_PENDING');

    // One product added, not two.
    expect((await reload(order.id)).items).toHaveLength(3);
  });

  it('will not reach a request belonging to another order', async () => {
    const [a, b] = [await newOrder(), await newOrder()];
    const req = pending((await request(b.id, ownerToken, addRequestPayload())).body.data!.order);

    const res = await approve(a.id, req.id, adminToken);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CHANGE_REQUEST_NOT_FOUND');
  });

  it('refuses an EDIT naming a line from a different order', async () => {
    const [a, b] = [await newOrder(), await newOrder()];

    const res = await request(a.id, ownerToken, editRequestPayload(b.items[0]!.id));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ITEM_NOT_FOUND');
  });
});
