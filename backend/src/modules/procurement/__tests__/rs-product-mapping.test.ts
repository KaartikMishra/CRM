/**
 * Procurement's product identity, after the RS Products migration.
 *
 * A purchase line names an `RsProduct`, at product level. Three things that
 * look like identifiers are not, and each is covered here because getting any
 * of them wrong silently attaches a purchase to the wrong goods:
 *
 *   a SKU     nullable, and legitimately shared by several products
 *   a title   not unique by design — Shopify titles repeat
 *   a variant a different entity; Procurement has no variant concept at all
 *
 * The legacy `productId` beside it is the temporary allocation key, not the
 * identity. It survives only because allocation reconciles a purchase line
 * against a SalesOrderItem, and Sales still identifies its lines the old way.
 * These assert that it is written from the RsProduct bridge and from nowhere
 * else — never from a name, a folded name or a matching SKU.
 *
 * Stock is read only in this phase. Receiving goods must not move RS stock,
 * which is asserted directly rather than assumed from the absence of code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { prisma } from '../../../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  TEST_PREFIX,
  cleanup,
  mapOrderLineToRsProduct,
  makeCustomer,
  makeRsProduct,
  makeUser,
  makeVendor,
  purchaseBillPayload,
  residualTestRows,
  salesOrderPayload,
  approvePurchaseBill,
  trackPurchaseBill,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let outsider: TestUser;
let adminToken: string;
let outsiderToken: string;
let vendor: { id: string; name: string };
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  outsider = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });
  vendor = await makeVendor();
  customer = await makeCustomer();

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

type BillBody = {
  bill: {
    id: string;
    items: {
      id: string;
      productName: string;
      rsProduct: { id: string; title: string; sku: string | null; crmStockQty: number } | null;
      product: { id: string } | null;
      receivedQty: number;
      standingQty: number;
    }[];
  };
};

/** A bill with one line, optionally carrying an RS mapping at entry. */
async function makeBill(
  overrides: Record<string, unknown> = {},
): Promise<BillBody['bill']> {
  const payload = purchaseBillPayload(vendor.id, '', overrides);
  // purchaseBillPayload seeds a legacy productId; these tests set the line up
  // themselves so the two keys can be varied independently.
  if (!overrides.items) {
    payload.items = [
      { productName: `${TEST_PREFIX}-bill-line`, orderedQty: 10, receivedQty: 10, rate: '100.00' },
    ];
  }
  const res = await api('POST', '/api/procurement/bills', { token: adminToken, body: payload });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const bill = (res.body.data as BillBody).bill;
  trackPurchaseBill(bill.id);
  // Allocation needs an approved bill; the approval rule has its own suite.
  await approvePurchaseBill(bill.id);
  return bill;
}

const mapTo = (billId: string, itemId: string, rsProductId: string, token = adminToken) =>
  api('POST', `/api/procurement/bills/${billId}/items/${itemId}/rs-product`, {
    token,
    body: { rsProductId },
  });

// ---------------------------------------------------------------------------
//  Mapping
// ---------------------------------------------------------------------------

describe('mapping a purchase line to an RS Product', () => {
  it('persists the RsProduct id and reports it back', async () => {
    const rs = await makeRsProduct({ crmStockQty: 7 });
    const bill = await makeBill();

    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const line = (res.body.data as BillBody).bill.items[0]!;
    expect(line.rsProduct?.id).toBe(rs.id);
    expect(line.rsProduct?.title).toBe(rs.title);

    const row = await prisma.purchaseBillItem.findUniqueOrThrow({
      where: { id: bill.items[0]!.id },
      select: { rsProductId: true, productName: true },
    });
    expect(row.rsProductId).toBe(rs.id);
    // The vendor's wording is the record of their document and is never
    // rewritten to match the catalogue.
    expect(row.productName).toBe(`${TEST_PREFIX}-bill-line`);
  });

  it('accepts the mapping at bill entry', async () => {
    const rs = await makeRsProduct({ crmStockQty: 3 });
    const bill = await makeBill({
      items: [
        {
          productName: `${TEST_PREFIX}-bill-line`,
          rsProductId: rs.id,
          orderedQty: 5,
          receivedQty: 5,
          rate: '10.00',
        },
      ],
    });
    expect(bill.items[0]!.rsProduct?.id).toBe(rs.id);
  });

  it('refuses an RsProduct id that does not exist', async () => {
    const bill = await makeBill();
    const res = await mapTo(bill.id, bill.items[0]!.id, 'ckd0000000000000000000001');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RS_PRODUCT_NOT_FOUND');
  });

  it('refuses a ShopifyVariant id — Procurement maps products, not variants', async () => {
    const rs = await makeRsProduct();
    const bill = await makeBill();

    // A variant id is a well-formed cuid that names no RsProduct, which is
    // exactly why it must be refused by the lookup rather than by a format rule.
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.variantId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RS_PRODUCT_NOT_FOUND');

    const row = await prisma.purchaseBillItem.findUniqueOrThrow({
      where: { id: bill.items[0]!.id },
      select: { rsProductId: true },
    });
    expect(row.rsProductId).toBeNull();
  });

  it('refuses a variant id supplied at bill entry too', async () => {
    const rs = await makeRsProduct();
    const res = await api('POST', '/api/procurement/bills', {
      token: adminToken,
      body: purchaseBillPayload(vendor.id, '', {
        items: [
          {
            productName: `${TEST_PREFIX}-bill-line`,
            rsProductId: rs.variantId,
            orderedQty: 1,
            receivedQty: 0,
            rate: '1.00',
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RS_PRODUCT_NOT_FOUND');
  });

  it('refuses a request without the PROCUREMENT module', async () => {
    const rs = await makeRsProduct();
    const bill = await makeBill();
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id, outsiderToken);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const rs = await makeRsProduct();
    const bill = await makeBill();
    const res = await api(
      'POST',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/rs-product`,
      { body: { rsProductId: rs.id } },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
//  SKU is not identity
// ---------------------------------------------------------------------------

describe('SKU is a search and display attribute, never identity', () => {
  it('lets two RS Products share one SKU, and maps neither automatically', async () => {
    const sku = `${TEST_PREFIX.toUpperCase()}-${Date.now()}`;
    const first = await makeRsProduct({ sku, crmStockQty: 2 });
    const second = await makeRsProduct({ sku, crmStockQty: 5 });
    expect(first.sku).toBe(second.sku);

    // The catalogue search returns both; nothing in Procurement chooses.
    const search = await api(
      'GET',
      `/api/rs-products?q=${encodeURIComponent(sku)}&limit=20`,
      { token: adminToken },
    );
    expect(search.status).toBe(200);
    const found = (search.body.data as { products: { id: string }[] }).products.map((p) => p.id);
    expect(found).toContain(first.id);
    expect(found).toContain(second.id);

    // A line whose wording is that very SKU still records unmapped.
    const bill = await makeBill({
      items: [{ productName: sku, orderedQty: 1, receivedQty: 0, rate: '1.00' }],
    });
    expect(bill.items[0]!.rsProduct).toBeNull();

    // And an explicit choice picks the exact product, not "the one with that SKU".
    const res = await mapTo(bill.id, bill.items[0]!.id, second.id);
    expect(res.status).toBe(200);
    expect((res.body.data as BillBody).bill.items[0]!.rsProduct?.id).toBe(second.id);
  });

  it('maps a product with no SKU at all', async () => {
    const rs = await makeRsProduct({ sku: null, crmStockQty: 4 });
    const bill = await makeBill();
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id);

    expect(res.status).toBe(200);
    const line = (res.body.data as BillBody).bill.items[0]!;
    expect(line.rsProduct?.id).toBe(rs.id);
    expect(line.rsProduct?.sku).toBeNull();
  });

  it('does not map a line whose wording exactly matches an RS title', async () => {
    const title = `${TEST_PREFIX}-exact-${Date.now()}`;
    await makeRsProduct({ title });
    const bill = await makeBill({
      items: [{ productName: title, orderedQty: 1, receivedQty: 0, rate: '1.00' }],
    });
    expect(bill.items[0]!.rsProduct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Allocation compatibility
// ---------------------------------------------------------------------------

/**
 * Allocation, on one identity.
 *
 * Both sides name an RsProduct and the comparison is between two values of the
 * same kind. There is no second key, no bridge, and nothing that can be missing
 * — which is exactly what the dual-key arrangement this replaced could not
 * promise: it needed a legacy Product on both sides and nothing could create
 * one, so a correctly mapped line was unallocatable.
 */
describe('allocation on RS Product identity', () => {
  /** An order whose single line names an RS Product. */
  async function order(rsProductId: string | null, quantity: number) {
    const res = await api('POST', '/api/sales', {
      token: adminToken,
      body: salesOrderPayload(customer.id, {
        items: [
          {
            productName: `${TEST_PREFIX}-order-line`,
            ...(rsProductId ? { rsProductId } : {}),
            quantity,
            price: '100.00',
          },
        ],
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = (res.body.data as { order: { id: string; items: { id: string }[] } }).order;
    trackSalesOrder(body.id);
    return { lineId: body.items[0]!.id };
  }

  const allocate = (billId: string, itemId: string, salesOrderItemId: string, quantity: number) =>
    api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken,
      body: { salesOrderItemId, quantity },
    });

  it('allocates when both sides name the same RS Product', async () => {
    const rs = await makeRsProduct();
    const { lineId } = await order(rs.id, 5);
    const bill = await makeBill();

    await mapTo(bill.id, bill.items[0]!.id, rs.id);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 3);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await prisma.purchaseAllocation.count({ where: { salesOrderItemId: lineId } })).toBe(1);
  });

  it('refuses PRODUCT_MISMATCH when the two sides name different products', async () => {
    const onTheOrder = await makeRsProduct();
    const onTheBill = await makeRsProduct();
    const { lineId } = await order(onTheOrder.id, 5);
    const bill = await makeBill();

    await mapTo(bill.id, bill.items[0]!.id, onTheBill.id);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_MISMATCH');
    expect(await prisma.purchaseAllocation.count({ where: { salesOrderItemId: lineId } })).toBe(0);
  });

  it('refuses an unmapped purchase line', async () => {
    const rs = await makeRsProduct();
    const { lineId } = await order(rs.id, 5);
    const bill = await makeBill();

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PURCHASE_LINE_NOT_LINKED');
  });

  it('refuses an unmapped order line', async () => {
    const rs = await makeRsProduct();
    const { lineId } = await order(null, 5);
    const bill = await makeBill();

    await mapTo(bill.id, bill.items[0]!.id, rs.id);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORDER_LINE_NOT_LINKED');
  });

  it('maps an existing free-text order line, and then allocates', async () => {
    const rs = await makeRsProduct();
    const { lineId } = await order(null, 5);
    const bill = await makeBill();
    await mapTo(bill.id, bill.items[0]!.id, rs.id);

    const link = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, rsProductId: rs.id },
    });
    expect(link.status, JSON.stringify(link.body)).toBe(200);

    const res = await allocate(bill.id, bill.items[0]!.id, lineId, 2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('refuses a ShopifyVariant id when mapping an order line', async () => {
    const rs = await makeRsProduct();
    const { lineId } = await order(null, 5);

    const res = await api('POST', '/api/procurement/order-lines/link', {
      token: adminToken,
      body: { salesOrderItemId: lineId, rsProductId: rs.variantId },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RS_PRODUCT_NOT_FOUND');
  });

  it('never reads a legacy Product id — that column no longer exists', async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('SalesOrderItem', 'PurchaseBillItem')
         AND column_name = 'productId'`,
    );
    expect(columns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  Which stock figure Procurement reads
//
//  These assert the SOURCE of the number — RS Products' own CRM count, never
//  InventoryItem.onHand and never Shopify's inventoryQty. They deliberately use
//  bills that received nothing, so no purchased surplus enters the figure and
//  each test isolates the one thing it is about. The movement of stock through
//  approval and allocation has its own suite, crm-stock-flow.test.ts.
// ---------------------------------------------------------------------------

/** A line that has received nothing, so it contributes no stock of its own. */
const emptyLine = {
  items: [
    { productName: `${TEST_PREFIX}-bill-line`, orderedQty: 10, receivedQty: 0, rate: '100.00' },
  ],
};

describe('Procurement reads the RS Products CRM figure', () => {
  it('reports the RS Products product-level aggregate', async () => {
    const rs = await makeRsProduct({ crmStockQty: 9 });
    const bill = await makeBill(emptyLine);
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id);

    const line = (res.body.data as BillBody).bill.items[0]!;

    // The same number RS Products itself reports for that product — asserted
    // against the catalogue API rather than against the literal, so the two
    // cannot drift apart without this failing.
    const catalogue = await api('GET', `/api/rs-products?q=${encodeURIComponent(rs.title)}`, {
      token: adminToken,
    });
    const row = (catalogue.body.data as { products: { id: string; crmStockQty: number }[] }).products
      .find((p) => p.id === rs.id)!;

    expect(line.rsProduct?.crmStockQty).toBe(row.crmStockQty);
    expect(line.rsProduct?.crmStockQty).toBe(9);
  });

  it('reads no InventoryItem stock — Procurement holds no such figure', async () => {
    const rs = await makeRsProduct({ crmStockQty: 2 });
    const bill = await makeBill(emptyLine);
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id);

    expect((res.body.data as BillBody).bill.items[0]!.rsProduct?.crmStockQty).toBe(2);

    // The legacy warehouse count has no route into this module: nothing joins
    // InventoryItem, and no shape Procurement returns carries an onHand field.
    expect(JSON.stringify(res.body)).not.toContain('onHand');
  });

  it('does not read Shopify inventoryQty as CRM stock', async () => {
    const rs = await makeRsProduct({ crmStockQty: 1 });
    await prisma.shopifyVariant.updateMany({
      where: { rsProductId: rs.id },
      data: { inventoryQty: 999 },
    });

    const bill = await makeBill(emptyLine);
    const res = await mapTo(bill.id, bill.items[0]!.id, rs.id);
    expect((res.body.data as BillBody).bill.items[0]!.rsProduct?.crmStockQty).toBe(1);
  });

  /*
    This test used to assert that receiving goods left CRM stock untouched, and
    that is no longer the rule. An approved bill's surplus now enters CRM stock,
    so receiving 10 against an approved bill with nothing committed adds 10.

    What is still worth pinning here — and is what the test was really about —
    is that receiving moves the LINE's own figures and the bill's lifecycle
    correctly. The stock arithmetic is asserted properly in crm-stock-flow.
  */
  it('receiving goods updates receivedQty, standing, and the approved surplus', async () => {
    const rs = await makeRsProduct({ crmStockQty: 6 });
    const bill = await makeBill({
      items: [
        {
          productName: `${TEST_PREFIX}-bill-line`,
          rsProductId: rs.id,
          orderedQty: 10,
          receivedQty: 0,
          rate: '10.00',
        },
      ],
    });

    const shopifyBefore = await prisma.shopifyVariant.findMany({
      where: { rsProductId: rs.id },
      select: { inventoryQty: true },
    });

    const res = await api(
      'POST',
      `/api/procurement/bills/${bill.id}/items/${bill.items[0]!.id}/receive`,
      { token: adminToken, body: { receivedQty: 10 } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const line = (res.body.data as BillBody).bill.items[0]!;
    expect(line.receivedQty).toBe(10);
    expect(line.standingQty).toBe(10);

    // The bill is approved and nothing is committed, so all ten units are free
    // stock: the 6 counted by hand plus the 10 that arrived.
    expect(line.rsProduct?.crmStockQty).toBe(16);

    // Shopify's own count is still untouched by any of it.
    const shopifyAfter = await prisma.shopifyVariant.findMany({
      where: { rsProductId: rs.id },
      select: { inventoryQty: true },
    });
    expect(shopifyAfter).toEqual(shopifyBefore);

    // The bill's own lifecycle is unchanged: every line in, so the bill is in.
    const status = await prisma.purchaseBill.findUniqueOrThrow({
      where: { id: bill.id },
      select: { status: true },
    });
    expect(status.status).toBe('RECEIVED');
  });
});

// ---------------------------------------------------------------------------
//  Legacy catalogue CRUD is gone
// ---------------------------------------------------------------------------

describe('the legacy Product architecture is gone from Procurement', () => {
  const routes: [string, string, Record<string, unknown>][] = [
    ['GET', '/api/procurement/products?limit=5', {}],
    ['POST', '/api/procurement/products', { name: `${TEST_PREFIX}-should-not-exist`, onHand: 5 }],
    ['PATCH', '/api/procurement/products/ckd0000000000000000000001', { isActive: false }],
    ['POST', '/api/procurement/products/ckd0000000000000000000001/inventory', { delta: 5, reason: 'x' }],
    ['POST', '/api/procurement/order-lines/put-in-catalogue', { salesOrderItemId: 'ckd0000000000000000000001' }],
  ];

  it.each(routes)('%s %s is gone', async (method, path, body) => {
    /*
      No body on a GET. `fetch` throws outright on one — "Request with GET/HEAD
      method cannot have body" — so passing the table's empty object made this
      case fail inside the client without ever reaching the server, which is
      indistinguishable in the result from the route still existing.
    */
    const res = await api(method as 'GET', path, {
      token: adminToken,
      ...(method === 'GET' ? {} : { body }),
    });
    expect(res.status).toBe(404);
  });

  it('leaves no Procurement table referencing the legacy Product', async () => {
    const fks = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT tc.table_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'Product'
         AND tc.table_name <> 'InventoryItem'`,
    );
    expect(fks).toEqual([]);
  });
});
