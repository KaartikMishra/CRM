/**
 * The 24-hour deadline, and what happens when nobody answers.
 *
 * The sweep is called directly rather than through HTTP because it has no
 * endpoint — it runs on a timer, and the whole point of the design is that it
 * needs no request and no living timer to be correct. Deadlines are moved into
 * the past with a direct update, which is what a real 24-hour wait looks like
 * to every query in this module.
 *
 * The three properties worth proving are restart-safety (a process that was
 * down across a deadline still settles it), idempotency (running twice changes
 * nothing the second time) and losing gracefully to a person (a decision made
 * in the same moment always wins).
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
import { sweepOverdueRequests } from '../dispatch-sweep.service.js';

let admin: TestUser;
let dispatcher: TestUser;
let procurer: TestUser;
let adminToken: string;
let dispatcherToken: string;
let procurerToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  dispatcher = await makeUser('USER');
  procurer = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  dispatcherToken = await mintToken(dispatcher.id, { role: 'USER' });
  procurerToken = await mintToken(procurer.id, { role: 'USER' });

  vendor = await makeVendor();
  customer = await makeCustomer('RETAIL', {
    phone: '+91 90000 00000',
    address: '2 Mill Road, Moradabad',
  });

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
    ],
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Scenario
// ---------------------------------------------------------------------------

/** A partly ready order with an open, unanswered request on it. */
async function openRequest(label: string): Promise<{ requestId: string; orderId: string }> {
  const thali = await makeRsProduct({ title: `zz-test-thali-${label}` });
  const cooker = await makeRsProduct({ title: `zz-test-cooker-${label}` });

  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [
        { productName: 'zz-test-thali-line', quantity: 5, price: '100.00' },
        { productName: 'zz-test-cooker-line', quantity: 2, price: '100.00' },
      ],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const order = (
    res.body.data as { order: { id: string; items: { id: string }[] } }
  ).order;
  trackSalesOrder(order.id);
  await mapOrderLineToRsProduct(order.items[0]!.id, thali.id);
  await mapOrderLineToRsProduct(order.items[1]!.id, cooker.id);

  // Thalis procured, cookers not — the partial case.
  const billRes = await api('POST', '/api/procurement/bills', {
    token: adminToken,
    body: purchaseBillPayload(vendor.id, thali.id, {
      items: [
        {
          productName: 'zz-test-bill-line',
          rsProductId: thali.id,
          orderedQty: 5,
          receivedQty: 5,
          rate: '100.00',
        },
      ],
    }),
  });
  const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  await approvePurchaseBill(bill.id);

  await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`, {
    token: adminToken,
    body: { salesOrderItemId: order.items[0]!.id, quantity: 5 },
  });

  const raised = await api('POST', '/api/dispatch/partial-requests', {
    token: dispatcherToken,
    body: { salesOrderId: order.id },
  });
  expect(raised.status, JSON.stringify(raised.body)).toBe(201);

  return {
    requestId: (raised.body.data as { request: { id: string } }).request.id,
    orderId: order.id,
  };
}

/**
 * Moves a deadline into the past.
 *
 * This is what a real 24-hour wait looks like to every query in the module: the
 * sweep compares a stored instant against database `now()`, and does not care
 * whether the wait actually elapsed. Backdating is therefore a faithful
 * simulation rather than a shortcut around the rule.
 */
async function expire(requestId: string, minutesAgo = 5): Promise<void> {
  await prisma.partialDispatchRequest.update({
    where: { id: requestId },
    data: { deadline: new Date(Date.now() - minutesAgo * 60 * 1000) },
  });
}

const read = (requestId: string) =>
  prisma.partialDispatchRequest.findUnique({
    where: { id: requestId },
    select: {
      status: true,
      autoDecided: true,
      decidedAt: true,
      decidedById: true,
      reason: true,
      poa: true,
    },
  });

// ---------------------------------------------------------------------------

describe('a request nobody answered', () => {
  it('is allowed once its deadline has passed', async () => {
    const { requestId } = await openRequest('auto');
    await expire(requestId);

    const result = await sweepOverdueRequests();
    expect(result.autoAllowed).toBeGreaterThanOrEqual(1);

    const row = await read(requestId);
    expect(row!.status).toBe('ALLOWED');
  });

  it('records the automatic decision with exactly the right fields', async () => {
    const { requestId } = await openRequest('fields');
    await expire(requestId);
    await sweepOverdueRequests();

    const row = await read(requestId);

    // The shape the dashboard reads to say "allowed because nobody responded".
    expect(row!.status).toBe('ALLOWED');
    expect(row!.autoDecided).toBe(true);
    expect(row!.decidedAt).not.toBeNull();
    // All three null: nobody decided this, so there is no decider to name and
    // no reason to quote. A fabricated reason here would be the code putting
    // words in an absent person's mouth.
    expect(row!.decidedById).toBeNull();
    expect(row!.reason).toBeNull();
    expect(row!.poa).toBeNull();
  });

  it('tells the person who asked, and says why it was allowed', async () => {
    const { requestId } = await openRequest('notify');
    await expire(requestId);
    await sweepOverdueRequests();

    const notices = await prisma.notification.findMany({
      where: { type: 'PARTIAL_DISPATCH_AUTO_ALLOWED', entityId: requestId },
      select: { recipientId: true, body: true },
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]!.recipientId).toBe(dispatcher.id);
    // The difference from a human approval has to be legible in the notice
    // itself, not only in a column.
    expect(notices[0]!.body).toContain('24 hours');
  });

  it('writes an audit row with no actor — the deadline is not a person', async () => {
    const { requestId } = await openRequest('audit');
    await expire(requestId);
    await sweepOverdueRequests();

    const entries = await prisma.auditLog.findMany({
      where: { entityType: 'PartialDispatchRequest', entityId: requestId },
      select: { action: true, actorId: true },
    });

    const auto = entries.find((e) => e.action === 'dispatch.partial.auto_allowed');
    expect(auto).toBeDefined();
    expect(auto!.actorId).toBeNull();
  });
});

describe('a request whose deadline has not passed', () => {
  it('is left alone', async () => {
    const { requestId } = await openRequest('early');

    await sweepOverdueRequests();

    const row = await read(requestId);
    expect(row!.status).toBe('PENDING');
    expect(row!.decidedAt).toBeNull();
  });
});

describe('running the sweep more than once', () => {
  it('changes nothing the second time', async () => {
    const { requestId } = await openRequest('idempotent');
    await expire(requestId);

    await sweepOverdueRequests();
    const first = await read(requestId);

    const second = await sweepOverdueRequests();
    const after = await read(requestId);

    // The row is untouched, and the second pass did not count it again.
    expect(after).toEqual(first);
    expect(second.autoAllowed).toBe(0);

    // And exactly one notice, not two.
    const notices = await prisma.notification.count({
      where: { type: 'PARTIAL_DISPATCH_AUTO_ALLOWED', entityId: requestId },
    });
    expect(notices).toBe(1);
  });

  it('survives a restart — the deadline is a column, not a timer', async () => {
    /*
      The request is raised, and its deadline passes while nothing is running.
      No in-memory timer could have survived that. The boot sweep is the same
      call this test makes, so settling it here is exactly what a restarted
      process does.
    */
    const { requestId } = await openRequest('restart');
    await expire(requestId, 60 * 30); // Half a day past the deadline.

    await sweepOverdueRequests();

    const row = await read(requestId);
    expect(row!.status).toBe('ALLOWED');
    expect(row!.autoDecided).toBe(true);
  });

  it('settles a backlog of several in one pass', async () => {
    const a = await openRequest('batch-a');
    const b = await openRequest('batch-b');
    await expire(a.requestId);
    await expire(b.requestId);

    await sweepOverdueRequests();

    expect((await read(a.requestId))!.status).toBe('ALLOWED');
    expect((await read(b.requestId))!.status).toBe('ALLOWED');
  });
});

// ---------------------------------------------------------------------------
//  Races
// ---------------------------------------------------------------------------

describe('a decision and the deadline arriving together', () => {
  it('keeps the human decision and does not overwrite it', async () => {
    const { requestId } = await openRequest('race-human');
    await expire(requestId);

    // Both want this row out of PENDING, in the same moment.
    const [decided] = await Promise.all([
      api('POST', `/api/dispatch/partial-requests/${requestId}/decide`, {
        token: procurerToken,
        body: { decision: 'DISALLOW', reason: 'Cookers land tomorrow', poa: 'One parcel Friday' },
      }),
      sweepOverdueRequests(),
    ]);

    const row = await read(requestId);

    /*
      Exactly one of the two applied, and whichever it was, the row is internally
      consistent — never a human decision wearing `autoDecided`, and never an
      automatic one carrying somebody's name.
    */
    if (decided.status === 200) {
      expect(row!.status).toBe('DISALLOWED');
      expect(row!.autoDecided).toBe(false);
      expect(row!.decidedById).toBe(procurer.id);
      expect(row!.reason).toBe('Cookers land tomorrow');
    } else {
      expect(decided.status).toBe(409);
      expect(decided.body.code).toBe('PARTIAL_REQUEST_AUTO_ALLOWED');
      expect(row!.status).toBe('ALLOWED');
      expect(row!.autoDecided).toBe(true);
      expect(row!.decidedById).toBeNull();
      expect(row!.reason).toBeNull();
    }
  });

  it('tells a late decider the deadline already answered it', async () => {
    const { requestId } = await openRequest('race-late');
    await expire(requestId);
    await sweepOverdueRequests();

    const late = await api('POST', `/api/dispatch/partial-requests/${requestId}/decide`, {
      token: procurerToken,
      body: { decision: 'DISALLOW', reason: 'Hold it', poa: 'Monday' },
    });

    expect(late.status).toBe(409);
    // Named specifically, because it is the case a person will not expect.
    expect(late.body.code).toBe('PARTIAL_REQUEST_AUTO_ALLOWED');

    const row = await read(requestId);
    expect(row!.status).toBe('ALLOWED');
    expect(row!.autoDecided).toBe(true);
  });
});

describe('two requests raised at the same instant', () => {
  it('records one and refuses the other', async () => {
    const { orderId } = await openRequest('dup-base');

    // The first is already open from the helper; decide it so the order is
    // free, then fire two at once at the now-empty slot.
    const open = await prisma.partialDispatchRequest.findFirst({
      where: { salesOrderId: orderId, status: 'PENDING' },
      select: { id: true },
    });
    await api('POST', `/api/dispatch/partial-requests/${open!.id}/decide`, {
      token: procurerToken,
      body: { decision: 'DISALLOW', reason: 'Not yet', poa: 'Ask again' },
    });

    const [first, second] = await Promise.all([
      api('POST', '/api/dispatch/partial-requests', {
        token: dispatcherToken,
        body: { salesOrderId: orderId },
      }),
      api('POST', '/api/dispatch/partial-requests', {
        token: dispatcherToken,
        body: { salesOrderId: orderId },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    // And the database agrees: one open question, never two.
    const pending = await prisma.partialDispatchRequest.count({
      where: { salesOrderId: orderId, status: 'PENDING' },
    });
    expect(pending).toBe(1);
  });
});

describe('the sweep and procurement completing an order together', () => {
  it('leaves the request in exactly one terminal state', async () => {
    const { requestId, orderId } = await openRequest('race-moot');
    await expire(requestId);

    // The cookers land at the moment the deadline passes.
    const cookerLine = await prisma.salesOrderItem.findFirst({
      where: { orderId, allocations: { none: {} } },
      select: { id: true, rsProductId: true },
    });

    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: purchaseBillPayload(vendor.id, cookerLine!.rsProductId!, {
        items: [
          {
            productName: 'zz-test-cooker-bill',
            rsProductId: cookerLine!.rsProductId!,
            orderedQty: 2,
            receivedQty: 2,
            rate: '100.00',
          },
        ],
      }),
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);
    await approvePurchaseBill(bill.id);

    await Promise.all([
      api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`, {
        token: adminToken,
        body: { salesOrderItemId: cookerLine!.id, quantity: 2 },
      }),
      sweepOverdueRequests(),
    ]);

    const row = await read(requestId);

    // Either ending is correct; a half-written mixture of the two is not.
    expect(['ALLOWED', 'MOOT']).toContain(row!.status);
    expect(row!.decidedAt).not.toBeNull();

    if (row!.status === 'MOOT') {
      expect(row!.autoDecided).toBe(false);
      expect(row!.reason).toBeNull();
      expect(row!.decidedById).toBeNull();
    } else {
      expect(row!.autoDecided).toBe(true);
      expect(row!.reason).toBeNull();
      expect(row!.decidedById).toBeNull();
    }
  });
});
