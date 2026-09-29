/**
 * Test debris must not land in a real person's notification bell.
 *
 * Partial-dispatch notices go to everyone holding PROCUREMENT:ASSIGN, which in
 * this database means real administrators. `Notification.entityId` carries no
 * foreign key, so a notice about a request is NOT removed when the request is —
 * and `PartialDispatchRequest` cascades from its sales order, so a test run
 * that created one left a notice behind pointing at an id that no longer
 * resolves, in a colleague's inbox.
 *
 * This suite proves the fixture closes that, and — just as importantly — that
 * it closes it *narrowly*: a notice the run did not cause is never touched,
 * whatever its type.
 *
 * The suite deliberately works on real notification rows rather than mocks.
 * Mocking the deletion would test the mock, and the bug being fixed was
 * precisely about which rows a real DELETE matches.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from './helpers/test-server.js';
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
} from './helpers/fixtures.js';

let admin: TestUser;
let dispatcher: TestUser;
let adminToken: string;
let dispatcherToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

/** A notice about an entity this suite invented, standing in for real data. */
const CONTROL_ENTITY = 'zz-control-entity-not-a-real-request';

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  dispatcher = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  dispatcherToken = await mintToken(dispatcher.id, { role: 'USER' });

  vendor = await makeVendor();
  customer = await makeCustomer('RETAIL', {
    phone: '+91 90000 11111',
    address: '9 Foundry Lane, Moradabad',
  });

  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: dispatcher.id,
      module: 'PACKING_DISPATCH' as const,
      action,
      allowed: true,
    })),
  });
});

afterAll(async () => {
  await stopTestServer();
});

/** A partly ready order: thalis procured, cookers not. */
async function partiallyReadyOrder(): Promise<string> {
  const thali = await makeRsProduct({ title: 'zz-test-thali-cleanup' });
  const cooker = await makeRsProduct({ title: 'zz-test-cooker-cleanup' });

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

  const order = (res.body.data as { order: { id: string; items: { id: string }[] } }).order;
  trackSalesOrder(order.id);
  await mapOrderLineToRsProduct(order.items[0]!.id, thali.id);
  await mapOrderLineToRsProduct(order.items[1]!.id, cooker.id);

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

  return order.id;
}

// ---------------------------------------------------------------------------

describe('notices raised by a test partial-dispatch request', () => {
  it('are removed by cleanup, while everything else is left alone', async () => {
    /*
      A control row first, standing in for a real notice about real work. It
      names a PartialDispatchRequest entity that this suite never created, so
      any cleanup matching on type alone — or on entityType alone — takes it,
      and the assertion below catches that.

      Addressed to a REAL administrator, not a fixture user, and that detail is
      load-bearing: `Notification.recipient` cascades on user delete, so a
      control owned by a fixture user would vanish when that user is removed and
      the assertion would fail for a reason having nothing to do with the
      cleanup being tested. The row is removed again at the end of the test.
    */
    const realAdmin = await prisma.user.findFirst({
      where: { role: 'ADMIN', name: { not: { startsWith: 'zz-test' } } },
      select: { id: true },
    });
    expect(realAdmin, 'this test needs one real administrator to address a control notice to')
      .not.toBeNull();

    // Upsert, not create: Notification has a unique
    // (recipientId, type, entityId), so a control row left behind by an
    // interrupted run would otherwise make this suite un-runnable.
    await prisma.notification.upsert({
      where: {
        recipientId_type_entityId: {
          recipientId: realAdmin!.id,
          type: 'PARTIAL_DISPATCH_REQUESTED',
          entityId: CONTROL_ENTITY,
        },
      },
      update: {},
      create: {
        recipientId: realAdmin!.id,
        type: 'PARTIAL_DISPATCH_REQUESTED',
        title: 'zz-control notice',
        body: 'Stands in for a real notice about real work',
        href: '/dispatch',
        entityType: 'PartialDispatchRequest',
        entityId: CONTROL_ENTITY,
      },
    });

    /*
      A second control, and a deliberately careful one.

      SALES_ORDER_CREATED rows are the orphan shape this database is already
      full of — tens of thousands of them, pointing at orders long deleted. The
      fix under test must not touch a single one.

      What it must NOT assert is that the total is unchanged: creating a test
      sales order below RAISES more of these notices to real procurement users,
      because `salesOrderCreatedDraft` resolves real recipients exactly as
      `partialDispatchDeciders` does. That is a separate leak of the same family,
      pre-existing and out of scope here. So the check is on the rows that
      existed BEFORE this test — every one of them must still be there.
    */
    const preExistingSalesOrderNotices = await prisma.notification.findMany({
      where: { type: 'SALES_ORDER_CREATED' },
      select: { id: true },
      // A bounded sample, not all 34k: an `IN` over every id would exceed
      // Postgres's 32,767 bind-variable ceiling. The cleanup either filters by
      // entityType and entityId or it does not — a sample of a thousand rows
      // would catch a query that matched the wrong thing just as surely as all
      // of them, and the total is checked separately below.
      take: 1000,
      orderBy: { createdAt: 'asc' },
    });
    const preExistingIds = preExistingSalesOrderNotices.map((n) => n.id);
    const preExistingTotal = await prisma.notification.count({
      where: { type: 'SALES_ORDER_CREATED' },
    });

    const salesOrderId = await partiallyReadyOrder();

    const raised = await api('POST', '/api/dispatch/partial-requests', {
      token: dispatcherToken,
      body: { salesOrderId },
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const requestId = (raised.body.data as { request: { id: string } }).request.id;

    /*
      The leak, demonstrated before it is fixed: the notice went to real people.
      `partialDispatchDeciders` resolves PROCUREMENT:ASSIGN, and this suite
      granted that to nobody — so every recipient is somebody who already had
      it, which in this database means real administrators.
    */
    const notices = await prisma.notification.findMany({
      where: { entityType: 'PartialDispatchRequest', entityId: requestId },
      select: { recipientId: true },
    });
    expect(notices.length).toBeGreaterThan(0);

    const fixtureUserIds = new Set([admin.id, dispatcher.id]);
    const realRecipients = notices.filter((n) => !fixtureUserIds.has(n.recipientId));
    expect(
      realRecipients.length,
      'the notice reached at least one non-fixture user — this is the leak being fixed',
    ).toBeGreaterThan(0);

    // ---- the fix -------------------------------------------------------

    await cleanup();

    // Every notice about THIS request is gone, including the ones addressed to
    // real administrators.
    expect(
      await prisma.notification.count({
        where: { entityType: 'PartialDispatchRequest', entityId: requestId },
      }),
    ).toBe(0);

    // The request itself went with its order, as it always did.
    expect(await prisma.partialDispatchRequest.count({ where: { id: requestId } })).toBe(0);

    // The control notice survives. It is the same type and the same entityType
    // as the debris; only its entityId differs, which is exactly the distinction
    // the cleanup has to make.
    const control = await prisma.notification.findFirst({
      where: { entityId: CONTROL_ENTITY },
      select: { id: true },
    });
    expect(control, 'a notice this run did not cause must survive cleanup').not.toBeNull();

    /*
      And every pre-existing orphan is still exactly where it was. Counted by
      id rather than by total, so this stays true regardless of how many new
      notices the test's own order creation raised.
    */
    const survivors = await prisma.notification.count({
      where: { id: { in: preExistingIds } },
    });
    expect(survivors, 'the pre-existing orphans must not be touched').toBe(preExistingIds.length);

    // And none of them was removed in bulk: the population only ever grows,
    // because this fix deletes nothing of this type.
    const afterTotal = await prisma.notification.count({
      where: { type: 'SALES_ORDER_CREATED' },
    });
    expect(afterTotal).toBeGreaterThanOrEqual(preExistingTotal);

    // Tidy the control row this test created; nothing else is ours to remove.
    await prisma.notification.deleteMany({ where: { entityId: CONTROL_ENTITY } });
  });

  it('is idempotent — cleanup can run again and finds nothing left', async () => {
    /*
      Runs after the test above, whose cleanup already ran. A second pass must
      be a no-op rather than an error: teardown is called from suites that are
      themselves failing, and a cleanup that threw on an empty database would
      turn one failure into two.
    */
    await expect(cleanup()).resolves.toBeUndefined();

    // And the audit agrees, including the stranded-notice check the fix added.
    expect(await residualTestRows()).toBe(0);
  });
});
