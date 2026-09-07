/**
 * Putting a free-text order line's product into the catalogue.
 *
 * A logical product belongs in Product Master once. Free text arrives spelled
 * every possible way — "Kansa Dinner Set" on an order, "kansadinnerset" on a
 * bill — and creating one product per spelling would split a single item's
 * stock across rivals that no report could reconcile.
 *
 * So identity is the folded name, and the unique index on it is the authority:
 * these cover reuse, creation, the inactive case, and the race two people
 * clicking at once would otherwise win.
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
  residualTestRows,
  salesOrderPayload,
  trackProduct,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let outsider: TestUser;
let adminToken: string;
let outsiderToken: string;
let customer: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  outsider = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });
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

/** A name nothing else in the database can collide with. */
const uniqueName = (): string =>
  `${TEST_PREFIX} Cat ${Math.random().toString(36).slice(2, 10)}`;

type OrderBody = { order: { id: string; items: { id: string; productName: string }[] } };

/** An order carrying one free-text line, returning that line's id. */
async function lineWithName(productName: string): Promise<string> {
  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName, quantity: 5, price: '100.00' }],
    }),
  });
  expect(res.status).toBe(201);
  const order = (res.body.data as OrderBody).order;
  trackSalesOrder(order.id);
  return order.items[0]!.id;
}

async function putInCatalogue(
  salesOrderItemId: string,
  token = adminToken,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return api('POST', '/api/procurement/order-lines/put-in-catalogue', {
    token,
    body: { salesOrderItemId },
  }) as Promise<{ status: number; body: Record<string, unknown> }>;
}

/** The catalogue entry a line ended up linked to. */
async function linkedProduct(salesOrderItemId: string) {
  const line = await prisma.salesOrderItem.findUnique({
    where: { id: salesOrderItemId },
    select: { productId: true, productName: true, quantity: true, alreadyFulfilled: true },
  });
  const product = line?.productId
    ? await prisma.product.findUnique({
        where: { id: line.productId },
        select: { id: true, name: true, normalizedName: true, isActive: true },
      })
    : null;
  return { line, product };
}

describe('putting a product in the catalogue', () => {
  it('creates the product once, with an inventory row, and links the line', async () => {
    const name = uniqueName();
    const lineId = await lineWithName(name);

    const res = await putInCatalogue(lineId);
    expect(res.status).toBe(200);

    const { line, product } = await linkedProduct(lineId);
    expect(product).not.toBeNull();
    trackProduct(product!.id);

    // The catalogue records the line's own wording, folded only for identity.
    expect(product!.name).toBe(name);
    expect(product!.normalizedName).toBe(normalizeProductName(name));
    expect(product!.isActive).toBe(true);
    expect(line!.productId).toBe(product!.id);
    // And the line's own figures are untouched by cataloguing.
    expect(line!.productName).toBe(name);
    expect(line!.quantity).toBe(5);
    expect(line!.alreadyFulfilled).toBe(0);

    const inventory = await prisma.inventoryItem.findMany({ where: { productId: product!.id } });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.onHand).toBe(0);
  });

  it('reuses the existing product for a differently spelled line', async () => {
    const name = uniqueName();
    const first = await lineWithName(name);
    expect((await putInCatalogue(first)).status).toBe(200);
    const created = (await linkedProduct(first)).product!;
    trackProduct(created.id);

    // Same product, spelled four other ways.
    for (const spelling of [
      name.toUpperCase(),
      name.toLowerCase(),
      name.replace(/ /g, '   '),
      name.replace(/ /g, ''),
    ]) {
      const lineId = await lineWithName(spelling);
      expect((await putInCatalogue(lineId)).status, spelling).toBe(200);
      const { line, product } = await linkedProduct(lineId);
      expect(product!.id, spelling).toBe(created.id);
      // The order keeps its own wording; only the link is shared.
      expect(line!.productName, spelling).toBe(spelling);
    }

    // Still exactly one catalogue entry for this identity.
    const rows = await prisma.product.findMany({
      where: { normalizedName: normalizeProductName(name) },
      select: { id: true, name: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(name);
  });

  it('resolves the "brass dinner set" / "brassdinnerset" collision to one product', async () => {
    const stem = `${TEST_PREFIX} Brass Dinner ${Math.random().toString(36).slice(2, 8)}`;
    const spaced = await lineWithName(stem);
    expect((await putInCatalogue(spaced)).status).toBe(200);
    const created = (await linkedProduct(spaced)).product!;
    trackProduct(created.id);

    const squashed = await lineWithName(stem.replace(/ /g, ''));
    expect((await putInCatalogue(squashed)).status).toBe(200);
    expect((await linkedProduct(squashed)).product!.id).toBe(created.id);
  });

  it('never creates a second product under concurrent requests', async () => {
    const name = uniqueName();
    const lines = await Promise.all([
      lineWithName(name),
      lineWithName(name.toUpperCase()),
      lineWithName(name.toLowerCase()),
    ]);

    // Fired together: the unique index, not the lookup, is what decides.
    const results = await Promise.all(lines.map((id) => putInCatalogue(id)));
    for (const r of results) expect(r.status).toBe(200);

    const rows = await prisma.product.findMany({
      where: { normalizedName: normalizeProductName(name) },
      select: { id: true },
    });
    expect(rows).toHaveLength(1);
    trackProduct(rows[0]!.id);

    // Every line landed on that one product.
    for (const id of lines) {
      expect((await linkedProduct(id)).product!.id).toBe(rows[0]!.id);
    }
  });

  it('refuses when a normalized match exists but is inactive', async () => {
    const name = uniqueName();
    const seeded = await prisma.product.create({
      data: {
        name,
        normalizedName: normalizeProductName(name),
        isActive: false,
        inventory: { create: { onHand: 0 } },
      },
      select: { id: true },
    });
    trackProduct(seeded.id);

    const lineId = await lineWithName(name.toUpperCase());
    const res = await putInCatalogue(lineId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRODUCT_EXISTS_INACTIVE');

    // No rival was created, the inactive product was not revived, and the line
    // stays unlinked rather than being attached to something retired.
    const rows = await prisma.product.findMany({
      where: { normalizedName: normalizeProductName(name) },
      select: { id: true, isActive: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isActive).toBe(false);
    expect((await linkedProduct(lineId)).line!.productId).toBeNull();
  });

  it('refuses a line that is already linked', async () => {
    const lineId = await lineWithName(uniqueName());
    expect((await putInCatalogue(lineId)).status).toBe(200);
    trackProduct((await linkedProduct(lineId)).product!.id);

    const again = await putInCatalogue(lineId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ORDER_LINE_ALREADY_LINKED');
  });

  it('refuses an unknown order line', async () => {
    const res = await putInCatalogue('ckd0000000000000000000000');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALES_ORDER_ITEM_NOT_FOUND');
  });

  it('keeps the existing RBAC — PROCUREMENT CREATE is required', async () => {
    const lineId = await lineWithName(uniqueName());
    const res = await putInCatalogue(lineId, outsiderToken);
    expect(res.status).toBe(403);
    // Nothing was catalogued on a refused request.
    expect((await linkedProduct(lineId)).line!.productId).toBeNull();
  });

  it('refuses an unauthenticated request', async () => {
    const res = await api('POST', '/api/procurement/order-lines/put-in-catalogue', {
      body: { salesOrderItemId: 'ckd0000000000000000000000' },
    });
    expect(res.status).toBe(401);
  });
});
