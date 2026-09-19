/**
 * Purchased goods becoming CRM stock, and being consumed by requirements.
 *
 * The model under test, stated once:
 *
 *     target = approved && mapped ? receivedQty − Σ allocations : 0
 *     delta  = target − stockedQty
 *
 * Which is to say: an approved bill contributes its SURPLUS — what arrived,
 * minus what is already committed to a customer — and every later event moves
 * stock by the difference rather than by a remembered amount.
 *
 * Most of these tests exist to prove the arithmetic cannot be applied twice.
 * Double-counting is the failure mode that matters here: it is silent, it
 * compounds, and by the time anyone notices, the hand-maintained counts in RS
 * Products have been wrong for weeks with no record of when they diverged.
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

let recorder: TestUser;
let approver: TestUser;
let recorderToken: string;
let approverToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  // Two people, because a bill cannot be approved by whoever recorded it.
  recorder = await makeUser('USER');
  approver = await makeUser('ADMIN');
  recorderToken = await mintToken(recorder.id, { role: 'USER' });
  approverToken = await mintToken(approver.id, { role: 'ADMIN' });
  vendor = await makeVendor();
  customer = await makeCustomer();

  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: recorder.id,
      module: 'PROCUREMENT' as const,
      action,
      allowed: true,
    })),
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/**
 * The product-level CRM stock figure — the sum across variants, which is the
 * same aggregate `crmStockOf` computes and the API reports. Read from the
 * database rather than from a response, so a test cannot pass because a
 * projection happened to look right.
 */
async function crmStock(rsProductId: string): Promise<number> {
  const rows = await prisma.shopifyVariant.findMany({
    where: { rsProductId },
    select: { crmStockQty: true },
  });
  return rows.reduce((sum, v) => sum + v.crmStockQty, 0);
}

/** Shopify's own count, which nothing in Procurement may ever touch. */
async function shopifyQty(rsProductId: string): Promise<number> {
  const rows = await prisma.shopifyVariant.findMany({
    where: { rsProductId },
    select: { inventoryQty: true },
  });
  return rows.reduce((sum, v) => sum + v.inventoryQty, 0);
}

type Bill = { id: string; items: { id: string }[] };

/** A bill for one product, recorded (and so PENDING) with `received` units. */
async function recordBill(rsProductId: string, ordered: number, received: number): Promise<Bill> {
  const res = await api('POST', '/api/procurement/bills', {
    token: recorderToken,
    body: purchaseBillPayload(vendor.id, rsProductId, {
      items: [
        {
          productName: 'zz-test stock line',
          rsProductId,
          orderedQty: ordered,
          receivedQty: received,
          rate: '10.00',
        },
      ],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const bill = (res.body.data as { bill: Bill }).bill;
  trackPurchaseBill(bill.id);
  return bill;
}

/** An order line for the product, so allocation has a requirement to fill. */
async function requirement(rsProductId: string, quantity: number): Promise<string> {
  const res = await api('POST', '/api/sales', {
    token: approverToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test req', quantity, price: '100.00' }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = (res.body.data as { order: { id: string; items: { id: string }[] } }).order;
  trackSalesOrder(order.id);
  await mapOrderLineToRsProduct(order.items[0]!.id, rsProductId);
  return order.items[0]!.id;
}

const approve = (billId: string) =>
  api('POST', `/api/procurement/bills/${billId}/approve`, { token: approverToken, body: {} });

const reject = (billId: string) =>
  api('POST', `/api/procurement/bills/${billId}/reject`, {
    token: approverToken,
    body: { note: 'Not these goods.' },
  });

const allocate = (billId: string, itemId: string, salesOrderItemId: string, quantity: number) =>
  api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
    token: approverToken,
    body: { salesOrderItemId, quantity },
  });

const receive = (billId: string, itemId: string, receivedQty: number) =>
  api('POST', `/api/procurement/bills/${billId}/items/${itemId}/receive`, {
    token: recorderToken,
    body: { receivedQty },
  });

// ===========================================================================
//  Inbound — approval is the only door into CRM stock
// ===========================================================================

describe('a bill that is not approved contributes nothing', () => {
  it('1 — recording and receiving a pending bill leaves CRM stock alone', async () => {
    const rs = await makeRsProduct({ crmStockQty: 2 });
    const bill = await recordBill(rs.id, 10, 5);

    expect(await crmStock(rs.id)).toBe(2);

    // Receiving more, still unapproved: goods have arrived but nobody has said
    // the bill is trustworthy, so they are not stock yet.
    expect((await receive(bill.id, bill.items[0]!.id, 8)).status).toBe(200);
    expect(await crmStock(rs.id)).toBe(2);
  });

  it('2 — a rejected bill contributes nothing, ever', async () => {
    const rs = await makeRsProduct({ crmStockQty: 2 });
    const bill = await recordBill(rs.id, 10, 5);

    expect((await reject(bill.id)).status).toBe(200);
    expect(await crmStock(rs.id)).toBe(2);

    // And a later receipt on a rejected bill still moves nothing.
    await receive(bill.id, bill.items[0]!.id, 9);
    expect(await crmStock(rs.id)).toBe(2);
  });
});

describe('approval credits the surplus, not the whole receipt', () => {
  it('3 — received 5 with 1 already committed adds 4', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    const lineId = await requirement(rs.id, 1);

    /*
      The commitment is made before approval. Allocation from an unapproved
      bill is refused, so the requirement is tied to the line by allocating
      after approval would defeat the test — instead the allocation row is
      created directly, which is what "already committed at approval time"
      means in the business rule.
    */
    await prisma.purchaseAllocation.create({
      data: {
        purchaseBillItemId: bill.items[0]!.id,
        salesOrderItemId: lineId,
        quantity: 1,
        allocatedById: approver.id,
      },
    });

    expect((await approve(bill.id)).status).toBe(200);

    // 5 received − 1 committed = 4 free.
    expect(await crmStock(rs.id)).toBe(4);
  });

  it('4 — received 5 with nothing committed adds 5', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);

    expect((await approve(bill.id)).status).toBe(200);
    expect(await crmStock(rs.id)).toBe(5);
  });

  it('adds to whatever was already counted by hand, rather than replacing it', async () => {
    // RS Products owns this number; procurement contributes to it and never
    // overwrites what somebody counted.
    const rs = await makeRsProduct({ crmStockQty: 7 });
    const bill = await recordBill(rs.id, 3, 3);

    await approve(bill.id);
    expect(await crmStock(rs.id)).toBe(10);
  });

  it('5 — a further receipt credits only the new units', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 10, 5);

    await approve(bill.id);
    expect(await crmStock(rs.id)).toBe(5);

    // The failure this guards: adding the cumulative receivedQty again, which
    // would leave 12 instead of 7.
    expect((await receive(bill.id, bill.items[0]!.id, 7)).status).toBe(200);
    expect(await crmStock(rs.id)).toBe(7);
  });

  it('gives stock back when a receipt is corrected downwards', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 10, 8);

    await approve(bill.id);
    expect(await crmStock(rs.id)).toBe(8);

    await receive(bill.id, bill.items[0]!.id, 6);
    expect(await crmStock(rs.id)).toBe(6);
  });
});

// ===========================================================================
//  Outbound — allocation consumes stock
// ===========================================================================

describe('allocation consumes CRM stock exactly once', () => {
  it('6 — stock 5, allocate 3, stock 2', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);
    expect(await crmStock(rs.id)).toBe(5);

    const lineId = await requirement(rs.id, 3);
    expect((await allocate(bill.id, bill.items[0]!.id, lineId, 3)).status).toBe(201);

    expect(await crmStock(rs.id)).toBe(2);
  });

  it('7 — cannot allocate beyond what the line actually holds', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);

    const lineId = await requirement(rs.id, 9);
    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 9);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_STANDING');
    // Nothing moved on a refused allocation.
    expect(await crmStock(rs.id)).toBe(5);
  });

  it('never drives a product below what was counted by hand', async () => {
    // A line can only ever take back what it itself contributed, so procurement
    // cannot push the figure below its pre-existing value.
    const rs = await makeRsProduct({ crmStockQty: 4 });
    const bill = await recordBill(rs.id, 2, 2);
    await approve(bill.id);
    expect(await crmStock(rs.id)).toBe(6);

    const lineId = await requirement(rs.id, 2);
    await allocate(bill.id, bill.items[0]!.id, lineId, 2);

    expect(await crmStock(rs.id)).toBe(4);
  });

  it('8 — releasing an allocation restores the stock exactly once', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);

    const lineId = await requirement(rs.id, 3);
    const created = await allocate(bill.id, bill.items[0]!.id, lineId, 3);
    expect(created.status).toBe(201);
    expect(await crmStock(rs.id)).toBe(2);

    const allocation = await prisma.purchaseAllocation.findFirstOrThrow({
      where: { purchaseBillItemId: bill.items[0]!.id, salesOrderItemId: lineId },
      select: { id: true },
    });

    const released = await api(
      'PATCH',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations/${allocation.id}`,
      { token: approverToken, body: { quantity: 0 } },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);

    expect(await crmStock(rs.id)).toBe(5);
  });

  it('moves stock the other way when an allocation is reduced', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);

    const lineId = await requirement(rs.id, 4);
    await allocate(bill.id, bill.items[0]!.id, lineId, 4);
    expect(await crmStock(rs.id)).toBe(1);

    const allocation = await prisma.purchaseAllocation.findFirstOrThrow({
      where: { purchaseBillItemId: bill.items[0]!.id, salesOrderItemId: lineId },
      select: { id: true },
    });
    await api(
      'PATCH',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations/${allocation.id}`,
      { token: approverToken, body: { quantity: 1 } },
    );

    // 5 received − 1 committed = 4 free.
    expect(await crmStock(rs.id)).toBe(4);
  });

  it('10 — two concurrent allocations cannot spend the same stock twice', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);

    const a = await requirement(rs.id, 4);
    const b = await requirement(rs.id, 4);

    // Together they ask for 8 against 5 available. The row lock serialises them,
    // so one succeeds and the other is refused against the remaining headroom.
    const [first, second] = await Promise.all([
      allocate(bill.id, bill.items[0]!.id, a, 4),
      allocate(bill.id, bill.items[0]!.id, b, 4),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(400);

    // Exactly one allocation's worth left, never negative and never double-spent.
    expect(await crmStock(rs.id)).toBe(1);
  });
});

// ===========================================================================
//  Dispatch, and the boundaries
// ===========================================================================

describe('dispatch does not deduct again', () => {
  it('9 — CRM stock is unchanged by dispatching an allocated order', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const bill = await recordBill(rs.id, 5, 5);
    await approve(bill.id);

    const res = await api('POST', '/api/sales', {
      token: approverToken,
      body: salesOrderPayload(customer.id, {
        items: [{ productName: 'zz-test req', quantity: 3, price: '100.00' }],
      }),
    });
    const order = (res.body.data as { order: { id: string; items: { id: string }[] } }).order;
    trackSalesOrder(order.id);
    await mapOrderLineToRsProduct(order.items[0]!.id, rs.id);

    await allocate(bill.id, bill.items[0]!.id, order.items[0]!.id, 3);
    const afterAllocation = await crmStock(rs.id);
    expect(afterAllocation).toBe(2);

    const dispatched = await api('POST', `/api/sales/${order.id}/dispatch`, {
      token: approverToken,
      body: {},
    });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);

    // The goods were taken out of stock when they were committed. Taking them
    // out again at dispatch would be the same units counted twice.
    expect(await crmStock(rs.id)).toBe(afterAllocation);
  });
});

describe('the boundaries of the stock model', () => {
  it('12 — Shopify inventoryQty is never touched', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0, inventoryQty: 42 });
    const bill = await recordBill(rs.id, 5, 5);

    await approve(bill.id);
    const lineId = await requirement(rs.id, 2);
    await allocate(bill.id, bill.items[0]!.id, lineId, 2);

    // CRM stock moved through the whole flow; Shopify's count did not.
    expect(await crmStock(rs.id)).toBe(3);
    expect(await shopifyQty(rs.id)).toBe(42);
  });

  it('an unmapped line holds no stock, and holds none once mapped to nothing', async () => {
    const res = await api('POST', '/api/procurement/bills', {
      token: recorderToken,
      body: purchaseBillPayload(vendor.id, '', {
        items: [{ productName: 'zz-test unmapped', orderedQty: 4, receivedQty: 4, rate: '10.00' }],
      }),
    });
    expect(res.status).toBe(201);
    const bill = (res.body.data as { bill: Bill }).bill;
    trackPurchaseBill(bill.id);

    // Approving a bill whose line names no product must not fail, and must not
    // invent somewhere to put the goods.
    expect((await approve(bill.id)).status).toBe(200);

    const stored = await prisma.purchaseBillItem.findUniqueOrThrow({
      where: { id: bill.items[0]!.id },
      select: { stockedQty: true },
    });
    expect(stored.stockedQty).toBe(0);
  });

  it('credits an approved bill the moment an unmapped line is given its product', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0 });
    const res = await api('POST', '/api/procurement/bills', {
      token: recorderToken,
      body: purchaseBillPayload(vendor.id, '', {
        items: [{ productName: 'zz-test late map', orderedQty: 6, receivedQty: 6, rate: '10.00' }],
      }),
    });
    const bill = (res.body.data as { bill: Bill }).bill;
    trackPurchaseBill(bill.id);
    await approve(bill.id);

    expect(await crmStock(rs.id)).toBe(0);

    const mapped = await api(
      'POST',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/rs-product`,
      { token: recorderToken, body: { rsProductId: rs.id } },
    );
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);

    expect(await crmStock(rs.id)).toBe(6);
  });
});

// ===========================================================================
//  What Procurement displays is what is stored
// ===========================================================================

describe('11 — Requirement vs Stock reports the stored figure', () => {
  it('shows the same CRM stock the database holds, after the flow has run', async () => {
    const rs = await makeRsProduct({ crmStockQty: 0, inventoryQty: 99 });
    const bill = await recordBill(rs.id, 10, 10);
    await approve(bill.id);

    // A requirement larger than stock, so the row qualifies for the board.
    const lineId = await requirement(rs.id, 14);
    await allocate(bill.id, bill.items[0]!.id, lineId, 4);

    const stored = await crmStock(rs.id);
    expect(stored).toBe(6);

    const res = await api('GET', '/api/procurement/shortages', { token: approverToken });
    const rows = (res.body.data as {
      shortages: { rsProduct: { id: string } | null; crmStockQty: number | null; rsStockQty: number | null }[];
    }).shortages;
    const row = rows.find((r) => r.rsProduct?.id === rs.id);

    expect(row, 'the product should appear on the board').toBeDefined();
    // One source of truth: the board reports the stored figure, not a second
    // computation that could drift from it.
    expect(row!.crmStockQty).toBe(stored);
    // And RS stock stays its own separate number.
    expect(row!.rsStockQty).toBe(99);
  });
});
