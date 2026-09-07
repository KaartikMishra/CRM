/**
 * Resolving a written product name to the catalogue entry it refers to.
 *
 * "Brass Cooker" on an order and "Brasscooker" on a bill are one product, and
 * the shortage board must say so — previously they appeared as two rows, one
 * of them claiming to be uncatalogued while its product sat in the list above.
 *
 * Resolution is a read. Finding the match does not write `productId`: the row
 * aggregates under the product it plainly names while the database still
 * records the line as unlinked, until somebody links it deliberately. These
 * cover that separation as much as the matching itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import { normalizeProductName } from '@rs/shared';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  TEST_PREFIX,
  cleanup,
  makeCustomer,
  makeUser,
  makeVendor,
  residualTestRows,
  salesOrderPayload,
  trackProduct,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let adminToken: string;
let customer: { id: string; name: string };
let vendor: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  customer = await makeCustomer();
  vendor = await makeVendor();
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const unique = (): string => `${TEST_PREFIX} Cooker ${Math.random().toString(36).slice(2, 9)}`;

/** A catalogue product, created directly so the test controls its spelling. */
async function catalogue(name: string, isActive = true): Promise<{ id: string; name: string }> {
  const p = await prisma.product.create({
    data: { name, normalizedName: normalizeProductName(name), isActive, inventory: { create: { onHand: 0 } } },
    select: { id: true, name: true },
  });
  trackProduct(p.id);
  return p;
}

type OrderBody = { order: { id: string; items: { id: string }[] } };

/** An order with one line, optionally pre-linked to a catalogue product. */
async function order(productName: string, quantity: number, productId?: string) {
  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName, quantity, price: '100.00', ...(productId ? { productId } : {}) }],
    }),
  });
  expect(res.status).toBe(201);
  const o = (res.body.data as OrderBody).order;
  trackSalesOrder(o.id);
  return { orderId: o.id, lineId: o.items[0]!.id };
}

type BillBody = { bill: { id: string; items: { id: string }[] } };

/** A bill with one free-text line, received in full and linked to nothing. */
async function bill(productName: string, qty: number) {
  const res = await api('POST', '/api/procurement/bills', {
    token: adminToken,
    body: {
      billNumber: `${TEST_PREFIX}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
      vendorId: vendor.id,
      billType: 'CREDIT',
      billDate: new Date().toISOString(),
      items: [{ productName, orderedQty: qty, receivedQty: qty, rate: '100.00' }],
    },
  });
  expect(res.status).toBe(201);
  const b = (res.body.data as BillBody).bill;
  trackPurchaseBill(b.id);
  return { billId: b.id, itemId: b.items[0]!.id };
}

type Shortages = { shortages: { productName: string; product: { id: string } | null; linked: boolean; totalRequired: number; totalAllocated: number; shortageQty: number; standingQty: number }[] };

async function shortagesFor(productId: string, name: string) {
  const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
  const rows = (res.body.data as Shortages).shortages;
  return {
    linkedRow: rows.find((r) => r.product?.id === productId),
    freeTextRow: rows.find((r) => !r.product && r.productName === name),
  };
}

describe('normalized read-side resolution', () => {
  it('shows ONE row for a linked sales line and an unlinked purchase line', async () => {
    // The live case: catalogue "Brass Cooker", sales "Brass Cooker" (linked),
    // purchase "Brasscooker" (unlinked). Required 5, received 8.
    const name = unique();
    const product = await catalogue(name);
    await order(name, 5, product.id);
    await bill(name.replace(/ /g, ''), 8);

    const { linkedRow, freeTextRow } = await shortagesFor(product.id, name.replace(/ /g, ''));

    // One row, carrying both sides.
    expect(linkedRow).toBeDefined();
    expect(linkedRow!.totalRequired).toBe(5);
    expect(linkedRow!.standingQty).toBe(8);
    // And no second "not in catalogue" row for the same product.
    expect(freeTextRow).toBeUndefined();
  });

  it('resolves every spelling onto the catalogue row', async () => {
    const name = `${TEST_PREFIX} Spell ${Math.random().toString(36).slice(2, 8)}`;
    const product = await catalogue(name);
    // Four bills, four spellings, 1 unit each.
    for (const spelling of [name.toUpperCase(), name.toLowerCase(), name.replace(/ /g, ''), name.replace(/ /g, '   ')]) {
      await bill(spelling, 1);
    }
    const { linkedRow } = await shortagesFor(product.id, name);
    expect(linkedRow!.standingQty).toBe(4);
  });

  it('leaves a genuinely different name as free text', async () => {
    const name = unique();
    await catalogue(name);
    const other = `${name} 2`;
    await bill(other, 3);

    const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
    const rows = (res.body.data as Shortages).shortages;
    const row = rows.find((r) => r.productName === other);
    expect(row).toBeDefined();
    expect(row!.linked).toBe(false);
    expect(row!.standingQty).toBe(3);
  });

  it('does not resolve onto an inactive product', async () => {
    const name = `${TEST_PREFIX} Retired ${Math.random().toString(36).slice(2, 8)}`;
    await catalogue(name, false);
    const squashed = name.replace(/ /g, '');
    await bill(squashed, 2);

    const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
    const rows = (res.body.data as Shortages).shortages;
    const row = rows.find((r) => r.productName === squashed);
    expect(row).toBeDefined();
    expect(row!.linked).toBe(false);
  });

  it('does NOT write productId when it resolves — resolution is a read', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { itemId } = await bill(name.replace(/ /g, ''), 6);

    await api('GET', '/api/procurement/shortages', { token: adminToken });

    const item = await prisma.purchaseBillItem.findUnique({
      where: { id: itemId },
      select: { productId: true, productName: true },
    });
    expect(item!.productId).toBeNull();
    expect(item!.productName).toBe(name.replace(/ /g, ''));
    // And the catalogue name was not rewritten to match the bill.
    const p = await prisma.product.findUnique({ where: { id: product.id }, select: { name: true } });
    expect(p!.name).toBe(name);
  });
});

describe('linking and allocating a resolved purchase line', () => {
  it('links to the existing product and allocates part of the standing stock', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 5, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 8);

    const productsBefore = await prisma.product.count();

    // Explicit link — reuses the existing product, creates nothing.
    const link = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken,
      body: { productId: product.id },
    });
    expect(link.status).toBe(200);
    expect(await prisma.product.count()).toBe(productsBefore);

    // The bill keeps its own wording.
    const linked = await prisma.purchaseBillItem.findUnique({
      where: { id: itemId }, select: { productId: true, productName: true },
    });
    expect(linked!.productId).toBe(product.id);
    expect(linked!.productName).toBe(name.replace(/ /g, ''));

    // Allocate 5 of the 8 standing.
    const alloc = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(alloc.status).toBe(201);

    const item = await prisma.purchaseBillItem.findUnique({
      where: { id: itemId },
      select: { receivedQty: true, allocations: { select: { quantity: true } } },
    });
    const allocated = item!.allocations.reduce((s, a) => s + a.quantity, 0);
    expect(item!.receivedQty).toBe(8);
    expect(allocated).toBe(5);
    expect(item!.receivedQty - allocated).toBe(3); // standing

    // Sales side: fully met, and alreadyFulfilled untouched.
    const line = await prisma.salesOrderItem.findUnique({
      where: { id: lineId }, select: { quantity: true, alreadyFulfilled: true },
    });
    expect(line!.quantity).toBe(5);
    expect(line!.alreadyFulfilled).toBe(0);
    expect(Math.max(0, line!.quantity - line!.alreadyFulfilled - allocated)).toBe(0); // pending

    // On hand is untouched by receiving or allocating.
    const inv = await prisma.inventoryItem.findUnique({
      where: { productId: product.id }, select: { onHand: true },
    });
    expect(inv!.onHand).toBe(0);
  });

  it('still refuses more than the order line needs', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 5, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 8);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 6 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_PENDING');
  });

  it('still refuses more than the purchase line holds', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 10, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 4);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_STANDING');
  });

  it('still refuses allocating across two different products', async () => {
    const a = await catalogue(unique());
    const b = await catalogue(unique());
    const { lineId } = await order(a.name, 5, a.id);
    const { billId, itemId } = await bill(b.name, 8);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: b.id },
    });

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_MISMATCH');
  });
});

/**
 * Allocated counts only what is still in play.
 *
 * The same product across a fulfilled order and a partial one: the fulfilled
 * order's allocation is history, and the board is a planning view.
 */
describe('shortage Allocated excludes fully fulfilled lines', () => {
  it('reports allocation from the open line only', async () => {
    const name = unique();
    const product = await catalogue(name);

    // One order fully met (5/5), one partial (1 of 5).
    const first = await order(name, 5, product.id);
    const second = await order(name, 5, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 20);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });
    for (const [line, qty] of [[first.lineId, 5], [second.lineId, 1]] as const) {
      const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
        token: adminToken, body: { salesOrderItemId: line, quantity: qty },
      });
      expect(res.status).toBe(201);
    }

    const { linkedRow } = await shortagesFor(product.id, name);
    expect(linkedRow!.totalRequired).toBe(4);      // only the partial line
    expect(linkedRow!.totalAllocated).toBe(1);     // NOT 6
    expect(linkedRow!.shortageQty).toBe(4);
    expect(linkedRow!.standingQty).toBe(14);       // 20 received - 6 allocated

    // Both allocations survive — this is a display rule, not a deletion.
    const total = await prisma.purchaseAllocation.aggregate({
      where: { purchaseBillItemId: itemId }, _sum: { quantity: true },
    });
    expect(total._sum.quantity).toBe(6);
  });

  it('reports zero allocated once every line is met', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 3, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 9);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });

    const { linkedRow } = await shortagesFor(product.id, name);
    expect(linkedRow!.totalRequired).toBe(0);
    expect(linkedRow!.totalAllocated).toBe(0);
    expect(linkedRow!.standingQty).toBe(6);   // standing is unaffected
  });
});

/**
 * The History detail view.
 *
 * A read-only projection: the popup answers "which vendor supplied these
 * units, off which bill", and must be able to answer it for several sources at
 * once without pooling them into one.
 */
type DetailBody = { detail: {
  salesOrderItemId: string;
  order: { orderId: string; status: string };
  customer: { name: string; phone: string | null; email: string | null };
  productName: string;
  product: { name: string } | null;
  requiredQty: number; alreadyFulfilled: number; procurementFulfilled: number;
  totalFulfilled: number; unfulfilledQty: number; status: string;
  sources: { allocatedQty: number; purchaseLine: { productName: string; receivedQty: number; standingQty: number };
             bill: { billNumber: string }; vendor: { name: string; phone: string | null } }[];
  activity: { at: string; label: string }[];
} };

const detailFor = async (lineId: string, token = adminToken) =>
  api('GET', `/api/procurement/order-lines/${lineId}/fulfillment-detail`, { token }) as Promise<{ status: number; body: Record<string, unknown> }>;

describe('sales fulfilment detail', () => {
  it('returns the line, its customer, and the server-computed figures', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 5, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 8);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 5 },
    });

    const res = await detailFor(lineId);
    expect(res.status).toBe(200);
    const d = (res.body.data as DetailBody).detail;

    expect(d.salesOrderItemId).toBe(lineId);
    expect(d.customer.name).toBe(customer.name);
    expect(d.requiredQty).toBe(5);
    expect(d.alreadyFulfilled).toBe(0);
    expect(d.procurementFulfilled).toBe(5);
    expect(d.totalFulfilled).toBe(5);
    expect(d.unfulfilledQty).toBe(0);
    expect(d.status).toBe('FULFILLED');

    // Sales → allocation → bill item → bill → vendor, intact.
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0]!.allocatedQty).toBe(5);
    expect(d.sources[0]!.purchaseLine.receivedQty).toBe(8);
    expect(d.sources[0]!.purchaseLine.standingQty).toBe(3);
    expect(d.sources[0]!.vendor.name).toBe(vendor.name);
    expect(d.activity.length).toBeGreaterThan(0);
  });

  it('preserves the order’s own spelling beside the catalogue name', async () => {
    const name = unique();
    const product = await catalogue(name);
    const squashed = name.replace(/ /g, '');
    // The order was written without spaces; the catalogue has them.
    const { lineId } = await order(squashed, 3, product.id);

    const d = ((await detailFor(lineId)).body.data as DetailBody).detail;
    expect(d.productName).toBe(squashed);         // as ordered
    expect(d.product!.name).toBe(name);           // as catalogued
  });

  it('shows every source separately when two bills supplied one line', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 7, product.id);

    const a = await bill(name.replace(/ /g, ''), 4);
    const b = await bill(name.toUpperCase(), 3);
    for (const x of [a, b]) {
      await api('POST', `/api/procurement/bills/${x.billId}/items/${x.itemId}/link`, {
        token: adminToken, body: { productId: product.id },
      });
    }
    await api('POST', `/api/procurement/bills/${a.billId}/items/${a.itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 4 },
    });
    await api('POST', `/api/procurement/bills/${b.billId}/items/${b.itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });

    const d = ((await detailFor(lineId)).body.data as DetailBody).detail;
    expect(d.sources).toHaveLength(2);               // not collapsed
    expect(d.procurementFulfilled).toBe(7);
    expect(d.sources.map((s) => s.allocatedQty).sort()).toEqual([3, 4]);
    // Each keeps its own bill number.
    expect(new Set(d.sources.map((s) => s.bill.billNumber)).size).toBe(2);
  });

  it('keeps already-fulfilled out of the purchase sources', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 10, product.id);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 6);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 6 },
    });

    const d = ((await detailFor(lineId)).body.data as DetailBody).detail;
    expect(d.alreadyFulfilled).toBe(4);
    expect(d.procurementFulfilled).toBe(6);
    expect(d.totalFulfilled).toBe(10);
    expect(d.unfulfilledQty).toBe(0);
    // The 4 hand-recorded units are not attributed to any vendor.
    expect(d.sources).toHaveLength(1);
    expect(d.sources.reduce((s, x) => s + x.allocatedQty, 0)).toBe(6);
  });

  it('writes nothing when the detail is opened', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 5, product.id);
    const { billId, itemId } = await bill(name.replace(/ /g, ''), 8);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/link`, {
      token: adminToken, body: { productId: product.id },
    });
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 2 },
    });

    const before = {
      products: await prisma.product.count(),
      allocations: await prisma.purchaseAllocation.count(),
      audits: await prisma.auditLog.count(),
      line: await prisma.salesOrderItem.findUnique({ where: { id: lineId }, select: { quantity: true, alreadyFulfilled: true, productId: true } }),
      onHand: (await prisma.inventoryItem.findUnique({ where: { productId: product.id }, select: { onHand: true } }))!.onHand,
    };

    await detailFor(lineId);
    await detailFor(lineId);

    expect(await prisma.product.count()).toBe(before.products);
    expect(await prisma.purchaseAllocation.count()).toBe(before.allocations);
    expect(await prisma.auditLog.count()).toBe(before.audits);   // no read auditing
    expect(await prisma.salesOrderItem.findUnique({ where: { id: lineId }, select: { quantity: true, alreadyFulfilled: true, productId: true } })).toEqual(before.line);
    expect((await prisma.inventoryItem.findUnique({ where: { productId: product.id }, select: { onHand: true } }))!.onHand).toBe(before.onHand);
  });

  it('404s an unknown line', async () => {
    const res = await detailFor('ckd0000000000000000000000');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ORDER_ITEM_NOT_FOUND');
  });

  it('enforces the existing RBAC', async () => {
    const name = unique();
    const product = await catalogue(name);
    const { lineId } = await order(name, 2, product.id);

    const outsider = await makeUser('USER');
    await prisma.userModulePermission.createMany({
      data: (['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: outsider.id, module: 'PROCUREMENT' as const, action, allowed: false,
      })),
    });
    const outsiderToken = await mintToken(outsider.id, { role: 'USER' });

    expect((await detailFor(lineId, outsiderToken)).status).toBe(403);
    // And unauthenticated.
    const anon = await api('GET', `/api/procurement/order-lines/${lineId}/fulfillment-detail`);
    expect(anon.status).toBe(401);
  });
});
