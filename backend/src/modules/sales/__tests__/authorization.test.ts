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
  cleanup,
  makeCustomer,
  makeUser,
  residualTestRows,
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
  customerId = (await makeCustomer('CORPORATE_GIFTING')).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function orderOwnedByOwner(): Promise<SalesOrderDetail> {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token: ownerToken,
    body: salesOrderPayload(customerId),
  });
  expect(res.status).toBe(201);
  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
}

describe('authentication', () => {
  it('refuses every sales route without a token', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/sales'],
      ['POST', '/api/sales'],
      ['GET', '/api/sales/clx0000000000000000000000'],
      ['PATCH', '/api/sales/clx0000000000000000000000'],
      ['POST', '/api/sales/clx0000000000000000000000/payments'],
      ['POST', '/api/sales/clx0000000000000000000000/dispatch'],
      ['POST', '/api/sales/clx0000000000000000000000/close'],
    ];

    for (const [method, path] of routes) {
      const res = await api(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = await mintToken(owner.id, { secret: 'not-the-real-secret-at-all' });
    const res = await api('GET', '/api/sales', { token: forged });
    expect(res.status).toBe(401);
  });
});

describe('ownership', () => {
  it('lets any signed-in employee read any order', async () => {
    const order = await orderOwnedByOwner();

    const res = await api<Wrapped>('GET', `/api/sales/${order.id}`, { token: strangerToken });
    expect(res.status).toBe(200);
  });

  it('refuses an edit by someone who did not create the order', async () => {
    const order = await orderOwnedByOwner();

    const res = await api('PATCH', `/api/sales/${order.id}`, {
      token: strangerToken,
      body: { productName: 'not yours' },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SALES_ACCESS');
  });

  it('refuses a payment and a dispatch by a non-owner', async () => {
    const order = await orderOwnedByOwner();

    expect(
      (await api('POST', `/api/sales/${order.id}/payments`, {
        token: strangerToken,
        body: { amount: '10.00' },
      })).status,
    ).toBe(403);

    expect(
      (await api('POST', `/api/sales/${order.id}/dispatch`, { token: strangerToken })).status,
    ).toBe(403);
  });

  it('lets an admin act on an order they did not create', async () => {
    const order = await orderOwnedByOwner();

    // The header edit an admin can make on someone else's order: the line
    // itself has its own endpoint, so this exercises the ownership rule.
    const moved = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    const res = await api<Wrapped>('PATCH', `/api/sales/${order.id}`, {
      token: adminToken,
      body: { toBeDispatchedBy: moved.toISOString() },
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.order.toBeDispatchedBy.slice(0, 10)).toBe(
      moved.toISOString().slice(0, 10),
    );
  });
});

describe('permission resolution', () => {
  it('gives a plain USER view, create and edit by default', async () => {
    const res = await api('GET', '/api/sales', { token: ownerToken });
    expect(res.status).toBe(200);

    const created = await api<Wrapped>('POST', '/api/sales', {
      token: ownerToken,
      body: salesOrderPayload(customerId),
    });
    expect(created.status).toBe(201);
    trackSalesOrder(created.body.data!.order.id);
  });

  it('honours a per-user override that revokes VIEW', async () => {
    await prisma.userModulePermission.create({
      data: { userId: stranger.id, module: 'SALES', action: 'VIEW', allowed: false },
    });

    const res = await api('GET', '/api/sales', { token: strangerToken });
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({
      where: { userId: stranger.id, module: 'SALES', action: 'VIEW' },
    });

    const restored = await api('GET', '/api/sales', { token: strangerToken });
    expect(restored.status).toBe(200);
  });

  it('honours a per-user override that revokes CREATE', async () => {
    await prisma.userModulePermission.create({
      data: { userId: stranger.id, module: 'SALES', action: 'CREATE', allowed: false },
    });

    const res = await api('POST', '/api/sales', {
      token: strangerToken,
      body: salesOrderPayload(customerId),
    });
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({
      where: { userId: stranger.id, module: 'SALES', action: 'CREATE' },
    });
  });
});

describe('shared upload endpoint', () => {
  it('still admits a user who only holds SALES CREATE', async () => {
    // Revoke the Product Enquiry capability the upload route used to require on
    // its own; SALES CREATE alone must now be enough.
    await prisma.userModulePermission.create({
      data: { userId: owner.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: false },
    });

    // No file attached, so the guard is what decides: NO_FILE means the request
    // got past authorization, whereas 403 would mean it did not.
    const res = await api('POST', '/api/uploads', { token: ownerToken });
    expect(res.status).not.toBe(403);
    expect(res.body.code).toBe('NO_FILE');

    await prisma.userModulePermission.deleteMany({
      where: { userId: owner.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE' },
    });
  });

  it('refuses someone holding neither create capability', async () => {
    await prisma.userModulePermission.createMany({
      data: [
        { userId: stranger.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: false },
        { userId: stranger.id, module: 'SALES', action: 'CREATE', allowed: false },
      ],
    });

    const res = await api('POST', '/api/uploads', { token: strangerToken });
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: stranger.id } });
  });
});

describe('input safety', () => {
  it('rejects a malformed id before touching the database', async () => {
    const res = await api('GET', '/api/sales/not-a-cuid', { token: ownerToken });
    expect(res.status).toBe(422);
  });

  it('gives the same answer for an absent order as for an inaccessible one', async () => {
    const res = await api('GET', '/api/sales/clx0000000000000000000000', { token: ownerToken });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ORDER_NOT_FOUND');
  });

  it('refuses an order pointing at a customer that does not exist', async () => {
    const res = await api('POST', '/api/sales', {
      token: ownerToken,
      body: salesOrderPayload('clx0000000000000000000000'),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });
});
