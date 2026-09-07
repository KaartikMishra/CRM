/**
 * Linking order lines to the Product master.
 *
 * Procurement matches purchased stock to a requirement by product *identity*,
 * never by name — "Bottle" and "bottle " are otherwise the same requirement or
 * two different ones depending on who typed them. That makes the catalogue
 * link load-bearing, and these cover both ways a line acquires one: supplied
 * when the order is written, or attached afterwards for a line that predates
 * the master.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  makeCustomer,
  makeProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let procurementUser: TestUser;
let outsider: TestUser;
let adminToken: string;
let procurementToken: string;
let outsiderToken: string;
let customer: { id: string; name: string };
let vendor: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  procurementUser = await makeUser('USER');
  outsider = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  procurementToken = await mintToken(procurementUser.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });
  customer = await makeCustomer();
  vendor = await makeVendor();

  // PROCUREMENT is denied to USER by default; grant it the way an
  // administrator would, through override rows.
  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: procurementUser.id,
      module: 'PROCUREMENT' as const,
      action,
      allowed: true,
    })),
  });
  // The outsider gets SALES only, so they can create orders but never link.
  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
      userId: outsider.id,
      module: 'PROCUREMENT' as const,
      action,
      allowed: false,
    })),
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function createOrder(
  items: Record<string, unknown>[],
  token = adminToken,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await api('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customer.id, { items }),
  });
  const order = (res.body.data as { order?: { id: string } } | undefined)?.order;
  if (order?.id) trackSalesOrder(order.id);
  return res as { status: number; body: Record<string, unknown> };
}

type OrderBody = { order: { id: string; orderId: string; items: { id: string; productName: string }[] } };

// ---------------------------------------------------------------------------
//  Sales: supplying a catalogue link at creation
// ---------------------------------------------------------------------------

describe('Sales accepts an optional catalogue link', () => {
  it('persists productId when the line supplies one', async () => {
    const product = await makeProduct(0);
    const res = await createOrder([
      { productName: product.name, productId: product.id, quantity: 4, price: '100.00' },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = (res.body.data as OrderBody).order.items[0]!;
    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: line.id },
      select: { productId: true, productName: true },
    });
    expect(row.productId).toBe(product.id);
    expect(row.productName).toBe(product.name);
  });

  it('still accepts a line with no productId — free text is unchanged', async () => {
    const res = await createOrder([
      { productName: 'zz-test-freetext-item', quantity: 2, price: '50.00' },
    ]);

    expect(res.status).toBe(201);
    const line = (res.body.data as OrderBody).order.items[0]!;
    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: line.id },
      select: { productId: true },
    });
    expect(row.productId).toBeNull();
  });

  it('rejects a malformed productId', async () => {
    const res = await createOrder([
      { productName: 'zz-test-bad-id', productId: 'not-a-cuid', quantity: 1, price: '10.00' },
    ]);
    expect(res.status).toBe(422);
  });

  it('rejects a productId that does not exist', async () => {
    const res = await createOrder([
      { productName: 'zz-test-ghost', productId: 'cmt0000000000000000000000', quantity: 1, price: '10.00' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects a productId for an inactive product', async () => {
    const product = await makeProduct(0);
    await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });

    const res = await createOrder([
      { productName: product.name, productId: product.id, quantity: 1, price: '10.00' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_NOT_FOUND');

    await prisma.product.update({ where: { id: product.id }, data: { isActive: true } });
  });
});

// ---------------------------------------------------------------------------
//  Procurement: linking a line that has none
// ---------------------------------------------------------------------------

describe('linking an existing unlinked line', () => {
  /** An order line with no catalogue entry, and a bill holding stock for it. */
  async function scenario(quantity = 10, received = 10) {
    const product = await makeProduct(0);
    const created = await createOrder([
      { productName: product.name, quantity, price: '100.00' },
    ]);
    const order = (created.body.data as OrderBody).order;

    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: purchaseBillPayload(vendor.id, product.id, {
        items: [{ productName: 'zz-test-line', productId: product.id, orderedQty: received, receivedQty: received, rate: '10.00' }],
      }),
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);

    return { product, order, lineId: order.items[0]!.id, billId: bill.id, itemId: bill.items[0]!.id };
  }

  it('reports an unlinked line as not in the catalogue', async () => {
    const { order } = await scenario();
    const res = await api(
      'GET',
      `/api/procurement/order-requirements?orderId=${encodeURIComponent(order.orderId)}`,
      { token: adminToken },
    );
    const line = (res.body.data as { order: { lines: { linked: boolean; productId: string | null }[] } })
      .order.lines[0]!;
    expect(line.linked).toBe(false);
    expect(line.productId).toBeNull();
  });

  it('links the line and leaves everything else untouched', async () => {
    const { product, lineId } = await scenario();
    const before = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: lineId },
      select: { productName: true, quantity: true, price: true, status: true },
    });

    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, productId: product.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: lineId },
      select: { productId: true, productName: true, quantity: true, price: true, status: true },
    });
    expect(after.productId).toBe(product.id);
    // The order's own record of what was agreed must be identical.
    expect(after.productName).toBe(before.productName);
    expect(after.quantity).toBe(before.quantity);
    expect(after.price.toFixed(2)).toBe(before.price.toFixed(2));
    expect(after.status).toBe(before.status);
  });

  it('makes the line allocatable, and the full flow then balances', async () => {
    const { product, order, lineId, billId, itemId } = await scenario(10, 10);

    await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, productId: product.id },
    });

    const alloc = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 10 },
    });
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);

    const item = (alloc.body.data as { bill: { items: { standingQty: number; allocatedQty: number }[] } })
      .bill.items[0]!;
    expect(item.allocatedQty).toBe(10);
    expect(item.standingQty).toBe(0);

    const after = await api(
      'GET',
      `/api/procurement/order-requirements?orderId=${encodeURIComponent(order.orderId)}`,
      { token: adminToken },
    );
    const line = (after.body.data as { order: { lines: {
      linked: boolean; allocatedQty: number; pendingQty: number; status: string;
    }[] } }).order.lines[0]!;
    expect(line.linked).toBe(true);
    expect(line.allocatedQty).toBe(10);
    expect(line.pendingQty).toBe(0);
    expect(line.status).toBe('FULFILLED');
  });

  it('still refuses to over-allocate after linking', async () => {
    const { product, lineId, billId, itemId } = await scenario(3, 10);
    await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, productId: product.id },
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_PENDING');
  });

  it('refuses to relink a line that already has a product', async () => {
    const { product, lineId } = await scenario();
    await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken, body: { salesOrderItemId: lineId, productId: product.id },
    });

    const other = await makeProduct(0);
    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken, body: { salesOrderItemId: lineId, productId: other.id },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_LINE_ALREADY_LINKED');
  });

  it('refuses an unknown or inactive product', async () => {
    const { lineId } = await scenario();

    const ghost = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, productId: 'cmt0000000000000000000000' },
    });
    expect(ghost.status).toBe(404);

    const retired = await makeProduct(0);
    await prisma.product.update({ where: { id: retired.id }, data: { isActive: false } });
    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken, body: { salesOrderItemId: lineId, productId: retired.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_INACTIVE');
    await prisma.product.update({ where: { id: retired.id }, data: { isActive: true } });
  });
});

describe('authorization on linking', () => {
  async function unlinkedLine(): Promise<{ productId: string; lineId: string }> {
    const product = await makeProduct(0);
    const created = await createOrder([
      { productName: product.name, quantity: 2, price: '10.00' },
    ]);
    const order = (created.body.data as OrderBody).order;
    return { productId: product.id, lineId: order.items[0]!.id };
  }

  it('refuses an unauthenticated request', async () => {
    const { productId, lineId } = await unlinkedLine();
    const res = await api('POST', '/api/procurement/order-lines/link', {
      body: { salesOrderItemId: lineId, productId },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a USER without the PROCUREMENT module', async () => {
    const { productId, lineId } = await unlinkedLine();
    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: outsiderToken, body: { salesOrderItemId: lineId, productId },
    });
    expect(res.status).toBe(403);

    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: lineId }, select: { productId: true },
    });
    expect(row.productId).toBeNull();
  });

  it('lets a PROCUREMENT-enabled USER link', async () => {
    const { productId, lineId } = await unlinkedLine();
    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: procurementToken, body: { salesOrderItemId: lineId, productId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('lets an ADMIN link', async () => {
    const { productId, lineId } = await unlinkedLine();
    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken, body: { salesOrderItemId: lineId, productId },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  Recording a bill in the vendor's own words
// ---------------------------------------------------------------------------

describe('free-text bill entry', () => {
  it('records a bill with no catalogue product at all', async () => {
    const res = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-FREE-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [
          { productName: 'zz-test Kansa Thali Set', orderedQty: 10, receivedQty: 10, rate: '2000.00' },
          { productName: 'zz-test Brass Lota', orderedQty: 5, receivedQty: 5, rate: '500.00' },
        ],
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const bill = (res.body.data as { bill: { id: string; billTotal: string; items: {
      productName: string; product: unknown; standingQty: number; lineTotal: string;
    }[] } }).bill;
    trackPurchaseBill(bill.id);

    // The vendor's wording is kept verbatim, and nothing is linked yet.
    expect(bill.items[0]!.productName).toBe('zz-test Kansa Thali Set');
    expect(bill.items[0]!.product).toBeNull();
    // Total bill = qty x rate; standing out = everything received.
    expect(bill.items[0]!.lineTotal).toBe('20000.00');
    expect(bill.items[0]!.standingQty).toBe(10);
    expect(bill.items[1]!.lineTotal).toBe('2500.00');
    expect(bill.billTotal).toBe('22500.00');
  });

  it('refuses a blank product name', async () => {
    const res = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-BLANK-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [{ productName: '   ', orderedQty: 1, receivedQty: 1, rate: '1.00' }],
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses to allocate from a line that has no catalogue product', async () => {
    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-UNLINKED-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [{ productName: 'zz-test unlinked stock', orderedQty: 10, receivedQty: 10, rate: '10.00' }],
      },
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);

    const product = await makeProduct(0);
    const created = await createOrder([
      { productName: product.name, productId: product.id, quantity: 5, price: '10.00' },
    ]);
    const lineId = (created.body.data as OrderBody).order.items[0]!.id;

    const res = await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PURCHASE_LINE_NOT_LINKED');
  });

  it('links the purchase line, and only then allows allocation', async () => {
    const product = await makeProduct(0);
    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-LINKME-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [{ productName: 'zz-test vendor wording', orderedQty: 10, receivedQty: 10, rate: '10.00' }],
      },
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);
    const itemId = bill.items[0]!.id;

    const link = await api('POST', `/api/procurement/bills/${bill.id}/items/${itemId}/link`, {
      token: adminToken,
      body: { productId: product.id },
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);

    const linked = (link.body.data as { bill: { items: { productName: string; product: { id: string } | null }[] } })
      .bill.items[0]!;
    // The vendor's wording survives linking — only the catalogue link is added.
    expect(linked.productName).toBe('zz-test vendor wording');
    expect(linked.product?.id).toBe(product.id);

    const created = await createOrder([
      { productName: product.name, productId: product.id, quantity: 6, price: '10.00' },
    ]);
    const lineId = (created.body.data as OrderBody).order.items[0]!.id;

    const alloc = await api('POST', `/api/procurement/bills/${bill.id}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 6 },
    });
    expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);

    const item = (alloc.body.data as { bill: { items: { standingQty: number; allocatedQty: number }[] } })
      .bill.items[0]!;
    expect(item.allocatedQty).toBe(6);
    expect(item.standingQty).toBe(4);
  });

  it('refuses to relink a line whose stock is already allocated', async () => {
    const product = await makeProduct(0);
    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-RELINK-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [{ productName: 'zz-test relink', productId: product.id, orderedQty: 5, receivedQty: 5, rate: '10.00' }],
      },
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);

    const created = await createOrder([
      { productName: product.name, productId: product.id, quantity: 5, price: '10.00' },
    ]);
    const lineId = (created.body.data as OrderBody).order.items[0]!.id;
    await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 5 },
    });

    const other = await makeProduct(0);
    const res = await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/link`, {
      token: adminToken, body: { productId: other.id },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PURCHASE_LINE_HAS_ALLOCATIONS');
  });

  it('refuses linking without the PROCUREMENT module', async () => {
    const product = await makeProduct(0);
    const billRes = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: {
        billNumber: `ZZ-RBAC-${Date.now()}`,
        vendorId: vendor.id,
        billType: 'CREDIT',
        billDate: new Date().toISOString(),
        items: [{ productName: 'zz-test rbac line', orderedQty: 1, receivedQty: 1, rate: '1.00' }],
      },
    });
    const bill = (billRes.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
    trackPurchaseBill(bill.id);

    const res = await api('POST', `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/link`, {
      token: outsiderToken, body: { productId: product.id },
    });
    expect(res.status).toBe(403);
  });
});
