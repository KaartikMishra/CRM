/**
 * The SALES board and the single fulfilment total.
 *
 * A line's fulfilment comes from two independent places — units supplied by
 * hand, and units mapped from a purchase bill — and the whole point of this
 * design is that neither is a stored copy of the other. Everything below is an
 * attempt to make them disagree.
 *
 * The case that matters most is the last one in the first block: warehouse
 * stock is shared, so if it were ever counted as per-line fulfilment again,
 * one shelf would silently satisfy several customers at once.
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
let outsider: TestUser;
let adminToken: string;
let outsiderToken: string;
let customer: { id: string; name: string };
let vendor: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  outsider = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });
  customer = await makeCustomer();
  vendor = await makeVendor();
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

type OrderBody = { order: { id: string; orderId: string; items: { id: string }[] } };
type SalesRow = {
  salesOrderItemId: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  requiredQty: number;
  alreadyFulfilled: number;
  procurementFulfilled: number;
  totalFulfilled: number;
  unfulfilledQty: number;
  status: string;
};

/** An order for `product`, linked to the catalogue, of the given size. */
async function makeOrder(productId: string, quantity: number) {
  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test line', productId, quantity, price: '100.00' }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = (res.body.data as OrderBody).order;
  trackSalesOrder(order.id);
  return { orderId: order.id, orderNumber: order.orderId, lineId: order.items[0]!.id };
}

async function salesRow(salesOrderItemId: string): Promise<SalesRow> {
  const res = await api('GET', '/api/procurement/sales-requirements', { token: adminToken });
  expect(res.status).toBe(200);
  const rows = (res.body.data as { requirements: SalesRow[] }).requirements;
  const row = rows.find((r) => r.salesOrderItemId === salesOrderItemId);
  expect(row, 'line should appear on the SALES board').toBeDefined();
  return row!;
}

/** The free-text row for a product nobody has catalogued. */
async function unlinkedShortage(productName: string): Promise<{
  totalRequired: number; onHand: number; linked: boolean; standingQty: number;
} | undefined> {
  const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
  const rows = (res.body.data as { shortages: {
    productName: string; linked: boolean; totalRequired: number; onHand: number; standingQty: number;
  }[] }).shortages;
  return rows.find((r) => !r.linked && r.productName === productName);
}

/** An order line typed as free text, with no catalogue entry. */
async function makeFreeTextOrder(productName: string, quantity: number) {
  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName, quantity, price: '100.00' }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = (res.body.data as OrderBody).order;
  trackSalesOrder(order.id);
  return { orderId: order.id, orderNumber: order.orderId, lineId: order.items[0]!.id };
}

async function shortageFor(productId: string): Promise<number> {
  const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
  // `product` is null on free-text rows, so it must be narrowed before its id
  // is read — the board now carries both kinds.
  const rows = (res.body.data as { shortages: {
    product: { id: string } | null; shortageQty: number; totalRequired: number;
  }[] }).shortages;
  return rows.find((r) => r.product?.id === productId)?.totalRequired ?? 0;
}

async function makeBill(productId: string, received: number) {
  const res = await api('POST', '/api/procurement/bills', {
    token: adminToken,
    body: purchaseBillPayload(vendor.id, productId, {
      items: [{ productName: 'zz-test purchase', productId, orderedQty: received, receivedQty: received, rate: '10.00' }],
    }),
  });
  const bill = (res.body.data as { bill: { id: string; items: { id: string }[] } }).bill;
  trackPurchaseBill(bill.id);
  return { billId: bill.id, itemId: bill.items[0]!.id };
}

// ---------------------------------------------------------------------------

describe('the SALES board', () => {
  it('shows a new order line with nothing fulfilled', async () => {
    const product = await makeProduct(0);
    const { lineId, orderNumber } = await makeOrder(product.id, 10);

    const row = await salesRow(lineId);
    expect(row.orderNumber).toBe(orderNumber);
    expect(row.customerName).toBe(customer.name);
    expect(row.requiredQty).toBe(10);
    expect(row.alreadyFulfilled).toBe(0);
    expect(row.procurementFulfilled).toBe(0);
    expect(row.totalFulfilled).toBe(0);
    expect(row.unfulfilledQty).toBe(10);
    expect(row.status).toBe('UNFULFILLED');
  });

  it('reduces outstanding demand when fulfilment is recorded by hand', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);

    const res = await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken,
      body: { alreadyFulfilled: 4 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await salesRow(lineId);
    expect(row.alreadyFulfilled).toBe(4);
    expect(row.totalFulfilled).toBe(4);
    expect(row.unfulfilledQty).toBe(6);
    expect(row.status).toBe('PARTIAL');
  });

  it('feeds only the outstanding six into Requirement vs Stock, not the gross ten', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });

    expect(await shortageFor(product.id)).toBe(6);
  });

  it('does not let one shelf of stock fulfil several customers at once', async () => {
    // The failure mode the per-line column exists to prevent: ten units on hand
    // must not read as satisfying three separate ten-unit orders.
    const product = await makeProduct(10);
    const a = await makeOrder(product.id, 10);
    const b = await makeOrder(product.id, 10);

    for (const line of [a, b]) {
      const row = await salesRow(line.lineId);
      expect(row.totalFulfilled, 'inventory must not count as fulfilment').toBe(0);
      expect(row.unfulfilledQty).toBe(10);
    }
    // And the shortage board asks for all twenty, not zero.
    expect(await shortageFor(product.id)).toBe(20);
  });
});

describe('procurement allocation feeds the same total', () => {
  it('combines hand-recorded and procurement fulfilment', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    const { billId, itemId } = await makeBill(product.id, 6);

    // Partial: three of the six.
    const first = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    let row = await salesRow(lineId);
    expect(row.alreadyFulfilled).toBe(4);
    expect(row.procurementFulfilled).toBe(3);
    expect(row.totalFulfilled).toBe(7);
    expect(row.unfulfilledQty).toBe(3);
    expect(row.status).toBe('PARTIAL');
    expect(await shortageFor(product.id)).toBe(3);

    // The remaining three complete it.
    const second = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 3 },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    row = await salesRow(lineId);
    expect(row.procurementFulfilled).toBe(6);
    expect(row.totalFulfilled).toBe(10);
    expect(row.unfulfilledQty).toBe(0);
    expect(row.status).toBe('FULFILLED');
    // Nothing outstanding, so it drops off the shortage board entirely.
    expect(await shortageFor(product.id)).toBe(0);
  });

  it('maps against the exact order line, leaving its sibling alone', async () => {
    const product = await makeProduct(0);
    const first = await makeOrder(product.id, 5);
    const second = await makeOrder(product.id, 5);
    const { billId, itemId } = await makeBill(product.id, 5);

    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: first.lineId, quantity: 5 },
    });

    expect((await salesRow(first.lineId)).totalFulfilled).toBe(5);
    expect((await salesRow(second.lineId)).totalFulfilled).toBe(0);
  });

  it('refuses hand-recorded fulfilment that would exceed the requirement', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);
    const { billId, itemId } = await makeBill(product.id, 6);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 6 },
    });

    // 6 already allocated, so at most 4 more can have been supplied by hand.
    const res = await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 7 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_REQUIREMENT');

    const ok = await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    expect(ok.status).toBe(200);
    expect((await salesRow(lineId)).status).toBe('FULFILLED');
  });

  it('still refuses to allocate beyond what the line needs', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 8 },
    });
    const { billId, itemId } = await makeBill(product.id, 10);

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_PENDING');
  });

  it('keeps the product-mismatch guard', async () => {
    const [a, b] = [await makeProduct(0), await makeProduct(0)];
    const { lineId } = await makeOrder(a.id, 5);
    const { billId, itemId } = await makeBill(b.id, 5);

    const res = await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: lineId, quantity: 1 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRODUCT_MISMATCH');
  });
});

describe('authorization and existing data', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await api('GET', '/api/procurement/sales-requirements')).status).toBe(401);
  });

  it('refuses a USER without the PROCUREMENT module', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 5);

    expect((await api('GET', '/api/procurement/sales-requirements', { token: outsiderToken })).status).toBe(403);

    const res = await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: outsiderToken, body: { alreadyFulfilled: 1 },
    });
    expect(res.status).toBe(403);

    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: lineId }, select: { alreadyFulfilled: true },
    });
    expect(row.alreadyFulfilled).toBe(0);
  });

  it('leaves rsm002 exactly as it was', async () => {
    const order = await prisma.salesOrder.findUnique({
      where: { orderId: 'rsm002' },
      select: {
        status: true,
        paidAmount: true,
        items: { select: { quantity: true, price: true, productId: true, alreadyFulfilled: true } },
      },
    });

    // The order predates this module entirely; nothing here may touch it.
    if (order) {
      expect(order.status).toBe('CLOSED');
      expect(order.paidAmount.toFixed(2)).toBe('1000.00');
      const line = order.items[0]!;
      expect(line.quantity).toBe(4);
      expect(line.price.toFixed(2)).toBe('1300.00');
      expect(line.productId).toBeNull();
      // Simply the column default — never written to.
      expect(line.alreadyFulfilled).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
//  The procurement queue: only outstanding demand
// ---------------------------------------------------------------------------

describe('Requirement vs Stock receives only unfulfilled quantities', () => {
  /**
   * SALES and Requirement vs Stock answer different questions about the same
   * rows. SALES is the customer record and keeps every line for ever, whatever
   * its status. Requirement vs Stock is the buying queue and carries only what
   * is still owed.
   *
   * The distinction is easy to lose: aggregating gross `quantity` would have
   * procurement re-buying goods a customer already has, and dropping partial
   * lines entirely would leave real demand unbought. Both mistakes are checked
   * here against the same fixtures.
   */
  it('aggregates across orders, counting outstanding only and keeping every line in SALES', async () => {
    const product = await makeProduct(0);

    // Three orders for one product, in the three fulfilment states.
    const unfulfilled = await makeOrder(product.id, 10);          // owes 10
    const partial = await makeOrder(product.id, 10);              // owes 6
    const fulfilled = await makeOrder(product.id, 10);            // owes 0

    await api('PATCH', `/api/procurement/order-lines/${partial.lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    await api('PATCH', `/api/procurement/order-lines/${fulfilled.lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    const { billId, itemId } = await makeBill(product.id, 6);
    await api('POST', `/api/procurement/bills/${billId}/items/${itemId}/allocations`, {
      token: adminToken, body: { salesOrderItemId: fulfilled.lineId, quantity: 6 },
    });

    // 10 + 6 + 0 — the fulfilled order contributes nothing.
    expect(await shortageFor(product.id)).toBe(16);

    // Yet all three remain on the SALES board with their own statuses.
    expect((await salesRow(unfulfilled.lineId)).status).toBe('UNFULFILLED');
    expect((await salesRow(partial.lineId)).status).toBe('PARTIAL');

    const done = await salesRow(fulfilled.lineId);
    expect(done.status).toBe('FULFILLED');
    expect(done.unfulfilledQty).toBe(0);
    // Still visible — a fulfilled order is history, not something to hide.
    expect(done.requiredQty).toBe(10);
    expect(done.totalFulfilled).toBe(10);
  });

  it('drops a product from the queue once every line is met', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 5);
    expect(await shortageFor(product.id)).toBe(5);

    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 5 },
    });

    expect(await shortageFor(product.id)).toBe(0);
    // The line is still on the SALES board, just fully met.
    expect((await salesRow(lineId)).status).toBe('FULFILLED');
  });

  it('re-enters the queue if the requirement grows beyond what was supplied', async () => {
    // Lowering recorded fulfilment must put the shortfall back on the queue —
    // the queue is derived every time, never a stored flag that could stick.
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 8);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 8 },
    });
    expect(await shortageFor(product.id)).toBe(0);

    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 3 },
    });
    expect(await shortageFor(product.id)).toBe(5);
    expect((await salesRow(lineId)).status).toBe('PARTIAL');
  });
});

// ---------------------------------------------------------------------------
//  Free-text demand
// ---------------------------------------------------------------------------

describe('Requirement vs Stock includes demand that is not in the catalogue', () => {
  /**
   * A requirement typed as free text is still a customer waiting for goods.
   * Keying the board by product id alone made that demand invisible to exactly
   * the people whose job is to buy it — the catalogue link should decide how a
   * row is *keyed*, never whether it counts.
   *
   * Aggregation is by the exact string. Normalising case or whitespace would
   * quietly merge two spellings into one product, and that is an identity
   * decision only a person should make.
   */
  const name = () => `zz-test Ganesha Idol ${Math.random().toString(36).slice(2, 8)}`;

  it('A — an unlinked line with 5 required and 1 fulfilled shows 4 outstanding', async () => {
    const productName = name();
    const { lineId } = await makeFreeTextOrder(productName, 5);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 1 },
    });

    const row = await unlinkedShortage(productName);
    expect(row, 'unlinked demand must reach the board').toBeDefined();
    expect(row!.totalRequired).toBe(4);
    expect(row!.linked).toBe(false);
    // No InventoryItem exists, so there is nothing to report but zero.
    expect(row!.onHand).toBe(0);

    // And it stays on the SALES board with its own figures.
    const sales = await salesRow(lineId);
    expect(sales.requiredQty).toBe(5);
    expect(sales.alreadyFulfilled).toBe(1);
    expect(sales.unfulfilledQty).toBe(4);
    expect(sales.status).toBe('PARTIAL');
  });

  it('B — a fully fulfilled unlinked line leaves the board but stays in SALES', async () => {
    const productName = name();
    const { lineId } = await makeFreeTextOrder(productName, 5);
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 5 },
    });

    const row = await unlinkedShortage(productName);
    // Either absent, or present with nothing outstanding — both mean the same
    // thing to procurement, and neither creates work.
    expect(row?.totalRequired ?? 0).toBe(0);

    const sales = await salesRow(lineId);
    expect(sales.status).toBe('FULFILLED');
    expect(sales.requiredQty).toBe(5);
  });

  it('C — two orders for the same exact name aggregate', async () => {
    const productName = name();
    const first = await makeFreeTextOrder(productName, 6);
    const second = await makeFreeTextOrder(productName, 4);

    expect((await unlinkedShortage(productName))!.totalRequired).toBe(10);

    // Fulfil part of one; the aggregate follows.
    await api('PATCH', `/api/procurement/order-lines/${first.lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 2 },
    });
    expect((await unlinkedShortage(productName))!.totalRequired).toBe(8);

    // Both lines remain individually visible in SALES.
    expect((await salesRow(first.lineId)).unfulfilledQty).toBe(4);
    expect((await salesRow(second.lineId)).unfulfilledQty).toBe(4);
  });

  it('C2 — two different spellings stay two rows, never silently merged', async () => {
    const base = Math.random().toString(36).slice(2, 8);
    const upper = `zz-test Ganesha Idol ${base}`;
    const lower = `zz-test ganesha idol ${base}`;
    await makeFreeTextOrder(upper, 3);
    await makeFreeTextOrder(lower, 7);

    expect((await unlinkedShortage(upper))!.totalRequired).toBe(3);
    expect((await unlinkedShortage(lower))!.totalRequired).toBe(7);
  });

  it('D — catalogue-linked behaviour is unchanged', async () => {
    const product = await makeProduct(0);
    const { lineId } = await makeOrder(product.id, 10);
    expect(await shortageFor(product.id)).toBe(10);

    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 4 },
    });
    expect(await shortageFor(product.id)).toBe(6);

    // The linked row still carries its inventory figure.
    const res = await api('GET', '/api/procurement/shortages', { token: adminToken });
    const rows = (res.body.data as { shortages: { product: { id: string } | null; linked: boolean }[] })
      .shortages;
    const row = rows.find((r) => r.linked && r.product?.id === product.id);
    expect(row).toBeDefined();
  });

  it('E — the board reflects fulfilment changes on the next read', async () => {
    const productName = name();
    const { lineId } = await makeFreeTextOrder(productName, 9);
    expect((await unlinkedShortage(productName))!.totalRequired).toBe(9);

    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 9 },
    });
    expect((await unlinkedShortage(productName))?.totalRequired ?? 0).toBe(0);

    // Lowering it puts the demand straight back — the board is derived every
    // read, never a stored flag that could stick.
    await api('PATCH', `/api/procurement/order-lines/${lineId}/fulfillment`, {
      token: adminToken, body: { alreadyFulfilled: 2 },
    });
    expect((await unlinkedShortage(productName))!.totalRequired).toBe(7);
  });

  it('creates no Product records as a side effect', async () => {
    const productName = name();
    await makeFreeTextOrder(productName, 5);
    await api('GET', '/api/procurement/shortages', { token: adminToken });

    const created = await prisma.product.count({ where: { name: productName } });
    expect(created, 'the board must never mint catalogue entries').toBe(0);
  });
});
