/**
 * Notifications end to end: who is told, who is not, and what survives.
 *
 * The targeting cases carry the most weight. A notification addressed to the
 * wrong person is a privacy failure, and one addressed to nobody is a silent
 * one — so both directions are asserted for each event.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  TEST_PREFIX,
  cleanup,
  makeCustomer,
  makeUser,
  residualTestRows,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';
import { usersWithPermission } from '../../../services/permission.service.js';

let admin: TestUser;
let plainUser: TestUser;
let grantedUser: TestUser;
let revokedAdmin: TestUser;
let adminToken: string;
let plainToken: string;
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  plainUser = await makeUser('USER');
  grantedUser = await makeUser('USER');
  revokedAdmin = await makeUser('ADMIN');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  plainToken = await mintToken(plainUser.id, { role: 'USER' });
  customer = await makeCustomer();

  // A USER granted procurement by override — the case a naive query would miss
  // in one direction.
  await prisma.userModulePermission.create({
    data: { userId: grantedUser.id, module: 'PROCUREMENT', action: 'VIEW', allowed: true },
  });
  // An ADMIN revoked by override — the case it would miss in the other.
  await prisma.userModulePermission.create({
    data: { userId: revokedAdmin.id, module: 'PROCUREMENT', action: 'VIEW', allowed: false },
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const notificationsFor = (recipientId: string) =>
  prisma.notification.findMany({ where: { recipientId }, select: { type: true, entityId: true, body: true, href: true } });

describe('recipient resolution follows the existing permission rules', () => {
  it('includes role defaults, honours grants, and honours revocations', async () => {
    const ids = (await usersWithPermission('PROCUREMENT', 'VIEW')).map((u) => u.id);

    // ADMIN holds PROCUREMENT by role default, with no override row at all —
    // the case an override-table-only query would silently drop.
    expect(ids).toContain(admin.id);
    // USER is denied by default...
    expect(ids).not.toContain(plainUser.id);
    // ...unless explicitly granted.
    expect(ids).toContain(grantedUser.id);
    // And an explicit denial beats the role default.
    expect(ids).not.toContain(revokedAdmin.id);
  });

  it('excludes users who can no longer sign in', async () => {
    const inactive = await makeUser('ADMIN', false);
    const ids = (await usersWithPermission('PROCUREMENT', 'VIEW')).map((u) => u.id);
    expect(ids).not.toContain(inactive.id);
  });
});

describe('a new sales order tells procurement', () => {
  it('reaches every holder, and nobody else', async () => {
    const res = await api('POST', '/api/sales', {
      token: adminToken,
      body: salesOrderPayload(customer.id, {
        items: [{ productName: `${TEST_PREFIX} cooker`, quantity: 3, price: '100.00' }],
      }),
    });
    expect(res.status).toBe(201);
    const orderId = (res.body.data as { order: { id: string } }).order.id;
    trackSalesOrder(orderId);

    // Told.
    for (const user of [admin, grantedUser]) {
      const rows = await notificationsFor(user.id);
      const match = rows.find((r) => r.entityId === orderId);
      expect(match, `${user.name} should have been told`).toBeDefined();
      expect(match!.type).toBe('SALES_ORDER_CREATED');
      expect(match!.href).toBe(`/sales/${orderId}`);
    }

    // Not told.
    for (const user of [plainUser, revokedAdmin]) {
      const rows = await notificationsFor(user.id);
      expect(rows.find((r) => r.entityId === orderId), `${user.name} should not have been told`).toBeUndefined();
    }
  });

  it('describes what the order is for', async () => {
    const res = await api('POST', '/api/sales', {
      token: adminToken,
      body: salesOrderPayload(customer.id, {
        items: [
          { productName: `${TEST_PREFIX} kadai`, quantity: 7, price: '100.00' },
          { productName: `${TEST_PREFIX} thali`, quantity: 2, price: '50.00' },
        ],
      }),
    });
    const orderId = (res.body.data as { order: { id: string } }).order.id;
    trackSalesOrder(orderId);

    const rows = await notificationsFor(admin.id);
    const match = rows.find((r) => r.entityId === orderId)!;
    expect(match.body).toContain('kadai');
    expect(match.body).toContain('7');
    expect(match.body).toContain('+1 more');
  });

  it('writes nothing when the order is rejected', async () => {
    const before = await prisma.notification.count();
    // Duplicate order id — refused before anything is written.
    const payload = salesOrderPayload(customer.id, {
      items: [{ productName: `${TEST_PREFIX} dup`, quantity: 1, price: '10.00' }],
    });
    const first = await api('POST', '/api/sales', { token: adminToken, body: payload });
    trackSalesOrder((first.body.data as { order: { id: string } }).order.id);

    const second = await api('POST', '/api/sales', { token: adminToken, body: payload });
    expect(second.status).toBeGreaterThanOrEqual(400);

    // The rejected attempt added nothing beyond the successful one's notices.
    const after = await prisma.notification.count();
    const recipients = (await usersWithPermission('PROCUREMENT', 'VIEW')).length;
    expect(after - before).toBe(recipients);
  });
});

describe('reading and clearing', () => {
  it('returns only the caller’s own notifications', async () => {
    const res = await api('GET', '/api/notifications', { token: plainToken });
    expect(res.status).toBe(200);
    const { notifications } = res.body.data as { notifications: { id: string }[] };
    const ids = notifications.map((n) => n.id);

    // Everything the admin was told about is absent from the plain user's list.
    const adminRows = await prisma.notification.findMany({
      where: { recipientId: admin.id }, select: { id: true },
    });
    for (const row of adminRows) expect(ids).not.toContain(row.id);
  });

  it('refuses to mark somebody else’s notification read', async () => {
    const theirs = await prisma.notification.findFirst({
      where: { recipientId: admin.id }, select: { id: true, readAt: true },
    });
    expect(theirs).not.toBeNull();

    const res = await api('PATCH', `/api/notifications/${theirs!.id}/read`, { token: plainToken });
    expect(res.status).toBe(404);

    // And it really was not touched.
    const after = await prisma.notification.findUnique({
      where: { id: theirs!.id }, select: { readAt: true },
    });
    expect(after!.readAt).toEqual(theirs!.readAt);
  });

  it('clears by hiding, never by deleting', async () => {
    const before = await prisma.notification.count({ where: { recipientId: admin.id } });
    expect(before).toBeGreaterThan(0);

    const res = await api('POST', '/api/notifications/dismiss-all', { token: adminToken });
    expect(res.status).toBe(200);

    // Gone from the list...
    const list = await api('GET', '/api/notifications', { token: adminToken });
    expect((list.body.data as { notifications: unknown[] }).notifications).toHaveLength(0);

    // ...but every row survives.
    const after = await prisma.notification.count({ where: { recipientId: admin.id } });
    expect(after).toBe(before);
  });

  it('requires authentication', async () => {
    for (const [method, path] of [
      ['GET', '/api/notifications'],
      ['POST', '/api/notifications/socket-ticket'],
      ['POST', '/api/notifications/dismiss-all'],
    ] as const) {
      const res = await api(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('mints a socket ticket for an authenticated caller', async () => {
    const res = await api('POST', '/api/notifications/socket-ticket', { token: adminToken });
    expect(res.status).toBe(200);
    const { ticket, expiresInSeconds } = res.body.data as { ticket: string; expiresInSeconds: number };
    expect(ticket.split('.')).toHaveLength(3);
    expect(expiresInSeconds).toBe(30);
  });
});
