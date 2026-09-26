/**
 * What a change request may do to a line that already holds purchased stock.
 *
 * Allocation is the one place Sales and Procurement actually meet. A
 * PurchaseAllocation names a bill line and an order line, and creating one
 * takes the goods out of free CRM stock in the same transaction — so two
 * changes to the order line would quietly unmake work Procurement has already
 * done and accounted for:
 *
 *   MOVING the line to a different RS Product leaves the allocation standing
 *   against goods the order no longer asks for. `createAllocation` refuses to
 *   create such a pair in the first place; nothing stopped one being made
 *   afterwards.
 *
 *   REMOVING the line deletes it, and PurchaseAllocation.salesOrderItem is
 *   onDelete: Cascade, so the allocations go with it — without Procurement's
 *   reconcile ever running. PurchaseBillItem.stockedQty then still claims
 *   stock that is committed to nobody, and CRM stock under-reports the goods
 *   that were just released, which reads as a shortage and buys them again.
 *
 * Procurement already refuses the mirror-image move on its own side, twice, and
 * says why: "Stock has been allocated from this line since the request was
 * raised. Release it before approving." These are the other half of that rule.
 *
 * The refusal is deliberate in place of reconciling here. Releasing an
 * allocation is Procurement's own operation and already restores the stock
 * exactly once — doing the arithmetic in Sales would put a second writer on a
 * figure whose whole design rests on having one.
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
  editRequestPayload,
  makeCustomer,
  makeRsProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  removeRequestPayload,
  residualTestRows,
  salesOrderPayload,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let author: TestUser;
let reviewer: TestUser;
let authorToken: string;
let reviewerToken: string;
let customer: { id: string; name: string };
let vendor: { id: string; name: string };

/** Two products, so a remap has somewhere to go. */
let productA: { id: string; title: string; variantId: string };
let productB: { id: string; title: string; variantId: string };

beforeAll(async () => {
  await startTestServer();
  // Two people, because a request may not be decided by whoever filed it.
  author = await makeUser('ADMIN');
  reviewer = await makeUser('ADMIN');
  authorToken = await mintToken(author.id, { role: 'ADMIN' });
  reviewerToken = await mintToken(reviewer.id, { role: 'ADMIN' });
  customer = await makeCustomer();
  vendor = await makeVendor();
  productA = await makeRsProduct({ crmStockQty: 0 });
  productB = await makeRsProduct({ crmStockQty: 0 });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers — the shortest route to "an order line with stock allocated to it"
// ---------------------------------------------------------------------------

type OrderBody = { order: { id: string; orderId: string; items: { id: string }[] } };

/** An order of `lines` lines, each mapped to the given product. */
async function makeOrder(
  lines: { rsProductId?: string; quantity: number }[],
): Promise<{ orderId: string; lineIds: string[] }> {
  const res = await api('POST', '/api/sales', {
    token: authorToken,
    body: salesOrderPayload(customer.id, {
      items: lines.map((line, i) => ({
        productName: `zz-test line ${i + 1}`,
        ...(line.rsProductId ? { rsProductId: line.rsProductId } : {}),
        quantity: line.quantity,
        price: '100.00',
      })),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const order = (res.body.data as OrderBody).order;
  trackSalesOrder(order.id);
  return { orderId: order.id, lineIds: order.items.map((i) => i.id) };
}

/** An approved bill for `product`, fully received, ready to allocate from. */
async function makeApprovedBill(
  productId: string,
  received: number,
): Promise<{ billId: string; itemId: string }> {
  const res = await api('POST', '/api/procurement/bills', {
    token: authorToken,
    body: purchaseBillPayload(vendor.id, productId, {
      items: [
        {
          productName: 'zz-test purchase',
          rsProductId: productId,
          orderedQty: received,
          receivedQty: received,
          rate: '10.00',
        },
      ],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const bill = (res.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  // Allocation needs a signed-off bill; that rule has its own suite.
  await approvePurchaseBill(bill.id);
  return { billId: bill.id, itemId: bill.items[0]!.id };
}

const allocate = (
  billId: string,
  itemId: string,
  salesOrderItemId: string,
  quantity: number,
): ReturnType<typeof api> =>
  api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
    token: authorToken,
    body: { salesOrderItemId, quantity },
  });

const fileRequest = (orderId: string, body: Record<string, unknown>): ReturnType<typeof api> =>
  api('POST', `/api/sales/${orderId}/change-requests`, { token: authorToken, body });

const approveRequest = (orderId: string, requestId: string): ReturnType<typeof api> =>
  api('POST', `/api/sales/${orderId}/change-requests/${requestId}/approve`, {
    token: reviewerToken,
    body: {},
  });

/** The id of the one request an order is carrying. */
async function pendingRequestId(orderId: string): Promise<string> {
  const row = await prisma.salesItemChangeRequest.findFirst({
    where: { orderId, status: 'PENDING' },
    select: { id: true },
  });
  expect(row, 'a pending request should exist').not.toBeNull();
  return row!.id;
}

const crmStock = async (rsProductId: string): Promise<number> => {
  const rows = await prisma.shopifyVariant.findMany({
    where: { rsProductId },
    select: { crmStockQty: true },
  });
  return rows.reduce((sum, v) => sum + v.crmStockQty, 0);
};

const allocationsOn = (salesOrderItemId: string): Promise<number> =>
  prisma.purchaseAllocation.count({ where: { salesOrderItemId } });

/** An order line with `quantity` units allocated to it from an approved bill. */
async function allocatedLine(
  productId: string,
  quantity: number,
  extraLines: { rsProductId?: string; quantity: number }[] = [],
): Promise<{ orderId: string; lineId: string; lineIds: string[] }> {
  const { orderId, lineIds } = await makeOrder([
    { rsProductId: productId, quantity },
    ...extraLines,
  ]);
  const bill = await makeApprovedBill(productId, quantity);

  const res = await allocate(bill.billId, bill.itemId, lineIds[0]!, quantity);
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  return { orderId, lineId: lineIds[0]!, lineIds };
}

// ===========================================================================
//  1 — moving an allocated line to a different RS Product
// ===========================================================================

describe('re-mapping a line that holds purchased stock', () => {
  it('is refused when the request is filed', async () => {
    const { orderId, lineId } = await allocatedLine(productA.id, 2);

    const res = await fileRequest(
      orderId,
      editRequestPayload(lineId, { rsProductId: productB.id }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');
  });

  it('records no request and moves nothing when it is refused', async () => {
    const { orderId, lineId } = await allocatedLine(productA.id, 2);
    const stockBefore = await crmStock(productA.id);

    await fileRequest(orderId, editRequestPayload(lineId, { rsProductId: productB.id }));

    expect(await prisma.salesItemChangeRequest.count({ where: { orderId } })).toBe(0);
    expect(await allocationsOn(lineId)).toBe(1);
    expect(await crmStock(productA.id)).toBe(stockBefore);

    const line = await prisma.salesOrderItem.findUnique({
      where: { id: lineId },
      select: { rsProductId: true },
    });
    expect(line!.rsProductId).toBe(productA.id);
  });

  it('is refused at APPROVAL too, when the stock arrives while the request waits', async () => {
    /*
      The authoritative half. The line is unallocated when the request is
      filed, so the filing check has nothing to object to — and Procurement
      then commits stock to it. Procurement re-checks its own mirror of this at
      the moment of the write for exactly this reason.
    */
    const { orderId, lineIds } = await makeOrder([{ rsProductId: productA.id, quantity: 2 }]);
    const lineId = lineIds[0]!;

    const filed = await fileRequest(
      orderId,
      editRequestPayload(lineId, { rsProductId: productB.id }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const bill = await makeApprovedBill(productA.id, 2);
    const allocated = await allocate(bill.billId, bill.itemId, lineId, 2);
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));

    expect(decided.status, JSON.stringify(decided.body)).toBe(409);
    expect(decided.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');

    // The request is still open, and the line still names the product its
    // stock was bought against.
    const after = await prisma.salesOrderItem.findUnique({
      where: { id: lineId },
      select: { rsProductId: true },
    });
    expect(after!.rsProductId).toBe(productA.id);
    expect(await allocationsOn(lineId)).toBe(1);
  });
});

describe('editing a line that holds purchased stock, without moving it', () => {
  it('still allows a name, quantity and price change', async () => {
    // The guard is about product identity. Everything else about an allocated
    // line remains as editable as it was.
    const { orderId, lineId } = await allocatedLine(productA.id, 2);

    const filed = await fileRequest(
      orderId,
      editRequestPayload(lineId, { productName: 'zz-test renamed', quantity: 5 }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const line = await prisma.salesOrderItem.findUnique({
      where: { id: lineId },
      select: { productName: true, quantity: true, rsProductId: true },
    });
    expect(line!.productName).toBe('zz-test renamed');
    expect(line!.quantity).toBe(5);
    // Unchanged, and not unmapped by an edit that said nothing about it.
    expect(line!.rsProductId).toBe(productA.id);
  });

  it('still allows an edit that restates the product the line already has', async () => {
    const { orderId, lineId } = await allocatedLine(productA.id, 2);

    const filed = await fileRequest(
      orderId,
      editRequestPayload(lineId, { rsProductId: productA.id }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  });
});

describe('re-mapping a line with no allocations', () => {
  it('works exactly as it did', async () => {
    const { orderId, lineIds } = await makeOrder([{ rsProductId: productA.id, quantity: 2 }]);
    const lineId = lineIds[0]!;

    const filed = await fileRequest(
      orderId,
      editRequestPayload(lineId, { rsProductId: productB.id }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const line = await prisma.salesOrderItem.findUnique({
      where: { id: lineId },
      select: { rsProductId: true },
    });
    expect(line!.rsProductId).toBe(productB.id);
  });

  it('works for a line that was never mapped at all', async () => {
    // Free text mapped to the catalogue for the first time — the case the
    // guard must not catch, since an unmapped line can hold no allocation.
    const { orderId, lineIds } = await makeOrder([{ quantity: 2 }]);
    const lineId = lineIds[0]!;

    const filed = await fileRequest(
      orderId,
      editRequestPayload(lineId, { rsProductId: productB.id }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const line = await prisma.salesOrderItem.findUnique({
      where: { id: lineId },
      select: { rsProductId: true },
    });
    expect(line!.rsProductId).toBe(productB.id);
  });
});

// ===========================================================================
//  2 — removing an allocated line
// ===========================================================================

describe('removing a line that holds purchased stock', () => {
  it('is refused when the request is filed', async () => {
    const { orderId, lineId } = await allocatedLine(productA.id, 2, [{ quantity: 1 }]);

    const res = await fileRequest(orderId, removeRequestPayload(lineId));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');
  });

  it('is refused at APPROVAL too, when the stock arrives while the request waits', async () => {
    const { orderId, lineIds } = await makeOrder([
      { rsProductId: productA.id, quantity: 2 },
      { quantity: 1 },
    ]);
    const lineId = lineIds[0]!;

    const filed = await fileRequest(orderId, removeRequestPayload(lineId));
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const bill = await makeApprovedBill(productA.id, 2);
    expect((await allocate(bill.billId, bill.itemId, lineId, 2)).status).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));

    expect(decided.status, JSON.stringify(decided.body)).toBe(409);
    expect(decided.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');
  });

  it('leaves the allocation, the line and CRM stock exactly as they were', async () => {
    /*
      The whole point. A cascade would have taken the allocation row with the
      line and left PurchaseBillItem.stockedQty claiming stock that is
      committed to nobody — so this asserts the ledger on both sides, not just
      that the request was refused.
    */
    const { orderId, lineId } = await allocatedLine(productA.id, 3, [{ quantity: 1 }]);

    const stockBefore = await crmStock(productA.id);
    const stockedBefore = await prisma.purchaseBillItem.findMany({
      where: { allocations: { some: { salesOrderItemId: lineId } } },
      select: { id: true, stockedQty: true, receivedQty: true },
    });

    await fileRequest(orderId, removeRequestPayload(lineId));

    expect(await prisma.salesOrderItem.count({ where: { id: lineId } })).toBe(1);
    expect(await allocationsOn(lineId)).toBe(1);
    expect(await crmStock(productA.id)).toBe(stockBefore);

    for (const line of stockedBefore) {
      const now = await prisma.purchaseBillItem.findUnique({
        where: { id: line.id },
        select: { stockedQty: true },
      });
      expect(now!.stockedQty).toBe(line.stockedQty);
      // received − allocated, which is the rule the figure is meant to hold.
      expect(now!.stockedQty).toBe(line.receivedQty - 3);
    }
  });
});

describe('removing a line with no allocations', () => {
  it('works exactly as it did', async () => {
    const { orderId, lineIds } = await makeOrder([
      { rsProductId: productA.id, quantity: 2 },
      { quantity: 1 },
    ]);
    const lineId = lineIds[1]!;

    const filed = await fileRequest(orderId, removeRequestPayload(lineId));
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    expect(await prisma.salesOrderItem.count({ where: { id: lineId } })).toBe(0);
  });

  it('still refuses to remove the last line, for the reason it always did', async () => {
    // Proving the new guard did not replace the old one.
    const { orderId, lineIds } = await makeOrder([{ rsProductId: productA.id, quantity: 2 }]);

    const filed = await fileRequest(orderId, removeRequestPayload(lineIds[0]!));
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const decided = await approveRequest(orderId, await pendingRequestId(orderId));
    expect(decided.status, JSON.stringify(decided.body)).toBe(409);
    expect(decided.body.code).toBe('LAST_ACTIVE_ITEM');
  });
});

// ===========================================================================
//  3 — the guard is the backend's, not the browser's
// ===========================================================================

describe('the refusal is server-side', () => {
  it('holds against a direct API call by an administrator', async () => {
    // No UI sends rsProductId on an edit at all, so the API is the only way
    // this is reachable — and the only place it can be stopped.
    const { orderId, lineId } = await allocatedLine(productA.id, 2);

    const res = await api('POST', `/api/sales/${orderId}/change-requests`, {
      token: reviewerToken,
      body: { type: 'EDIT', itemId: lineId, productName: 'zz-test direct', rsProductId: productB.id, quantity: 2, price: '100.00' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('ORDER_LINE_HAS_ALLOCATIONS');
  });
});
