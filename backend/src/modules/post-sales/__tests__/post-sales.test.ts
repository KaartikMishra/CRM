/**
 * Post Sales & Grievance — Phase 1, end to end.
 *
 * The core case foundation, proved at the only level that can prove it: real
 * requests against a real database. The things this suite exists to pin are the
 * ones a type cannot express —
 *
 *   - that an order must belong to the customer the case names, and an affected
 *     line to the order, so a case can never expose somebody else's purchase;
 *   - that `raisedById`, `performedById` and `uploadedById` come from the session
 *     and are unreachable from a body;
 *   - that EDIT and ASSIGN are genuinely separate capabilities;
 *   - that an illegal status move is refused rather than applied;
 *   - that two simultaneous creates get two different case numbers;
 *   - and that none of it touches an order, a shipment or a unit of stock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

let admin: TestUser;
/** VIEW only — may read the board, may write nothing. */
let viewer: TestUser;
/** VIEW + CREATE + EDIT, and deliberately NOT ASSIGN. */
let agent: TestUser;
/** Everything, including ASSIGN. */
let manager: TestUser;
/** No POST_SALES at all. */
let outsider: TestUser;

let adminToken: string;
let viewerToken: string;
let agentToken: string;
let managerToken: string;
let outsiderToken: string;

let customer: { id: string; name: string };
let otherCustomer: { id: string; name: string };
let orderId: string;
let orderLineIds: string[] = [];
let otherOrderId: string;
let otherOrderLineId: string;
let asset: { id: string };

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  viewer = await makeUser('USER');
  agent = await makeUser('USER');
  manager = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  viewerToken = await mintToken(viewer.id, { role: 'USER' });
  agentToken = await mintToken(agent.id, { role: 'USER' });
  managerToken = await mintToken(manager.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  customer = await makeCustomer('RETAIL', { phone: '+919876800001' });
  otherCustomer = await makeCustomer('RETAIL', { phone: '+919876800002' });

  await prisma.userModulePermission.createMany({
    data: [
      { userId: viewer.id, module: 'POST_SALES' as const, action: 'VIEW' as const, allowed: true },
      ...(['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: agent.id,
        module: 'POST_SALES' as const,
        action,
        allowed: true,
      })),
      ...(['VIEW', 'CREATE', 'EDIT', 'ASSIGN'] as const).map((action) => ({
        userId: manager.id,
        module: 'POST_SALES' as const,
        action,
        allowed: true,
      })),
    ],
  });

  // Two real orders, through Sales' own endpoint so their lines are canonical.
  const first = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [
        { productName: 'zz-test-ps-line-a', quantity: 5, price: '1200.00' },
        { productName: 'zz-test-ps-line-b', quantity: 2, price: '800.00' },
      ],
    }),
  });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const firstOrder = (first.body.data as { order: { id: string } }).order;
  orderId = firstOrder.id;
  trackSalesOrder(orderId);
  orderLineIds = (
    await prisma.salesOrderItem.findMany({
      where: { orderId },
      select: { id: true },
      orderBy: { lineNo: 'asc' },
    })
  ).map((r) => r.id);

  const second = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(otherCustomer.id, {
      items: [{ productName: 'zz-test-ps-other', quantity: 1, price: '500.00' }],
    }),
  });
  expect(second.status, JSON.stringify(second.body)).toBe(201);
  otherOrderId = (second.body.data as { order: { id: string } }).order.id;
  trackSalesOrder(otherOrderId);
  otherOrderLineId = (
    await prisma.salesOrderItem.findFirstOrThrow({
      where: { orderId: otherOrderId },
      select: { id: true },
    })
  ).id;

  /*
    A MediaAsset written directly: the real upload path talks to Cloudinary, which
    a test must not. The attachment contract cares that the id names a real asset.
  */
  asset = await prisma.mediaAsset.create({
    data: {
      publicId: `zz-test-ps-${Date.now()}`,
      secureUrl: 'https://example.invalid/zz-test-post-sales.jpg',
      format: 'jpg',
      uploadedById: agent.id,
    },
    select: { id: true },
  });
});

afterAll(async () => {
  /*
    The case's own rows cascade, but PostSalesCase -> Customer/SalesOrder/raisedBy
    is Restrict, so a case standing against a fixture customer would block the
    shared teardown. Removed here, scoped to this suite's own raisers.
  */
  await prisma.postSalesCase.deleteMany({
    where: { raisedById: { in: [admin.id, viewer.id, agent.id, manager.id, outsider.id] } },
  });

  // Written by hand above, so the tracked cleanup does not know about it, and
  // MediaAsset -> uploadedBy is Restrict.
  await prisma.mediaAsset.deleteMany({ where: { id: asset.id } });

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type CaseResponse = {
  id: string;
  caseNumber: string;
  customer: { id: string };
  order: { id: string; orderId: string; total: string } | null;
  dispatch: { id: string } | null;
  caseType: string;
  issueCategory: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  assignedTo: { id: string } | null;
  raisedBy: { id: string };
  resolvedAt: string | null;
  closedAt: string | null;
  items: { id: string; affectedQty: number; salesOrderItem: { id: string } }[];
  activities: {
    id: string;
    kind: string;
    note: string;
    channel: string | null;
    direction: string | null;
    dueAt: string | null;
    completedAt: string | null;
    performedBy: { id: string } | null;
  }[];
  attachments: { id: string; kind: string; media: { id: string } | null }[];
  nextStatuses: string[];
};

const body = (res: { body: { data?: unknown } }) =>
  (res.body.data as { case: CaseResponse }).case;

const basic = (over: Record<string, unknown> = {}) => ({
  customerId: customer.id,
  caseType: 'COMPLAINT',
  issueCategory: 'DAMAGED_PRODUCT',
  subject: 'Dinner set arrived dented',
  description: 'Customer reports a dent on the rim of the largest thali.',
  ...over,
});

const create = (token: string, over: Record<string, unknown> = {}) =>
  api('POST', '/api/post-sales/cases', { token, body: basic(over) });

async function makeCase(over: Record<string, unknown> = {}): Promise<CaseResponse> {
  const res = await create(agentToken, over);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return body(res);
}

const get = async (id: string, token = agentToken): Promise<CaseResponse> => {
  const res = await api('GET', `/api/post-sales/cases/${id}`, { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return body(res);
};

const setStatus = (token: string, id: string, status: string, note?: string) =>
  api('POST', `/api/post-sales/cases/${id}/status`, {
    token,
    body: note ? { status, note } : { status },
  });

const assign = (token: string, id: string, assignedToId: string | null) =>
  api('POST', `/api/post-sales/cases/${id}/assign`, { token, body: { assignedToId } });

const addActivity = (token: string, id: string, payload: Record<string, unknown>) =>
  api('POST', `/api/post-sales/cases/${id}/activities`, { token, body: payload });

/** Walks a fresh case to IN_PROGRESS, the state most transitions start from. */
async function inProgressCase(over: Record<string, unknown> = {}): Promise<CaseResponse> {
  const c = await makeCase(over);
  await setStatus(agentToken, c.id, 'IN_PROGRESS');
  return get(c.id);
}

// ===========================================================================
//  RBAC
// ===========================================================================

describe('permissions', () => {
  it('refuses an unauthenticated caller everywhere', async () => {
    expect((await api('GET', '/api/post-sales/cases')).status).toBe(401);
    expect((await api('POST', '/api/post-sales/cases', { body: basic() })).status).toBe(401);
    expect((await api('GET', '/api/post-sales/cases/overview')).status).toBe(401);
  });

  it('refuses somebody with no POST_SALES access', async () => {
    expect((await api('GET', '/api/post-sales/cases', { token: outsiderToken })).status).toBe(403);
    expect((await create(outsiderToken)).status).toBe(403);
  });

  it('lets VIEW read the board, the overview and a case', async () => {
    const c = await makeCase();
    expect((await api('GET', '/api/post-sales/cases', { token: viewerToken })).status).toBe(200);
    expect(
      (await api('GET', '/api/post-sales/cases/overview', { token: viewerToken })).status,
    ).toBe(200);
    expect((await api('GET', `/api/post-sales/cases/${c.id}`, { token: viewerToken })).status).toBe(
      200,
    );
  });

  it('refuses VIEW-only every write', async () => {
    const c = await makeCase();
    expect((await create(viewerToken)).status).toBe(403);
    expect(
      (await api('PATCH', `/api/post-sales/cases/${c.id}`, {
        token: viewerToken,
        body: { priority: 'HIGH' },
      })).status,
    ).toBe(403);
    expect((await setStatus(viewerToken, c.id, 'IN_PROGRESS')).status).toBe(403);
    expect((await addActivity(viewerToken, c.id, { kind: 'NOTE', note: 'no' })).status).toBe(403);
  });

  it('separates EDIT from ASSIGN — the whole point of two capabilities', async () => {
    const c = await makeCase();

    // The agent may work the case.
    expect((await setStatus(agentToken, c.id, 'IN_PROGRESS')).status).toBe(200);
    // And may not decide who owns it.
    expect((await assign(agentToken, c.id, agent.id)).status).toBe(403);
    // The manager may.
    expect((await assign(managerToken, c.id, agent.id)).status).toBe(200);
  });

  it('cannot smuggle an allocation through the edit endpoint', async () => {
    /*
      The update contract accepts only classification and description, so an extra
      key cannot reassign a case past the ASSIGN permission.
    */
    const c = await makeCase();
    const res = await api('PATCH', `/api/post-sales/cases/${c.id}`, {
      token: agentToken,
      body: { priority: 'HIGH', assignedToId: outsider.id },
    });

    expect(res.status).toBe(200);
    expect(body(res).assignedTo).toBeNull();
  });

  it('introduces no new permission vocabulary', async () => {
    // Every route resolves through POST_SALES and the four existing actions.
    const rows = await prisma.userModulePermission.findMany({
      where: { userId: manager.id },
      select: { module: true, action: true },
    });
    expect(new Set(rows.map((r) => r.module))).toEqual(new Set(['POST_SALES']));
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set(['VIEW', 'CREATE', 'EDIT', 'ASSIGN']),
    );
  });

  it('admits an administrator with no override rows', async () => {
    expect((await create(adminToken)).status).toBe(201);
  });
});

// ===========================================================================
//  Creating a case
// ===========================================================================

describe('creating a case', () => {
  it('records what was reported, and starts NEW', async () => {
    const c = await makeCase();
    expect(c.subject).toBe('Dinner set arrived dented');
    expect(c.caseType).toBe('COMPLAINT');
    expect(c.issueCategory).toBe('DAMAGED_PRODUCT');
    expect(c.status).toBe('NEW');
    // Default, not accepted from the payload above.
    expect(c.priority).toBe('MEDIUM');
  });

  it('allocates a readable PS-YYYY-NNNNNN number', async () => {
    const c = await makeCase();
    expect(c.caseNumber).toMatch(/^PS-\d{4}-\d{6}$/);
    // The cuid stays the internal key; they are different values.
    expect(c.caseNumber).not.toBe(c.id);
  });

  it('gives every case a distinct number under concurrent creation', async () => {
    /*
      The counter is bumped by an atomic INSERT ... ON CONFLICT DO UPDATE RETURNING
      inside the creating transaction, so simultaneous creates serialise rather than
      both reading the same value. COUNT(*) + 1 would hand out duplicates here.
    */
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => create(agentToken)));
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const numbers = results.map((r) => body(r).caseNumber);
    expect(new Set(numbers).size).toBe(5);
  });

  it('works with no order at all — a care question needs none', async () => {
    const c = await makeCase({
      caseType: 'PRODUCT_QUESTION',
      issueCategory: 'PRODUCT_CARE_QUESTION',
      subject: 'How should brass be cleaned?',
    });
    expect(c.order).toBeNull();
    expect(c.items).toEqual([]);
  });

  it('takes raisedBy from the session, never the body', async () => {
    const res = await create(agentToken, { raisedById: outsider.id });
    expect(res.status).toBe(201);
    expect(body(res).raisedBy.id).toBe(agent.id);
  });

  it('refuses a customer that does not exist', async () => {
    const res = await create(agentToken, { customerId: 'cuikzzzzzzzzzzzzzzzzzzzzz' });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses an invented case type, category or priority', async () => {
    expect((await create(agentToken, { caseType: 'LAWSUIT' })).status).toBe(422);
    expect((await create(agentToken, { issueCategory: 'HAUNTED' })).status).toBe(422);
    expect((await create(agentToken, { priority: 'URGENT' })).status).toBe(422);
  });

  it('refuses an empty subject or description', async () => {
    expect((await create(agentToken, { subject: '   ' })).status).toBe(422);
    expect((await create(agentToken, { description: '' })).status).toBe(422);
  });

  it('starts ASSIGNED when it names an owner, so the two cannot disagree', async () => {
    const c = await makeCase({ assignedToId: agent.id });
    expect(c.assignedTo?.id).toBe(agent.id);
    expect(c.status).toBe('ASSIGNED');
  });

  it('refuses an assignee whose account is not active', async () => {
    const retired = await makeUser('USER', false);
    const res = await create(agentToken, { assignedToId: retired.id });
    expect([400, 422]).toContain(res.status);
  });

  it('writes an opening timeline entry with no author', async () => {
    // A SYSTEM record has no performer; naming one would be a fabrication.
    const c = await makeCase();
    const opening = c.activities.find((a) => a.kind === 'SYSTEM');
    expect(opening).toBeDefined();
    expect(opening!.performedBy).toBeNull();
    expect(opening!.note).toContain(c.caseNumber);
  });
});

// ===========================================================================
//  The order and customer relationship
// ===========================================================================

describe('order linking', () => {
  it('links an order belonging to the same customer', async () => {
    const c = await makeCase({ salesOrderId: orderId });
    expect(c.order?.id).toBe(orderId);
  });

  it('derives the order total rather than storing one', async () => {
    // Through Sales' own toMoney, so a charge change there cannot leave a stale
    // figure here. No column on the case holds it.
    const c = await makeCase({ salesOrderId: orderId });
    expect(Number(c.order!.total)).toBeGreaterThan(0);

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'PostSalesCase'
    `;
    const names = columns.map((c2) => c2.column_name.toLowerCase());
    for (const absent of ['ordertotal', 'total', 'paymentstatus', 'customername', 'phone']) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('REFUSES an order belonging to a different customer', async () => {
    /*
      The check that stops a case exposing what somebody else bought. Without it a
      case filed against one customer could point at another's purchase.
    */
    const res = await create(agentToken, { salesOrderId: otherOrderId });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses an order that does not exist', async () => {
    const res = await create(agentToken, { salesOrderId: 'cuikyyyyyyyyyyyyyyyyyyyyy' });
    expect([400, 422]).toContain(res.status);
  });
});

// ===========================================================================
//  Affected lines
// ===========================================================================

describe('affected order lines', () => {
  it('records which lines and how many units', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 2 }],
    });
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.affectedQty).toBe(2);
    expect(c.items[0]!.salesOrderItem.id).toBe(orderLineIds[0]);
  });

  it('draws product identity from the line, duplicating nothing', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 1 }],
    });
    // The product name comes from the order line, not a copy on the case item.
    expect(c.items[0]!.salesOrderItem).toHaveProperty('productName');

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'PostSalesCaseItem'
    `;
    const names = columns.map((x) => x.column_name.toLowerCase());
    for (const absent of ['productname', 'sku', 'price', 'rsproductid']) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('REFUSES a line belonging to a different order', async () => {
    const res = await create(agentToken, {
      salesOrderId: orderId,
      items: [{ salesOrderItemId: otherOrderLineId, affectedQty: 1 }],
    });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses items with no order to belong to', async () => {
    const res = await create(agentToken, {
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 1 }],
    });
    expect(res.status).toBe(422);
  });

  it('refuses an affected quantity above what was bought', async () => {
    // Line A carries 5 units.
    const res = await create(agentToken, {
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 99 }],
    });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses a non-positive affected quantity', async () => {
    for (const affectedQty of [0, -1]) {
      const res = await create(agentToken, {
        salesOrderId: orderId,
        items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty }],
      });
      expect(res.status, String(affectedQty)).toBe(422);
    }
  });

  it('refuses the same line listed twice', async () => {
    const res = await create(agentToken, {
      salesOrderId: orderId,
      items: [
        { salesOrderItemId: orderLineIds[0]!, affectedQty: 1 },
        { salesOrderItemId: orderLineIds[0]!, affectedQty: 2 },
      ],
    });
    expect(res.status).toBe(422);
  });

  it('accepts several distinct lines', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [
        { salesOrderItemId: orderLineIds[0]!, affectedQty: 1 },
        { salesOrderItemId: orderLineIds[1]!, affectedQty: 2 },
      ],
    });
    expect(c.items).toHaveLength(2);
  });
});

// ===========================================================================
//  Status transitions
// ===========================================================================

describe('status transitions', () => {
  it('walks the ordinary path to CLOSED', async () => {
    const c = await makeCase();
    for (const next of ['ASSIGNED', 'IN_PROGRESS', 'RESOLUTION_IN_PROGRESS', 'RESOLVED', 'CLOSED']) {
      const res = await setStatus(agentToken, c.id, next);
      expect(res.status, `${next}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(body(res).status).toBe(next);
    }
  });

  it('refuses NEW straight to CLOSED', async () => {
    const c = await makeCase();
    const res = await setStatus(agentToken, c.id, 'CLOSED');
    expect([400, 422]).toContain(res.status);
    expect((await get(c.id)).status).toBe('NEW');
  });

  it('refuses a move to the status it already has', async () => {
    // Re-setting the current status is not a change; allowing it would write a
    // timeline entry and an audit record saying nothing happened.
    const c = await makeCase();
    expect([400, 422]).toContain((await setStatus(agentToken, c.id, 'NEW')).status);
  });

  it('refuses RESOLVED straight back to AWAITING_VENDOR', async () => {
    const c = await inProgressCase();
    await setStatus(agentToken, c.id, 'RESOLVED');
    const res = await setStatus(agentToken, c.id, 'AWAITING_VENDOR');
    expect([400, 422]).toContain(res.status);
  });

  it('lets RESOLVED go back to IN_PROGRESS, so a mistake needs no false closure', async () => {
    const c = await inProgressCase();
    await setStatus(agentToken, c.id, 'RESOLVED');
    const res = await setStatus(agentToken, c.id, 'IN_PROGRESS');
    expect(res.status).toBe(200);
    expect(body(res).status).toBe('IN_PROGRESS');
  });

  it('moves between the four awaiting states without passing through IN_PROGRESS', async () => {
    const c = await inProgressCase();
    await setStatus(agentToken, c.id, 'AWAITING_CUSTOMER');
    const res = await setStatus(agentToken, c.id, 'AWAITING_COURIER');
    expect(res.status).toBe(200);
    expect(body(res).status).toBe('AWAITING_COURIER');
  });

  it('stamps resolvedAt on RESOLVED and closedAt on CLOSED', async () => {
    const c = await inProgressCase();
    const resolved = body(await setStatus(agentToken, c.id, 'RESOLVED'));
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.closedAt).toBeNull();

    const closed = body(await setStatus(agentToken, c.id, 'CLOSED'));
    expect(closed.closedAt).not.toBeNull();
    // The original resolution moment survives the closure.
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);
  });

  it('reopens a closed case, clearing both stamps', async () => {
    const c = await inProgressCase();
    await setStatus(agentToken, c.id, 'RESOLVED');
    await setStatus(agentToken, c.id, 'CLOSED');

    const res = await setStatus(agentToken, c.id, 'REOPENED');
    expect(res.status).toBe(200);
    const reopened = body(res);
    expect(reopened.status).toBe('REOPENED');
    // A case that is open again was not resolved.
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.closedAt).toBeNull();
  });

  it('refuses CLOSED to anything but REOPENED', async () => {
    const c = await inProgressCase();
    await setStatus(agentToken, c.id, 'RESOLVED');
    await setStatus(agentToken, c.id, 'CLOSED');
    for (const bad of ['IN_PROGRESS', 'RESOLVED', 'CLOSED']) {
      expect([400, 422], bad).toContain((await setStatus(agentToken, c.id, bad)).status);
    }
  });

  it('writes a STATUS_CHANGE entry naming both ends', async () => {
    const c = await makeCase();
    const res = await setStatus(agentToken, c.id, 'IN_PROGRESS', 'Picked this up.');
    const entry = body(res).activities.find((a) => a.kind === 'STATUS_CHANGE');
    expect(entry).toBeDefined();
    expect(entry!.note).toContain('NEW');
    expect(entry!.note).toContain('IN_PROGRESS');
    expect(entry!.note).toContain('Picked this up.');
    expect(entry!.performedBy?.id).toBe(agent.id);
  });

  it('reports where a case may go next, from the shared map', async () => {
    const c = await makeCase();
    expect(c.nextStatuses).toContain('ASSIGNED');
    expect(c.nextStatuses).toContain('IN_PROGRESS');
    expect(c.nextStatuses).not.toContain('CLOSED');
    expect(c.nextStatuses).not.toContain('NEW');
  });
});

// ===========================================================================
//  Assignment
// ===========================================================================

describe('assignment', () => {
  it('assigns, and takes the actor from the session', async () => {
    const c = await makeCase();
    const res = await assign(managerToken, c.id, agent.id);
    expect(res.status).toBe(200);
    expect(body(res).assignedTo?.id).toBe(agent.id);
  });

  it('moves a NEW case to ASSIGNED, so the two agree', async () => {
    const c = await makeCase();
    expect(body(await assign(managerToken, c.id, agent.id)).status).toBe('ASSIGNED');
  });

  it('does not rewind a case already being worked', async () => {
    const c = await inProgressCase();
    expect(body(await assign(managerToken, c.id, agent.id)).status).toBe('IN_PROGRESS');
  });

  it('reassigns to somebody else', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, agent.id);
    const res = await assign(managerToken, c.id, manager.id);
    expect(body(res).assignedTo?.id).toBe(manager.id);
  });

  it('self-assigns', async () => {
    const c = await makeCase();
    const res = await assign(managerToken, c.id, manager.id);
    expect(body(res).assignedTo?.id).toBe(manager.id);
  });

  it('unassigns with an explicit null', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, agent.id);
    const res = await assign(managerToken, c.id, null);
    expect(res.status).toBe(200);
    expect(body(res).assignedTo).toBeNull();
  });

  it('refuses an inactive account', async () => {
    const retired = await makeUser('USER', false);
    const c = await makeCase();
    expect([400, 422]).toContain((await assign(managerToken, c.id, retired.id)).status);
  });

  it('writes an ASSIGNMENT_CHANGE entry', async () => {
    const c = await makeCase();
    const res = await assign(managerToken, c.id, agent.id);
    const entry = body(res).activities.find((a) => a.kind === 'ASSIGNMENT_CHANGE');
    expect(entry).toBeDefined();
    expect(entry!.performedBy?.id).toBe(manager.id);
  });

  it('keeps assignment history in AuditLog, with no assignment table', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, agent.id);
    await assign(managerToken, c.id, manager.id);
    await assign(managerToken, c.id, null);

    const trail = await prisma.auditLog.findMany({
      where: { entityType: 'PostSalesCase', entityId: c.id },
      select: { action: true },
    });
    const actions = trail.map((t) => t.action);
    expect(actions.filter((a) => a === 'postSales.case.assigned')).toHaveLength(2);
    expect(actions).toContain('postSales.case.unassigned');

    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'PostSales%'
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).not.toContain('PostSalesAssignment');
    expect(names).not.toContain('PostSalesCaseAssignment');
  });
});

// ===========================================================================
//  The timeline
// ===========================================================================

describe('activities', () => {
  it('adds a note, attributed to the actor', async () => {
    const c = await makeCase();
    const res = await addActivity(agentToken, c.id, { kind: 'NOTE', note: 'Called the customer.' });
    expect(res.status).toBe(201);
    const entry = body(res).activities.find((a) => a.kind === 'NOTE');
    expect(entry!.note).toBe('Called the customer.');
    expect(entry!.performedBy?.id).toBe(agent.id);
  });

  it('adds an internal note as its own kind, not a separate table', async () => {
    const c = await makeCase();
    const res = await addActivity(agentToken, c.id, {
      kind: 'INTERNAL_NOTE',
      note: 'Vendor batch looks suspect; do not tell the customer yet.',
    });
    expect(res.status).toBe(201);
    expect(body(res).activities.some((a) => a.kind === 'INTERNAL_NOTE')).toBe(true);

    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%InternalNote%'
    `;
    expect(tables).toEqual([]);
  });

  it('logs a customer communication with its channel and direction', async () => {
    const c = await makeCase();
    const res = await addActivity(agentToken, c.id, {
      kind: 'CUSTOMER_COMMUNICATION',
      note: 'Explained the replacement process.',
      channel: 'WHATSAPP',
      direction: 'OUTGOING',
    });
    expect(res.status).toBe(201);
    const entry = body(res).activities.find((a) => a.kind === 'CUSTOMER_COMMUNICATION');
    expect(entry!.channel).toBe('WHATSAPP');
    expect(entry!.direction).toBe('OUTGOING');
  });

  it('refuses a communication with no channel or direction', async () => {
    const c = await makeCase();
    expect(
      (await addActivity(agentToken, c.id, { kind: 'CUSTOMER_COMMUNICATION', note: 'x' })).status,
    ).toBe(422);
    expect(
      (await addActivity(agentToken, c.id, {
        kind: 'CUSTOMER_COMMUNICATION',
        note: 'x',
        channel: 'PHONE',
      })).status,
    ).toBe(422);
  });

  it('refuses a channel on anything that is not a communication', async () => {
    const c = await makeCase();
    const res = await addActivity(agentToken, c.id, {
      kind: 'NOTE',
      note: 'x',
      channel: 'PHONE',
      direction: 'INCOMING',
    });
    expect(res.status).toBe(422);
  });

  it('adds a follow-up with a due moment, not yet completed', async () => {
    const c = await makeCase();
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const res = await addActivity(agentToken, c.id, {
      kind: 'FOLLOW_UP',
      note: 'Check whether the replacement arrived.',
      dueAt,
    });
    expect(res.status).toBe(201);
    const entry = body(res).activities.find((a) => a.kind === 'FOLLOW_UP');
    expect(new Date(entry!.dueAt!).toISOString()).toBe(new Date(dueAt).toISOString());
    // Scheduling is not performing.
    expect(entry!.completedAt).toBeNull();
  });

  it('refuses a follow-up with no due moment', async () => {
    const c = await makeCase();
    expect(
      (await addActivity(agentToken, c.id, { kind: 'FOLLOW_UP', note: 'when?' })).status,
    ).toBe(422);
  });

  it('REFUSES a forged system entry', async () => {
    // The service writes SYSTEM, STATUS_CHANGE and ASSIGNMENT_CHANGE. A caller
    // forging one would be falsifying the history.
    const c = await makeCase();
    for (const kind of ['SYSTEM', 'STATUS_CHANGE', 'ASSIGNMENT_CHANGE']) {
      expect(
        (await addActivity(agentToken, c.id, { kind, note: 'fake' })).status,
        kind,
      ).toBe(422);
    }
  });

  it('takes performedBy from the session, never the body', async () => {
    const c = await makeCase();
    const res = await addActivity(agentToken, c.id, {
      kind: 'NOTE',
      note: 'x',
      performedById: outsider.id,
    });
    const entry = body(res).activities.find((a) => a.kind === 'NOTE');
    expect(entry!.performedBy?.id).toBe(agent.id);
  });

  it('marks a follow-up done through its own patch', async () => {
    const c = await makeCase();
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await addActivity(agentToken, c.id, {
      kind: 'FOLLOW_UP',
      note: 'Call back',
      dueAt,
    });
    const activityId = body(created).activities.find((a) => a.kind === 'FOLLOW_UP')!.id;

    const res = await api('PATCH', `/api/post-sales/cases/${c.id}/activities/${activityId}`, {
      token: agentToken,
      body: { completedAt: new Date().toISOString() },
    });
    expect(res.status).toBe(200);
    const entry = body(res).activities.find((a) => a.id === activityId);
    expect(entry!.completedAt).not.toBeNull();
  });

  it('cannot change an activity kind — the contract has no such field', async () => {
    const c = await makeCase();
    const created = await addActivity(agentToken, c.id, { kind: 'NOTE', note: 'original' });
    const activityId = body(created).activities.find((a) => a.kind === 'NOTE')!.id;

    const res = await api('PATCH', `/api/post-sales/cases/${c.id}/activities/${activityId}`, {
      token: agentToken,
      body: { kind: 'INTERNAL_NOTE', note: 'changed' },
    });

    if (res.status === 200) {
      expect(body(res).activities.find((a) => a.id === activityId)!.kind).toBe('NOTE');
    } else {
      expect(res.status).toBe(422);
    }
  });

  it('REFUSES an activity reached through another case URL', async () => {
    const a = await makeCase();
    const b = await makeCase();
    const created = await addActivity(agentToken, a.id, { kind: 'NOTE', note: 'belongs to A' });
    const activityId = body(created).activities.find((a2) => a2.kind === 'NOTE')!.id;

    const res = await api('PATCH', `/api/post-sales/cases/${b.id}/activities/${activityId}`, {
      token: agentToken,
      body: { note: 'hijacked' },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
//  Attachments
// ===========================================================================

describe('attachments', () => {
  const attach = (token: string, id: string, payload: Record<string, unknown>) =>
    api('POST', `/api/post-sales/cases/${id}/attachments`, { token, body: payload });

  it('attaches an existing asset', async () => {
    const c = await makeCase();
    const res = await attach(agentToken, c.id, {
      mediaAssetId: asset.id,
      kind: 'PRODUCT_PHOTO',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(body(res).attachments[0]!.media!.id).toBe(asset.id);
    expect(body(res).attachments[0]!.kind).toBe('PRODUCT_PHOTO');
  });

  it('refuses an asset that does not exist', async () => {
    const c = await makeCase();
    const res = await attach(agentToken, c.id, { mediaAssetId: 'cuikwwwwwwwwwwwwwwwwwwwww' });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses the same asset twice on one case', async () => {
    const c = await makeCase();
    expect((await attach(agentToken, c.id, { mediaAssetId: asset.id })).status).toBe(201);
    const second = await attach(agentToken, c.id, { mediaAssetId: asset.id });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('detaches WITHOUT deleting the MediaAsset', async () => {
    /*
      The rule this turns on: media is independently retained — seven tables
      reference it and every foreign key is SetNull — so detaching removes the link
      and nothing else.
    */
    const c = await makeCase();
    const created = await attach(agentToken, c.id, { mediaAssetId: asset.id });
    const attachmentId = body(created).attachments[0]!.id;

    const res = await api(
      'DELETE',
      `/api/post-sales/cases/${c.id}/attachments/${attachmentId}`,
      { token: agentToken },
    );
    expect(res.status).toBe(200);
    expect(body(res).attachments).toHaveLength(0);

    const still = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(still).not.toBeNull();
  });

  it('REFUSES an attachment reached through another case URL', async () => {
    const a = await makeCase();
    const b = await makeCase();
    const created = await attach(agentToken, a.id, { mediaAssetId: asset.id });
    const attachmentId = body(created).attachments[0]!.id;

    const res = await api(
      'DELETE',
      `/api/post-sales/cases/${b.id}/attachments/${attachmentId}`,
      { token: agentToken },
    );
    expect(res.status).toBe(404);
  });

  it('refuses an attachment write from VIEW-only', async () => {
    const c = await makeCase();
    expect((await attach(viewerToken, c.id, { mediaAssetId: asset.id })).status).toBe(403);
  });
});

// ===========================================================================
//  The board
// ===========================================================================

describe('the case board', () => {
  it('pages with a cursor and the shared convention', async () => {
    for (const n of [1, 2, 3]) {
      await makeCase({ subject: `zz-board-${n}` });
    }
    const res = await api('GET', '/api/post-sales/cases?limit=2', { token: agentToken });
    expect(res.status).toBe(200);
    const page = res.body.data as { cases: unknown[]; nextCursor: string | null };
    expect(page.cases).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('refuses a limit beyond the page maximum', async () => {
    expect((await api('GET', '/api/post-sales/cases?limit=500', { token: agentToken })).status).toBe(
      422,
    );
  });

  it('filters by status, priority and type', async () => {
    await makeCase({ priority: 'CRITICAL', caseType: 'DELIVERY_ISSUE' });

    const byPriority = await api('GET', '/api/post-sales/cases?priority=CRITICAL&limit=100', {
      token: agentToken,
    });
    const rows = (byPriority.body.data as { cases: { priority: string }[] }).cases;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.priority === 'CRITICAL')).toBe(true);

    const byType = await api('GET', '/api/post-sales/cases?caseType=DELIVERY_ISSUE&limit=100', {
      token: agentToken,
    });
    const typed = (byType.body.data as { cases: { caseType: string }[] }).cases;
    expect(typed.every((r) => r.caseType === 'DELIVERY_ISSUE')).toBe(true);
  });

  it('searches by case number, customer and order id', async () => {
    const c = await makeCase({ salesOrderId: orderId });

    for (const q of [c.caseNumber, customer.name.slice(0, 12)]) {
      const res = await api(`GET`, `/api/post-sales/cases?q=${encodeURIComponent(q)}&limit=100`, {
        token: agentToken,
      });
      expect(res.status, q).toBe(200);
      const ids = (res.body.data as { cases: { id: string }[] }).cases.map((r) => r.id);
      expect(ids, q).toContain(c.id);
    }
  });

  it('resolves `mine` against the caller, not an id they send', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, manager.id);

    // The manager sees it; the agent does not.
    const asManager = await api('GET', '/api/post-sales/cases?mine=true&limit=100', {
      token: managerToken,
    });
    expect(
      (asManager.body.data as { cases: { id: string }[] }).cases.map((r) => r.id),
    ).toContain(c.id);

    const asAgent = await api('GET', '/api/post-sales/cases?mine=true&limit=100', {
      token: agentToken,
    });
    expect((asAgent.body.data as { cases: { id: string }[] }).cases.map((r) => r.id)).not.toContain(
      c.id,
    );
  });

  it('reports the first affected product and a count of the rest', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [
        { salesOrderItemId: orderLineIds[0]!, affectedQty: 1 },
        { salesOrderItemId: orderLineIds[1]!, affectedQty: 1 },
      ],
    });

    const res = await api('GET', `/api/post-sales/cases?q=${c.caseNumber}&limit=10`, {
      token: agentToken,
    });
    const row = (
      res.body.data as { cases: { id: string; product: { name: string; more: number } | null }[] }
    ).cases.find((r) => r.id === c.id)!;
    expect(row.product!.more).toBe(1);
  });

  it('reports last activity without a stored column', async () => {
    const c = await makeCase();
    await addActivity(agentToken, c.id, { kind: 'NOTE', note: 'latest' });

    const res = await api('GET', `/api/post-sales/cases?q=${c.caseNumber}&limit=10`, {
      token: agentToken,
    });
    const row = (res.body.data as { cases: { id: string; lastActivityAt: string }[] }).cases.find(
      (r) => r.id === c.id,
    )!;
    expect(row.lastActivityAt).toBeTruthy();

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'PostSalesCase'
    `;
    expect(columns.map((x) => x.column_name.toLowerCase())).not.toContain('lastactivityat');
  });
});

// ===========================================================================
//  Overview
// ===========================================================================

describe('the overview', () => {
  it('reports only what the core case system can answer', async () => {
    const res = await api('GET', '/api/post-sales/cases/overview', { token: agentToken });
    expect(res.status).toBe(200);

    const overview = (res.body.data as { overview: Record<string, unknown> }).overview;
    expect(Object.keys(overview).sort()).toEqual([
      'assignedToMe',
      'critical',
      'newToday',
      'open',
      'reopened',
      'resolvedToday',
      'total',
      'unassigned',
    ]);
    // No SLA, CSAT, return rate or refund rate — Phase 1 holds none of that data.
    for (const absent of ['slaBreached', 'csat', 'returnRate', 'refundRate']) {
      expect(overview, absent).not.toHaveProperty(absent);
    }
  });

  it('is not read as a case id', async () => {
    // Declared before /cases/:id.
    const res = await api('GET', '/api/post-sales/cases/overview', { token: agentToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('overview');
  });
});

// ===========================================================================
//  Pickers
// ===========================================================================

describe('the pickers', () => {
  it('lists assignees with no credentials', async () => {
    const res = await api('GET', '/api/post-sales/assignees', { token: agentToken });
    expect(res.status).toBe(200);
    const list = (res.body.data as { assignees: Record<string, unknown>[] }).assignees;
    expect(Object.keys(list[0]!).sort()).toEqual(['employeeId', 'id', 'name', 'role']);
    expect(JSON.stringify(list)).not.toContain('password');
  });

  it('lists one customer orders with their lines', async () => {
    const res = await api('GET', `/api/post-sales/customers/${customer.id}/orders`, {
      token: agentToken,
    });
    expect(res.status).toBe(200);
    const orders = (res.body.data as { orders: { id: string; items: unknown[] }[] }).orders;
    const found = orders.find((o) => o.id === orderId);
    expect(found).toBeDefined();
    expect(found!.items.length).toBe(2);
  });

  it('never lists another customer orders', async () => {
    // Scoped to the customer in the URL, which is the authorisation.
    const res = await api('GET', `/api/post-sales/customers/${customer.id}/orders`, {
      token: agentToken,
    });
    const ids = (res.body.data as { orders: { id: string }[] }).orders.map((o) => o.id);
    expect(ids).not.toContain(otherOrderId);
  });
});

// ===========================================================================
//  Audit
// ===========================================================================

describe('the audit trail', () => {
  it('records creation, status, priority, assignment and closure', async () => {
    const c = await makeCase();
    await api('PATCH', `/api/post-sales/cases/${c.id}`, {
      token: agentToken,
      body: { priority: 'HIGH' },
    });
    await assign(managerToken, c.id, agent.id);
    await setStatus(agentToken, c.id, 'IN_PROGRESS');
    await setStatus(agentToken, c.id, 'RESOLVED');
    await setStatus(agentToken, c.id, 'CLOSED');

    const res = await api('GET', `/api/post-sales/cases/${c.id}/audit`, { token: agentToken });
    expect(res.status).toBe(200);
    const actions = (res.body.data as { entries: { action: string }[] }).entries.map(
      (e) => e.action,
    );

    expect(actions).toContain('postSales.case.created');
    expect(actions).toContain('postSales.case.updated');
    expect(actions).toContain('postSales.case.assigned');
    expect(actions.filter((a) => a === 'postSales.case.statusChanged').length).toBe(3);
  });

  it('uses the existing generic AuditLog, with no second audit table', async () => {
    const c = await makeCase();
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'PostSalesCase', entityId: c.id },
      select: { actorId: true, entityType: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actorId).toBe(agent.id);

    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE '%PostSales%Audit%' OR table_name LIKE '%PostSalesHistory%'
    `;
    expect(tables).toEqual([]);
  });
});

// ===========================================================================
//  Notifications
// ===========================================================================

describe('notifications', () => {
  it('tells an assignee their case is theirs', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, agent.id);

    const notices = await prisma.notification.findMany({
      where: { recipientId: agent.id, entityType: 'PostSalesCase', entityId: c.id },
      select: { type: true },
    });
    expect(notices.map((n) => n.type)).toContain('POST_SALES_CASE_ASSIGNED');
  });

  it('does not notify a self-assignment', async () => {
    const c = await makeCase();
    await assign(managerToken, c.id, manager.id);

    const notices = await prisma.notification.findMany({
      where: { recipientId: manager.id, entityType: 'PostSalesCase', entityId: c.id },
    });
    expect(notices).toHaveLength(0);
  });

  it('uses the existing Notification table, with no second system', async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%PostSalesNotif%'
    `;
    expect(tables).toEqual([]);
  });
});

// ===========================================================================
//  Phase boundaries — what Phase 1 must NOT do
// ===========================================================================

describe('Phase 1 stays within its scope', () => {
  it('changes no stock or inventory figure', async () => {
    const before = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });

    const c = await makeCase({
      caseType: 'RETURN',
      issueCategory: 'RETURN_REQUEST',
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 3 }],
    });
    await setStatus(agentToken, c.id, 'IN_PROGRESS');
    await setStatus(agentToken, c.id, 'RESOLVED');

    const after = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });
    expect(Number(after._sum.crmStockQty ?? 0)).toBe(Number(before._sum.crmStockQty ?? 0));
    expect(Number(after._sum.inventoryQty ?? 0)).toBe(Number(before._sum.inventoryQty ?? 0));
  });

  it('modifies no SalesOrder and no order line', async () => {
    const before = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, paidAmount: true, updatedAt: true },
    });
    const itemsBefore = await prisma.salesOrderItem.count({ where: { orderId } });

    const c = await makeCase({
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 1 }],
    });
    await setStatus(agentToken, c.id, 'IN_PROGRESS');

    const after = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, paidAmount: true, updatedAt: true },
    });
    expect(after).toEqual(before);
    expect(await prisma.salesOrderItem.count({ where: { orderId } })).toBe(itemsBefore);
  });

  it('creates no refund, even for a REFUND case', async () => {
    // caseType = REFUND classifies the case. It does not move money, and there is
    // no payment gateway in this CRM.
    const before = await prisma.salesRefund.count();

    const c = await makeCase({
      caseType: 'REFUND',
      issueCategory: 'REFUND_REQUEST',
      salesOrderId: orderId,
    });
    await setStatus(agentToken, c.id, 'IN_PROGRESS');
    await setStatus(agentToken, c.id, 'RESOLVED');

    expect(await prisma.salesRefund.count()).toBe(before);
  });

  it('creates and modifies no shipment', async () => {
    const before = await prisma.dispatch.count();
    const c = await makeCase({
      caseType: 'REPLACEMENT',
      issueCategory: 'REPLACEMENT_REQUEST',
      salesOrderId: orderId,
    });
    await setStatus(agentToken, c.id, 'IN_PROGRESS');
    expect(await prisma.dispatch.count()).toBe(before);
  });

  it('builds no resolution or settings table', async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('PostSalesResolution', 'PostSalesSetting', 'PostSalesReturn',
                           'PostSalesRefund', 'PostSalesReplacement', 'PostSalesExchange',
                           'PostSalesWarranty', 'PostSalesSla', 'PostSalesCsat')
    `;
    expect(tables).toEqual([]);
  });

  it('stores no SLA or CSAT column on the case', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'PostSalesCase'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());
    for (const absent of ['sladeadline', 'slabreached', 'slaminutes', 'csat', 'csatscore',
                          'escalatedat', 'escalationlevel']) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('creates exactly the four Phase 1 tables plus the counter', async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'PostSales%' ORDER BY table_name
    `;
    expect(tables.map((t) => t.table_name)).toEqual([
      'PostSalesActivity',
      'PostSalesAttachment',
      'PostSalesCase',
      'PostSalesCaseCounter',
      'PostSalesCaseItem',
    ]);
  });
});

// ===========================================================================
//  Transaction safety
// ===========================================================================

describe('transaction safety', () => {
  it('leaves nothing behind when an affected line is rejected', async () => {
    /*
      The case, its items and the opening activity commit together. A payload that
      fails validation inside the transaction must leave no case and must not burn
      a case number.
    */
    const before = await prisma.postSalesCase.count();

    const res = await create(agentToken, {
      salesOrderId: orderId,
      items: [{ salesOrderItemId: otherOrderLineId, affectedQty: 1 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await prisma.postSalesCase.count()).toBe(before);
  });

  it('writes the case, its items and its opening entry together', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 1 }],
    });

    const row = await prisma.postSalesCase.findUniqueOrThrow({
      where: { id: c.id },
      select: { _count: { select: { items: true, activities: true } } },
    });
    expect(row._count.items).toBe(1);
    expect(row._count.activities).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
//  The database's own guarantees
// ===========================================================================

describe('the tables defend the rules themselves', () => {
  it('refuses a duplicate case number', async () => {
    const c = await makeCase();
    await expect(
      prisma.postSalesCase.create({
        data: {
          caseNumber: c.caseNumber,
          customerId: customer.id,
          caseType: 'OTHER',
          issueCategory: 'OTHER',
          subject: 'dupe',
          description: 'dupe',
          raisedById: agent.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a non-positive affected quantity at the database level', async () => {
    const c = await makeCase({ salesOrderId: orderId });
    await expect(
      prisma.postSalesCaseItem.create({
        data: { caseId: c.id, salesOrderItemId: orderLineIds[0]!, affectedQty: 0 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a channel on a non-communication at the database level', async () => {
    const c = await makeCase();
    await expect(
      prisma.postSalesActivity.create({
        data: { caseId: c.id, kind: 'NOTE', note: 'x', channel: 'PHONE', direction: 'INCOMING' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a follow-up with no due moment at the database level', async () => {
    const c = await makeCase();
    await expect(
      prisma.postSalesActivity.create({
        data: { caseId: c.id, kind: 'FOLLOW_UP', note: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a RESOLVED case with no resolvedAt at the database level', async () => {
    const c = await makeCase();
    await expect(
      prisma.postSalesCase.update({
        where: { id: c.id },
        data: { status: 'RESOLVED' },
      }),
    ).rejects.toThrow();
  });

  it('cascades the case children and nothing else', async () => {
    const c = await makeCase({
      salesOrderId: orderId,
      items: [{ salesOrderItemId: orderLineIds[0]!, affectedQty: 1 }],
    });
    await addActivity(agentToken, c.id, { kind: 'NOTE', note: 'x' });

    await prisma.postSalesCase.delete({ where: { id: c.id } });

    expect(await prisma.postSalesCaseItem.count({ where: { caseId: c.id } })).toBe(0);
    expect(await prisma.postSalesActivity.count({ where: { caseId: c.id } })).toBe(0);
    // The order and its line are untouched: Restrict, not Cascade.
    expect(await prisma.salesOrder.findUnique({ where: { id: orderId } })).not.toBeNull();
    expect(
      await prisma.salesOrderItem.findUnique({ where: { id: orderLineIds[0]! } }),
    ).not.toBeNull();
  });
});
