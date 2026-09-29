/**
 * Partial dispatch — the request, the decision, and who may make each.
 *
 * The scenario throughout is the one from the brief: an order for five thalis
 * and two cookers, with the thalis procured and the cookers not. That is the
 * only situation in which the question exists, and several tests below exist
 * precisely to prove the question is *refused* in the situations where it does
 * not — a fully ready order, and one with nothing ready at all.
 *
 * The asymmetry between the two decisions is the business rule with the most
 * ways to go wrong, so it is asserted from both sides: allowing needs a reason
 * and may omit a plan of action, refusing needs both.
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
  approvePurchaseBill,
  cleanup,
  makeCustomer,
  makeRsProduct,
  makeUser,
  makeVendor,
  mapOrderLineToRsProduct,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let dispatcher: TestUser;
let procurer: TestUser;
/** PROCUREMENT:ASSIGN and nothing from Packing & Dispatch — the queue's point. */
let assignOnly: TestUser;
let outsider: TestUser;

let adminToken: string;
let dispatcherToken: string;
let procurerToken: string;
let assignOnlyToken: string;
let outsiderToken: string;

let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  dispatcher = await makeUser('USER');
  procurer = await makeUser('USER');
  assignOnly = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  dispatcherToken = await mintToken(dispatcher.id, { role: 'USER' });
  procurerToken = await mintToken(procurer.id, { role: 'USER' });
  assignOnlyToken = await mintToken(assignOnly.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  vendor = await makeVendor();
  customer = await makeCustomer('RETAIL', {
    phone: '+91 98765 43210',
    address: '14 Station Road, Moradabad',
  });

  /*
    Two people with two different jobs, granted through the same override rows
    an administrator would write. The dispatcher can raise the question and not
    answer it; the procurer can answer it and not raise it. Keeping them apart
    is what lets the permission tests below mean anything.
  */
  await prisma.userModulePermission.createMany({
    data: [
      ...(['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: dispatcher.id,
        module: 'PACKING_DISPATCH' as const,
        action,
        allowed: true,
      })),
      ...(['VIEW', 'ASSIGN'] as const).map((action) => ({
        userId: procurer.id,
        module: 'PROCUREMENT' as const,
        action,
        allowed: true,
      })),
      // So the procurer can read the board they are deciding about.
      { userId: procurer.id, module: 'PACKING_DISPATCH' as const, action: 'VIEW' as const, allowed: true },
      /*
        And one reviewer who holds ASSIGN and nothing else. They must be able to
        find and answer a partial-dispatch request entirely from their own
        module — needing PACKING_DISPATCH to answer a question addressed to
        Procurement is exactly the defect the queue exists to remove.
      */
      { userId: assignOnly.id, module: 'PROCUREMENT' as const, action: 'ASSIGN' as const, allowed: true },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Scenario builders
// ---------------------------------------------------------------------------

type Order = { id: string; orderNumber: string; lineIds: string[] };

/** An order for two products, both mapped to the catalogue. */
async function makeOrder(
  products: { id: string; quantity: number }[],
): Promise<Order> {
  const payload = salesOrderPayload(customer.id, {
    items: products.map((p, i) => ({
      productName: `zz-test-line-${i}`,
      quantity: p.quantity,
      price: '100.00',
    })),
  });

  const res = await api('POST', '/api/sales', { token: adminToken, body: payload });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const order = (
    res.body.data as { order: { id: string; orderId: string; items: { id: string }[] } }
  ).order;
  trackSalesOrder(order.id);

  for (const [i, product] of products.entries()) {
    await mapOrderLineToRsProduct(order.items[i]!.id, product.id);
  }

  return {
    id: order.id,
    orderNumber: order.orderId,
    lineIds: order.items.map((item) => item.id),
  };
}

/** Procures `quantity` units of `product` and commits them to `lineId`. */
async function procureAndAllocate(
  productId: string,
  lineId: string,
  quantity: number,
): Promise<void> {
  const billRes = await api('POST', '/api/procurement/bills', {
    token: adminToken,
    body: purchaseBillPayload(vendor.id, productId, {
      items: [
        {
          productName: 'zz-test-bill-line',
          rsProductId: productId,
          orderedQty: quantity,
          receivedQty: quantity,
          rate: '100.00',
        },
      ],
    }),
  });
  expect(billRes.status, JSON.stringify(billRes.body)).toBe(201);

  const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  await approvePurchaseBill(bill.id);

  const allocRes = await api(
    'POST',
    `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`,
    { token: adminToken, body: { salesOrderItemId: lineId, quantity } },
  );
  expect(allocRes.status, JSON.stringify(allocRes.body)).toBe(201);
}

/**
 * The brief's own case: five thalis ready, two cookers not.
 *
 * Returned ready for a partial-dispatch question and nothing else — every test
 * that needs "an order somebody could ask about" starts here.
 */
async function partiallyReadyOrder(): Promise<Order> {
  const thali = await makeRsProduct({ title: 'zz-test-kansa-thali' });
  const cooker = await makeRsProduct({ title: 'zz-test-cooker' });

  const order = await makeOrder([
    { id: thali.id, quantity: 5 },
    { id: cooker.id, quantity: 2 },
  ]);

  await procureAndAllocate(thali.id, order.lineIds[0]!, 5);
  return order;
}

type RequestView = {
  id: string;
  status: string;
  deadline: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: { id: string } | null;
  reason: string | null;
  poa: string | null;
  autoDecided: boolean;
};

async function raise(
  token: string,
  salesOrderId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; request?: RequestView; code?: string }> {
  const res = await api('POST', '/api/dispatch/partial-requests', {
    token,
    body: { salesOrderId, ...body },
  });
  return {
    status: res.status,
    request: (res.body.data as { request: RequestView } | undefined)?.request,
    code: res.body.code,
  };
}

// ---------------------------------------------------------------------------
//  Raising the question
// ---------------------------------------------------------------------------

describe('raising a partial dispatch request', () => {
  it('a USER creates a PENDING request on a partly ready order', async () => {
    const order = await partiallyReadyOrder();

    const { status, request } = await raise(dispatcherToken, order.id);

    expect(status).toBe(201);
    expect(request!.status).toBe('PENDING');
    // Nothing is decided yet, and nothing pretends to be.
    expect(request!.decidedAt).toBeNull();
    expect(request!.decidedBy).toBeNull();
    expect(request!.reason).toBeNull();
    expect(request!.poa).toBeNull();
    expect(request!.autoDecided).toBe(false);
  });

  it('sets the deadline 24 hours after the request', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const requestedAt = new Date(request!.requestedAt).getTime();
    const deadline = new Date(request!.deadline).getTime();

    // Exactly 24 hours. Both instants come from the database in the same
    // transaction, so this is not a tolerance for clock drift — a second of
    // slack only absorbs millisecond rounding on the wire.
    expect(deadline - requestedAt).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(deadline - requestedAt).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('refuses a second request while one is undecided', async () => {
    const order = await partiallyReadyOrder();

    const first = await raise(dispatcherToken, order.id);
    expect(first.status).toBe(201);

    const second = await raise(dispatcherToken, order.id);
    expect(second.status).toBe(409);
    expect(second.code).toBe('PARTIAL_REQUEST_ALREADY_OPEN');
  });

  it('refuses the question on a fully ready order — just send it', async () => {
    const thali = await makeRsProduct({ title: 'zz-test-thali-full' });
    const order = await makeOrder([{ id: thali.id, quantity: 5 }]);
    await procureAndAllocate(thali.id, order.lineIds[0]!, 5);

    const { status, code } = await raise(dispatcherToken, order.id);
    expect(status).toBe(409);
    expect(code).toBe('ORDER_FULLY_READY');
  });

  it('refuses the question when nothing is ready — there is no parcel to send', async () => {
    const cooker = await makeRsProduct({ title: 'zz-test-cooker-empty' });
    const order = await makeOrder([{ id: cooker.id, quantity: 2 }]);

    const { status, code } = await raise(dispatcherToken, order.id);
    expect(status).toBe(409);
    expect(code).toBe('NOTHING_DISPATCHABLE');
  });

  it('notifies the people who can decide it', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const notices = await prisma.notification.findMany({
      where: { type: 'PARTIAL_DISPATCH_REQUESTED', entityId: request!.id },
      select: { recipientId: true },
    });

    // The procurer holds PROCUREMENT:ASSIGN; the dispatcher who asked does not.
    const recipients = notices.map((n) => n.recipientId);
    expect(recipients).toContain(procurer.id);
    expect(recipients).not.toContain(dispatcher.id);
  });
});

// ---------------------------------------------------------------------------
//  ADMIN — the request that decides itself
// ---------------------------------------------------------------------------

describe('an administrator raising the request', () => {
  it('is allowed immediately, by themselves, with their reason on record', async () => {
    const order = await partiallyReadyOrder();

    const { status, request } = await raise(adminToken, order.id, {
      reason: 'Customer needs the thalis for a wedding on Friday',
    });

    expect(status).toBe(201);
    expect(request!.status).toBe('ALLOWED');
    expect(request!.decidedBy!.id).toBe(admin.id);
    expect(request!.decidedAt).not.toBeNull();
    expect(request!.reason).toBe('Customer needs the thalis for a wedding on Friday');
    // The distinction the dashboard depends on: a person decided this, so it is
    // NOT an automatic decision even though nobody else was asked.
    expect(request!.autoDecided).toBe(false);
  });

  it('must still say why', async () => {
    const order = await partiallyReadyOrder();

    const { status, code } = await raise(adminToken, order.id);
    expect(status).toBe(400);
    expect(code).toBe('REASON_REQUIRED');
  });

  it('may attach a plan of action, but is not required to', async () => {
    const order = await partiallyReadyOrder();

    const { request } = await raise(adminToken, order.id, {
      reason: 'Send the thalis now',
      poa: 'Cookers follow next week on the same AWB series',
    });

    expect(request!.poa).toBe('Cookers follow next week on the same AWB series');
  });

  it('tells nobody — the only person who would hear is the one who did it', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(adminToken, order.id, { reason: 'Send it' });

    const notices = await prisma.notification.count({
      where: { entityId: request!.id },
    });
    expect(notices).toBe(0);
  });

  it('does NOT extend to a USER holding a powerful permission', async () => {
    const order = await partiallyReadyOrder();

    /*
      The trap this whole rule exists to avoid. `procurer` holds
      PROCUREMENT:ASSIGN — they can decide anybody's partial request — but they
      are a USER, so their OWN request waits like anyone else's. The bypass is
      a fact about the role, never about what the role can do.
    */
    await prisma.userModulePermission.create({
      data: {
        userId: procurer.id,
        module: 'PACKING_DISPATCH',
        action: 'CREATE',
        allowed: true,
      },
    });

    const { status, request } = await raise(procurerToken, order.id, {
      reason: 'I can decide these anyway',
    });

    expect(status).toBe(201);
    expect(request!.status).toBe('PENDING');
    expect(request!.decidedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Deciding it
// ---------------------------------------------------------------------------

async function decide(
  token: string,
  requestId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; request?: RequestView; code?: string; details?: unknown }> {
  const res = await api('POST', `/api/dispatch/partial-requests/${requestId}/decide`, {
    token,
    body,
  });
  return {
    status: res.status,
    request: (res.body.data as { request: RequestView } | undefined)?.request,
    code: res.body.code,
    details: res.body.details,
  };
}

describe('procurement allowing it', () => {
  it('records the decider, the moment and the reason', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const decided = await decide(procurerToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Cookers are three weeks out; do not hold the thalis',
    });

    expect(decided.status).toBe(200);
    expect(decided.request!.status).toBe('ALLOWED');
    expect(decided.request!.decidedBy!.id).toBe(procurer.id);
    expect(decided.request!.decidedAt).not.toBeNull();
    expect(decided.request!.reason).toBe('Cookers are three weeks out; do not hold the thalis');
    expect(decided.request!.autoDecided).toBe(false);
  });

  it('requires a reason', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const decided = await decide(procurerToken, request!.id, { decision: 'ALLOW' });
    expect(decided.status).toBe(422);
  });

  it('accepts a plan of action but does not demand one', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const withPoa = await decide(procurerToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Send the ready half',
      poa: 'Second parcel when the cookers land',
    });

    expect(withPoa.status).toBe(200);
    expect(withPoa.request!.poa).toBe('Second parcel when the cookers land');
  });

  it('notifies the person who asked', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);
    await decide(procurerToken, request!.id, { decision: 'ALLOW', reason: 'Fine' });

    const notices = await prisma.notification.findMany({
      where: { type: 'PARTIAL_DISPATCH_ALLOWED', entityId: request!.id },
      select: { recipientId: true },
    });

    expect(notices.map((n) => n.recipientId)).toEqual([dispatcher.id]);
  });
});

describe('procurement refusing it', () => {
  it('requires a reason AND a plan of action', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    // A refusal leaves goods sitting, so it owes the warehouse a plan.
    const noPoa = await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Cookers arrive Monday',
    });
    expect(noPoa.status).toBe(422);

    const noReason = await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      poa: 'Hold until Monday',
    });
    expect(noReason.status).toBe(422);

    const both = await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Cookers arrive Monday',
      poa: 'Hold the thalis and send one complete parcel',
    });
    expect(both.status).toBe(200);
    expect(both.request!.status).toBe('DISALLOWED');
    expect(both.request!.poa).toBe('Hold the thalis and send one complete parcel');
  });

  it('notifies the person who asked', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);
    await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Hold it',
      poa: 'One parcel Monday',
    });

    const notices = await prisma.notification.findMany({
      where: { type: 'PARTIAL_DISPATCH_DISALLOWED', entityId: request!.id },
      select: { recipientId: true },
    });

    expect(notices.map((n) => n.recipientId)).toEqual([dispatcher.id]);
  });
});

describe('a question that is already answered', () => {
  it('cannot be decided twice', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    await decide(procurerToken, request!.id, { decision: 'ALLOW', reason: 'Send it' });

    const again = await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Changed my mind',
      poa: 'Recall it',
    });

    expect(again.status).toBe(409);
    expect(again.code).toBe('PARTIAL_REQUEST_SETTLED');
  });

  it('frees the order for a fresh question', async () => {
    const order = await partiallyReadyOrder();
    const first = await raise(dispatcherToken, order.id);
    await decide(procurerToken, first.request!.id, {
      decision: 'DISALLOW',
      reason: 'Not yet',
      poa: 'Ask again Friday',
    });

    // The one-pending rule is about *open* questions, not about ever having
    // asked: a refusal that has since gone stale can be asked about again.
    const second = await raise(dispatcherToken, order.id);
    expect(second.status).toBe(201);
    expect(second.request!.status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
//  Who may do what
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Procurement's decision queue
// ---------------------------------------------------------------------------

type PendingRow = {
  request: RequestView & { salesOrderId: string };
  orderId: string;
  customerName: string;
  requiredQty: number;
  readyQty: number;
  pendingQty: number;
  readyLines: number;
  totalLines: number;
};

const pendingQueue = async (token: string) =>
  api('GET', '/api/dispatch/partial-requests/pending', { token });

describe('the procurement decision queue', () => {
  it('lists an open request without being told which order to look at', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const res = await pendingQueue(procurerToken);
    expect(res.status).toBe(200);

    const rows = (res.body.data as { requests: PendingRow[] }).requests;
    const row = rows.find((r) => r.request.id === request!.id);

    expect(row, 'the request a procurement reviewer must answer').toBeDefined();
    expect(row!.orderId).toBe(order.orderNumber);
    expect(row!.request.status).toBe('PENDING');
  });

  it('carries the quantities the decision turns on', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const res = await pendingQueue(procurerToken);
    const row = (res.body.data as { requests: PendingRow[] }).requests.find(
      (r) => r.request.id === request!.id,
    )!;

    // Five thalis ready of seven units owed, two cookers still short — which is
    // the whole question: send half now, or hold for one complete parcel.
    expect(row.requiredQty).toBe(7);
    expect(row.readyQty).toBe(5);
    expect(row.pendingQty).toBe(2);
    expect(row.readyLines).toBe(1);
    expect(row.totalLines).toBe(2);
  });

  it('excludes everything that is not PENDING', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    await decide(procurerToken, request!.id, { decision: 'ALLOW', reason: 'Send it' });

    const rows = (
      (await pendingQueue(procurerToken)).body.data as { requests: PendingRow[] }
    ).requests;
    expect(rows.some((r) => r.request.id === request!.id)).toBe(false);
  });

  it('never contains an administrator’s self-allowed request', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(adminToken, order.id, { reason: 'Send the thalis' });

    // ADMIN decides in the same act, so it is born ALLOWED and was never a
    // question for anybody else to answer.
    expect(request!.status).toBe('ALLOWED');

    const rows = (
      (await pendingQueue(procurerToken)).body.data as { requests: PendingRow[] }
    ).requests;
    expect(rows.some((r) => r.request.id === request!.id)).toBe(false);
  });

  it('is reachable on PROCUREMENT:ASSIGN alone, with no dispatch access', async () => {
    /*
      The point of the whole queue. `procurer` holds PROCUREMENT VIEW/ASSIGN and
      PACKING_DISPATCH VIEW; `assignOnly` holds ASSIGN and nothing from Packing
      & Dispatch at all — and must still be able to see what it has to decide.
    */
    const res = await pendingQueue(assignOnlyToken);
    expect(res.status).toBe(200);
  });

  it('refuses somebody without PROCUREMENT:ASSIGN', async () => {
    // The dispatcher raises these requests and cannot answer them.
    expect((await pendingQueue(dispatcherToken)).status).toBe(403);
    expect((await pendingQueue(outsiderToken)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await api('GET', '/api/dispatch/partial-requests/pending');
    expect(res.status).toBe(401);
  });

  it('is not parsed as a request id', async () => {
    // `/partial-requests/pending` is declared before `/partial-requests/:id`,
    // so `pending` is never read as a cuid.
    const res = await pendingQueue(procurerToken);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });
});

describe('deciding from procurement, without dispatch access', () => {
  it('allows a request for somebody holding only PROCUREMENT:ASSIGN', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const decided = await decide(assignOnlyToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Cookers are weeks out; send the thalis',
    });

    expect(decided.status).toBe(200);
    expect(decided.request!.status).toBe('ALLOWED');
    expect(decided.request!.decidedBy!.id).toBe(assignOnly.id);
    expect(decided.request!.autoDecided).toBe(false);
  });

  it('drops it from the queue once decided', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    await decide(assignOnlyToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Hold for one parcel',
      poa: 'Send everything Monday',
    });

    const rows = (
      (await pendingQueue(assignOnlyToken)).body.data as { requests: PendingRow[] }
    ).requests;
    expect(rows.some((r) => r.request.id === request!.id)).toBe(false);
  });
});

describe('permissions', () => {
  it('refuses a user with no dispatch access', async () => {
    const order = await partiallyReadyOrder();
    const { status } = await raise(outsiderToken, order.id);
    expect(status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const order = await partiallyReadyOrder();
    const res = await api('POST', '/api/dispatch/partial-requests', {
      body: { salesOrderId: order.id },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a dispatcher deciding their own question', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    /*
      The dispatcher holds every PACKING_DISPATCH permission and still cannot
      answer this: the decision is Procurement's, and it is gated on
      PROCUREMENT:ASSIGN rather than on anything in their own module.
    */
    const decided = await decide(dispatcherToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Approving my own request',
    });

    expect(decided.status).toBe(403);
  });

  it('lets an administrator decide without any override rows', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const decided = await decide(adminToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Send the ready half',
    });

    expect(decided.status).toBe(200);
    expect(decided.request!.decidedBy!.id).toBe(admin.id);
  });
});

// ---------------------------------------------------------------------------
//  Reading it back
// ---------------------------------------------------------------------------

describe('the board and the detail page', () => {
  it('shows the open question on the order detail, with its deadline', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const res = await api('GET', `/api/dispatch/orders/${order.id}`, { token: dispatcherToken });
    expect(res.status).toBe(200);

    const detail = (
      res.body.data as {
        detail: {
          readiness: { fullyReady: boolean; partiallyReady: boolean };
          partialRequests: RequestView[];
        };
      }
    ).detail;

    expect(detail.readiness.partiallyReady).toBe(true);
    expect(detail.readiness.fullyReady).toBe(false);
    expect(detail.partialRequests).toHaveLength(1);
    expect(detail.partialRequests[0]!.id).toBe(request!.id);
    expect(detail.partialRequests[0]!.deadline).toBe(request!.deadline);
  });

  it('keeps a decided request in the history, with its reason and plan', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);
    await decide(procurerToken, request!.id, {
      decision: 'DISALLOW',
      reason: 'Cookers land Monday',
      poa: 'One complete parcel Tuesday',
    });

    const res = await api('GET', `/api/dispatch/orders/${order.id}/partial-requests`, {
      token: dispatcherToken,
    });
    expect(res.status).toBe(200);

    const requests = (res.body.data as { requests: RequestView[] }).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('DISALLOWED');
    expect(requests[0]!.reason).toBe('Cookers land Monday');
    expect(requests[0]!.poa).toBe('One complete parcel Tuesday');
  });

  it('carries the open question onto the board row', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);

    const res = await api('GET', '/api/dispatch/board?limit=50', { token: dispatcherToken });
    expect(res.status).toBe(200);

    const orders = (
      res.body.data as {
        orders: { salesOrderId: string; pendingPartialRequest: RequestView | null }[];
      }
    ).orders;

    const row = orders.find((o) => o.salesOrderId === order.id);
    expect(row).toBeDefined();
    expect(row!.pendingPartialRequest).not.toBeNull();
    expect(row!.pendingPartialRequest!.id).toBe(request!.id);
    expect(row!.pendingPartialRequest!.status).toBe('PENDING');
  });

  it('leaves the board row empty once the question is answered', async () => {
    const order = await partiallyReadyOrder();
    const { request } = await raise(dispatcherToken, order.id);
    await decide(procurerToken, request!.id, { decision: 'ALLOW', reason: 'Send it' });

    const res = await api('GET', '/api/dispatch/board?limit=50', { token: dispatcherToken });
    const orders = (
      res.body.data as {
        orders: { salesOrderId: string; pendingPartialRequest: RequestView | null }[];
      }
    ).orders;

    const row = orders.find((o) => o.salesOrderId === order.id);
    // `pendingPartialRequest` means "awaiting an answer", not "has ever been
    // asked" — the answered one is on the detail page's history instead.
    expect(row!.pendingPartialRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  MOOT — the question stopping applying
// ---------------------------------------------------------------------------

describe('when the rest of the order becomes ready', () => {
  it('resolves the open question to MOOT', async () => {
    const thali = await makeRsProduct({ title: 'zz-test-thali-moot' });
    const cooker = await makeRsProduct({ title: 'zz-test-cooker-moot' });

    const order = await makeOrder([
      { id: thali.id, quantity: 5 },
      { id: cooker.id, quantity: 2 },
    ]);
    await procureAndAllocate(thali.id, order.lineIds[0]!, 5);

    const { request } = await raise(dispatcherToken, order.id);
    expect(request!.status).toBe('PENDING');

    // The cookers arrive. Procurement's reconciliation is what notices.
    await procureAndAllocate(cooker.id, order.lineIds[1]!, 2);

    const after = await prisma.partialDispatchRequest.findUnique({
      where: { id: request!.id },
      select: {
        status: true,
        decidedAt: true,
        decidedById: true,
        reason: true,
        poa: true,
        autoDecided: true,
      },
    });

    expect(after!.status).toBe('MOOT');
    // Resolved and timestamped, with no fabricated human decision attached.
    expect(after!.decidedAt).not.toBeNull();
    expect(after!.decidedById).toBeNull();
    expect(after!.reason).toBeNull();
    expect(after!.poa).toBeNull();
    expect(after!.autoDecided).toBe(false);
  });

  it('tells nobody — nothing was decided and nobody needs to act', async () => {
    const thali = await makeRsProduct({ title: 'zz-test-thali-moot-quiet' });
    const cooker = await makeRsProduct({ title: 'zz-test-cooker-moot-quiet' });

    const order = await makeOrder([
      { id: thali.id, quantity: 5 },
      { id: cooker.id, quantity: 2 },
    ]);
    await procureAndAllocate(thali.id, order.lineIds[0]!, 5);
    const { request } = await raise(dispatcherToken, order.id);

    const before = await prisma.notification.count({ where: { entityId: request!.id } });
    await procureAndAllocate(cooker.id, order.lineIds[1]!, 2);
    const after = await prisma.notification.count({ where: { entityId: request!.id } });

    expect(after).toBe(before);
  });

  it('leaves an already-decided request exactly as it was', async () => {
    const thali = await makeRsProduct({ title: 'zz-test-thali-decided' });
    const cooker = await makeRsProduct({ title: 'zz-test-cooker-decided' });

    const order = await makeOrder([
      { id: thali.id, quantity: 5 },
      { id: cooker.id, quantity: 2 },
    ]);
    await procureAndAllocate(thali.id, order.lineIds[0]!, 5);

    const { request } = await raise(dispatcherToken, order.id);
    await decide(procurerToken, request!.id, {
      decision: 'ALLOW',
      reason: 'Send the thalis now',
    });

    // The cookers arriving afterwards must not rewrite a decision somebody made.
    await procureAndAllocate(cooker.id, order.lineIds[1]!, 2);

    const after = await prisma.partialDispatchRequest.findUnique({
      where: { id: request!.id },
      select: { status: true, reason: true, decidedById: true },
    });

    expect(after!.status).toBe('ALLOWED');
    expect(after!.reason).toBe('Send the thalis now');
    expect(after!.decidedById).toBe(procurer.id);
  });
});
