/**
 * Purchase & Procurement — bills, inventory, allocation and the freeze rule.
 *
 * The two quantities this module exists to compute are easy to state and easy
 * to get subtly wrong, so they are tested from both directions: standing
 * quantity as stock arrives and is assigned, and pending quantity as a
 * requirement is met from inventory and from purchases. The concurrency case
 * at the end is the one that matters most — it is the only test that can catch
 * two people spending the same stock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  linkOrderLineToProduct,
  makeCustomer,
  makeProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  setInventory,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let user: TestUser;
let adminToken: string;
let userToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  user = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  userToken = await mintToken(user.id, { role: 'USER' });
  vendor = await makeVendor();
  customer = await makeCustomer();

  // PROCUREMENT is denied to USER by default, so the module tests grant it
  // explicitly — exercising the same override rows an administrator writes.
  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: user.id,
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

/** An order with one line for `product`, linked to the catalogue. */
async function makeLinkedOrder(
  productId: string,
  quantity: number,
): Promise<{ orderId: string; orderNumber: string; lineId: string }> {
  const payload = salesOrderPayload(customer.id, {
    items: [{ productName: 'zz-test-line', quantity, price: '100.00' }],
  });
  const res = await api('POST', '/api/sales', { token: adminToken, body: payload });
  expect(res.status).toBe(201);

  const order = (res.body.data as { order: { id: string; orderId: string; items: { id: string }[] } }).order;
  trackSalesOrder(order.id);
  await linkOrderLineToProduct(order.items[0]!.id, productId);

  return { orderId: order.id, orderNumber: order.orderId, lineId: order.items[0]!.id };
}

async function makeBill(
  productId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ billId: string; itemId: string }> {
  const res = await api('POST', '/api/procurement/bills', {
    token: adminToken,
    body: purchaseBillPayload(vendor.id, productId, overrides),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);

  const bill = (res.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  return { billId: bill.id, itemId: bill.items[0]!.id };
}

// ---------------------------------------------------------------------------

describe('products and inventory', () => {
  it('creates a product with an opening stock level', async () => {
    const res = await api('POST', '/api/procurement/products', {
      token: adminToken,
      body: { name: `zz-test-product-${Date.now()}`, onHand: 12 },
    });

    expect(res.status).toBe(201);
    const product = (res.body.data as { product: { id: string; onHand: number } }).product;
    expect(product.onHand).toBe(12);
    await prisma.inventoryItem.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('refuses a duplicate product name', async () => {
    const existing = await makeProduct();
    const res = await api('POST', '/api/procurement/products', {
      token: adminToken,
      body: { name: existing.name },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRODUCT_EXISTS');
  });

  it('adjusts stock by a signed delta', async () => {
    const product = await makeProduct(10);

    const up = await api('POST', `/api/procurement/products/${product.id}/inventory`, {
      token: adminToken,
      body: { delta: 5, reason: 'stock count' },
    });
    expect((up.body.data as { product: { onHand: number } }).product.onHand).toBe(15);

    const down = await api('POST', `/api/procurement/products/${product.id}/inventory`, {
      token: adminToken,
      body: { delta: -3, reason: 'breakage' },
    });
    expect((down.body.data as { product: { onHand: number } }).product.onHand).toBe(12);
  });

  it('refuses an adjustment that would drive stock negative', async () => {
    const product = await makeProduct(2);
    const res = await api('POST', `/api/procurement/products/${product.id}/inventory`, {
      token: adminToken,
      body: { delta: -5, reason: 'too much' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
  });
});

describe('purchase bills', () => {
  it('creates a bill with several lines', async () => {
    const [a, b] = [await makeProduct(), await makeProduct()];
    const { billId } = await makeBill(a.id, {
      items: [
        { productName: 'zz-test-line', productId: a.id, orderedQty: 10, receivedQty: 10, rate: '100.00' },
        { productName: 'zz-test-line', productId: b.id, orderedQty: 5, receivedQty: 0, rate: '250.50' },
      ],
    });

    const res = await api('GET', `/api/procurement/bills/${billId}`, { token: adminToken });
    const bill = (res.body.data as { bill: { items: unknown[]; billTotal: string; status: string } }).bill;
    expect(bill.items).toHaveLength(2);
    // Only received stock counts toward the bill's value.
    expect(bill.billTotal).toBe('1000.00');
    expect(bill.status).toBe('OPEN');
  });

  it('supports several vendors against one shortage, as separate bills', async () => {
    const product = await makeProduct();
    const second = await makeVendor();

    const one = await makeBill(product.id);
    const two = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: purchaseBillPayload(second.id, product.id),
    });
    expect(two.status).toBe(201);
    trackPurchaseBill((two.body.data as { bill: { id: string } }).bill.id);

    const list = await api('GET', '/api/procurement/bills?limit=50', { token: adminToken });
    const ids = (list.body.data as { bills: { id: string }[] }).bills.map((b) => b.id);
    expect(ids).toContain(one.billId);
  });

  it('refuses the same bill number twice from one vendor', async () => {
    const product = await makeProduct();
    const payload = purchaseBillPayload(vendor.id, product.id);

    const first = await api('POST', '/api/procurement/bills', { token: adminToken, body: payload });
    expect(first.status).toBe(201);
    trackPurchaseBill((first.body.data as { bill: { id: string } }).bill.id);

    const second = await api('POST', '/api/procurement/bills', { token: adminToken, body: payload });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('BILL_NUMBER_EXISTS');
  });

  it('refuses receiving more than was ordered', async () => {
    const product = await makeProduct();
    const { billId, itemId } = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 5, receivedQty: 0, rate: '10.00' }],
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/receive`, {
      token: adminToken,
      body: { receivedQty: 9 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RECEIVED_EXCEEDS_ORDERED');
  });

  it('records a delay with its reason, and refuses one without', async () => {
    const product = await makeProduct();
    const { billId } = await makeBill(product.id);

    const bad = await api('POST', `/api/procurement/bills/${billId}/delay`, {
      token: adminToken,
      body: { reason: '   ' },
    });
    expect(bad.status).toBe(422);

    const good = await api('POST', `/api/procurement/bills/${billId}/delay`, {
      token: adminToken,
      body: { reason: 'Vendor shipment held at depot' },
    });
    expect(good.status).toBe(200);
    const bill = (good.body.data as { bill: { isDelayed: boolean; delayReason: string } }).bill;
    expect(bill.isDelayed).toBe(true);
    expect(bill.delayReason).toBe('Vendor shipment held at depot');
  });
});

describe('order requirements and shortage', () => {
  it('reports 6 required, 4 already fulfilled, 2 pending', async () => {
    // Fulfilment is per line now. Warehouse stock is shared across orders, so
    // it is reported but never counted against one customer's requirement.
    const product = await makeProduct(4);
    const { orderNumber, lineId } = await makeLinkedOrder(product.id, 6);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken,
      body: { alreadyFulfilled: 4 },
    });

    const res = await api(
      'GET',
      `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderNumber)}`,
      { token: adminToken },
    );

    expect(res.status).toBe(200);
    const line = (res.body.data as { order: { lines: {
      requiredQty: number; alreadyFulfilled: number; availableInInventory: number;
      totalFulfilled: number; pendingQty: number; status: string;
    }[] } }).order.lines[0]!;

    expect(line.requiredQty).toBe(6);
    expect(line.alreadyFulfilled).toBe(4);
    expect(line.totalFulfilled).toBe(4);
    expect(line.pendingQty).toBe(2);
    expect(line.status).toBe('PARTIAL');
    // Stock is shown, but it did not fulfil anything.
    expect(line.availableInInventory).toBe(4);
  });

  it('reports nothing pending once the line is fully fulfilled by hand', async () => {
    const product = await makeProduct(5);
    const { orderNumber, lineId } = await makeLinkedOrder(product.id, 1);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 1 },
    });

    const res = await api('GET', `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderNumber)}`, {
      token: adminToken,
    });
    const line = (res.body.data as { order: { lines: { pendingQty: number; status: string; frozen: boolean }[] } })
      .order.lines[0]!;

    expect(line.pendingQty).toBe(0);
    expect(line.status).toBe('FULFILLED');
    expect(line.frozen).toBe(true);
  });

  it('surfaces a line with no catalogue product rather than hiding it', async () => {
    // Exactly the shape of the historical order that predates the master.
    const payload = salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test-unlinked', quantity: 3, price: '10.00' }],
    });
    const created = await api('POST', '/api/sales', { token: adminToken, body: payload });
    const order = (created.body.data as { order: { id: string; orderId: string } }).order;
    trackSalesOrder(order.id);

    const res = await api('GET', `/api/procurement/order-requirements?orderId=${encodeURIComponent(order.orderId)}`, {
      token: adminToken,
    });
    const line = (res.body.data as { order: { lines: { linked: boolean; productId: string | null }[] } })
      .order.lines[0]!;

    expect(line.linked).toBe(false);
    expect(line.productId).toBeNull();
  });

  it('404s for an unknown order number', async () => {
    const res = await api('GET', '/api/procurement/order-requirements?orderId=NOPE-999', {
      token: adminToken,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ORDER_NOT_FOUND');
  });
});

describe('allocation', () => {
  it('allocates purchased stock and reduces both standing and pending', async () => {
    const product = await makeProduct(0);
    const { orderNumber, lineId } = await makeLinkedOrder(product.id, 6);
    const { billId, itemId } = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 10, receivedQty: 10, rate: '50.00' }],
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 6 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const item = (res.body.data as { bill: { items: { standingQty: number; allocatedQty: number }[] } })
      .bill.items[0]!;
    expect(item.allocatedQty).toBe(6);
    expect(item.standingQty).toBe(4);

    const after = await api('GET', `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderNumber)}`, {
      token: adminToken,
    });
    const line = (after.body.data as { order: { lines: { pendingQty: number; status: string }[] } }).order.lines[0]!;
    expect(line.pendingQty).toBe(0);
    expect(line.status).toBe('FULFILLED');
  });

  it('serves several customers from one purchase, leaving the rest standing', async () => {
    const product = await makeProduct(0);
    const { billId, itemId } = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 20, receivedQty: 20, rate: '10.00' }],
    });

    // The brief's example: 6 + 4 + 5 allocated out of 20 leaves 5 standing.
    for (const qty of [6, 4, 5]) {
      const { lineId } = await makeLinkedOrder(product.id, qty);
      const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
        token: adminToken,
        body: { salesOrderItemId: lineId, quantity: qty },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const res = await api('GET', `/api/procurement/bills/${billId}`, { token: adminToken });
    const item = (res.body.data as { bill: { items: { standingQty: number; allocations: unknown[] }[] } })
      .bill.items[0]!;
    expect(item.standingQty).toBe(5);
    expect(item.allocations).toHaveLength(3);
  });

  it('fills one order line from two different bills', async () => {
    const product = await makeProduct(0);
    const { orderNumber, lineId } = await makeLinkedOrder(product.id, 8);

    const first = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 5, receivedQty: 5, rate: '10.00' }],
    });
    const secondVendor = await makeVendor();
    const secondRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: purchaseBillPayload(secondVendor.id, product.id, {
        items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 3, receivedQty: 3, rate: '11.00' }],
      }),
    });
    const secondBill = (secondRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(secondBill.id);

    await api('POST', `/api/procurement/bills/${first.billId}/items/${first.itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 5 },
    });
    await api('POST', `/api/procurement/bills/${secondBill.id}/items/${secondBill.items[0]!.id}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });

    const after = await api('GET', `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderNumber)}`, {
      token: adminToken,
    });
    const line = (after.body.data as { order: { lines: { allocatedQty: number; pendingQty: number }[] } })
      .order.lines[0]!;
    expect(line.allocatedQty).toBe(8);
    expect(line.pendingQty).toBe(0);
  });

  it('refuses to allocate more than the line still needs', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeLinkedOrder(product.id, 2);
    const { billId, itemId } = await makeBill(product.id);

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_PENDING');
  });

  it('refuses to allocate more than the purchase has standing', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeLinkedOrder(product.id, 50);
    const { billId, itemId } = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 10, receivedQty: 3, rate: '10.00' }],
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_STANDING');
  });

  it('refuses to allocate stock for a different product', async () => {
    const [a, b] = [await makeProduct(0), await makeProduct(0)];
    const { lineId } = await makeLinkedOrder(a.id, 5);
    const { billId, itemId } = await makeBill(b.id);

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_MISMATCH');
  });

  it('refuses to allocate to a line with no catalogue product', async () => {
    const product = await makeProduct(0);
    const payload = salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test-unlinked-alloc', quantity: 3, price: '10.00' }],
    });
    const created = await api('POST', '/api/sales', { token: adminToken, body: payload });
    const order = (created.body.data as { order: { id: string; items: { id: string }[] } }).order;
    trackSalesOrder(order.id);

    const { billId, itemId } = await makeBill(product.id);
    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: order.items[0]!.id, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_LINE_NOT_LINKED');
  });

  it('releases an allocation, returning the stock to standing', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeLinkedOrder(product.id, 4);
    const { billId, itemId } = await makeBill(product.id);

    const created = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });
    const allocationId = (created.body.data as { bill: { items: { allocations: { id: string }[] }[] } })
      .bill.items[0]!.allocations[0]!.id;

    const released = await api(
      'PATCH',
      `/api/procurement/bills/${billId}/items/${itemId}/allocations/${allocationId}`,
      { token: adminToken, body: { quantity: 0 } },
    );
    expect(released.status).toBe(200);

    const item = (released.body.data as { bill: { items: { standingQty: number; allocations: unknown[] }[] } })
      .bill.items[0]!;
    expect(item.allocations).toHaveLength(0);
    expect(item.standingQty).toBe(10);
  });
});

describe('the freeze rule', () => {
  it('refuses a USER changing an allocation on a fulfilled line, and lets an ADMIN', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeLinkedOrder(product.id, 4);
    const { billId, itemId } = await makeBill(product.id);

    // Fill the line completely — it is now frozen for USER.
    const created = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 4 },
    });
    const allocationId = (created.body.data as { bill: { items: { allocations: { id: string }[] }[] } })
      .bill.items[0]!.allocations[0]!.id;

    const asUser = await api(
      'PATCH',
      `/api/procurement/bills/${billId}/items/${itemId}/allocations/${allocationId}`,
      { token: userToken, body: { quantity: 2 } },
    );
    expect(asUser.status).toBe(403);

    const asAdmin = await api(
      'PATCH',
      `/api/procurement/bills/${billId}/items/${itemId}/allocations/${allocationId}`,
      { token: adminToken, body: { quantity: 2 } },
    );
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
  });

  it('lets a USER allocate freely while the line is still pending', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeLinkedOrder(product.id, 10);
    const { billId, itemId } = await makeBill(product.id);

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: userToken, body: { salesOrderItemId: lineId, quantity: 2 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('refuses a USER allocating onto an already fulfilled line', async () => {
    const product = await makeProduct(5);
    const { lineId } = await makeLinkedOrder(product.id, 5);
    const { billId, itemId } = await makeBill(product.id);

    // Recorded fulfilment alone already covers the requirement.
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 5 },
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: userToken, body: { salesOrderItemId: lineId, quantity: 1 },
    });
    expect(res.status).toBe(403);
  });
});

describe('authorization', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await api('GET', '/api/procurement/bills')).status).toBe(401);
  });

  it('refuses a USER without the PROCUREMENT module', async () => {
    const outsider = await makeUser('USER');
    const token = await mintToken(outsider.id, { role: 'USER' });

    for (const [method, path] of [
      ['GET', '/api/procurement/bills'],
      ['GET', '/api/procurement/products'],
      ['GET', '/api/procurement/shortages'],
    ] as const) {
      const res = await api(method, path, { token });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('refuses a USER creating a product without CREATE', async () => {
    const outsider = await makeUser('USER');
    const token = await mintToken(outsider.id, { role: 'USER' });
    const res = await api('POST', '/api/procurement/products', {
      token, body: { name: 'zz-test-denied' },
    });
    expect(res.status).toBe(403);
  });
});

describe('concurrency', () => {
  it('never over-allocates a purchase line under parallel requests', async () => {
    const product = await makeProduct(0);
    const { billId, itemId } = await makeBill(product.id, {
      items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 4, receivedQty: 4, rate: '10.00' }],
    });

    // Six orders, each wanting 2, against 4 units of standing stock. At most
    // two can win; the rest must be refused rather than silently sharing.
    const lines = await Promise.all(
      Array.from({ length: 6 }, () => makeLinkedOrder(product.id, 2).then((o) => o.lineId)),
    );

    const results = await Promise.all(
      lines.map((lineId) =>
        api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
          token: adminToken,
          body: { salesOrderItemId: lineId, quantity: 2 },
        }),
      ),
    );

    const statuses = results.map((r) => r.status);
    // A transient infrastructure failure should report itself plainly rather
    // than looking like an allocation bug.
    expect(results.filter((r) => r.status >= 500), `statuses: ${statuses}`).toHaveLength(0);
    expect(results.filter((r) => r.status === 201), `statuses: ${statuses}`).toHaveLength(2);

    // The guarantee that survives regardless of interleaving: the ledger never
    // hands out more than arrived.
    const item = await prisma.purchaseBillItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { receivedQty: true, allocations: { select: { quantity: true } } },
    });
    const allocated = item.allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(allocated).toBeLessThanOrEqual(item.receivedQty);
    expect(allocated).toBe(4);
  });

  it('never over-fills one order line from two bills at once', async () => {
    const product = await makeProduct(0);
    const { orderNumber, lineId } = await makeLinkedOrder(product.id, 3);

    const bills = await Promise.all([
      makeBill(product.id, { items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 3, receivedQty: 3, rate: '10.00' }] }),
      (async () => {
        const v = await makeVendor();
        const res = await api('POST', '/api/procurement/bills', {
          token: adminToken,
          body: purchaseBillPayload(v.id, product.id, {
            items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: 3, receivedQty: 3, rate: '10.00' }],
          }),
        });
        const bill = (res.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
        trackPurchaseBill(bill.id);
        return { billId: bill.id, itemId: bill.items[0]!.id };
      })(),
    ]);

    const results = await Promise.all(
      bills.map((b) =>
        api('POST', `/api/procurement/bills/${b.billId}/items/${b.itemId}/allocations`, {
          token: adminToken,
          body: { salesOrderItemId: lineId, quantity: 3 },
        }),
      ),
    );

    const statuses = results.map((r) => r.status);
    expect(results.filter((r) => r.status >= 500), `statuses: ${statuses}`).toHaveLength(0);

    // Whatever the interleaving, the line cannot end up over-filled.
    const after = await api('GET', `/api/procurement/order-requirements?orderId=${encodeURIComponent(orderNumber)}`, {
      token: adminToken,
    });
    const line = (after.body.data as { order: { lines: { allocatedQty: number; requiredQty: number }[] } })
      .order.lines[0]!;
    expect(line.allocatedQty).toBeLessThanOrEqual(line.requiredQty);
  });
});
