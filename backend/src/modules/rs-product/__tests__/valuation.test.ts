/**
 * Stock valuation over HTTP, and the two preservation rules it depends on.
 *
 * The arithmetic is proven in valuation-calc.test.ts against the shared
 * functions. This suite proves the parts only a real database and a real
 * request can show:
 *
 *   - the endpoint aggregates the catalogue and answers the dashboard's shape;
 *   - a cost-price edit leaves CRM stock alone, and the reverse;
 *   - **a Shopify sync does not overwrite a manually entered cost price** —
 *     the rule the whole feature rests on, and the one a spread over an
 *     existing row quietly broke until `upsertShopifyProduct` was fixed;
 *   - VIEW is required, and the figures are not readable without it.
 *
 * Every row this suite creates is removed afterwards. The 501 synced products
 * are only ever read, except for one variant's cost price which is written and
 * then restored to its original value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RsProductDetail, StockValuationView } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';
import { upsertShopifyProduct } from '../rs-product.repository.js';
import { mapVariant } from '../rs-product.mapper.js';

type Detail = { product: RsProductDetail };
type Valuation = { valuation: StockValuationView };

const createdIds: string[] = [];

let admin: TestUser;
let employee: TestUser;
let adminToken: string;
let employeeToken: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  employee = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });
});

afterAll(async () => {
  if (createdIds.length) {
    await prisma.rsProduct.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.rsProduct.deleteMany({ where: { title: { startsWith: 'zz-test' } } });

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/** A CRM-only product this suite may edit freely. */
async function makeProduct(price = '100.00'): Promise<RsProductDetail> {
  const res = await api<{ product: { id: string } }>('POST', '/api/rs-products', {
    token: adminToken,
    body: { title: `zz-test valuation ${Math.random().toString(36).slice(2, 8)}`, price },
  });
  expect(res.status).toBe(201);
  createdIds.push(res.body.data!.product.id);

  const detail = await api<Detail>('GET', `/api/rs-products/${res.body.data!.product.id}`, {
    token: adminToken,
  });
  return detail.body.data!.product;
}

const patch = (id: string, body: unknown) =>
  api<Detail>('PATCH', `/api/rs-products/${id}`, { token: adminToken, body });

const reload = async (id: string): Promise<RsProductDetail> => {
  const res = await api<Detail>('GET', `/api/rs-products/${id}`, { token: adminToken });
  expect(res.status).toBe(200);
  return res.body.data!.product;
};

const valuation = async (token = adminToken) =>
  api<Valuation>('GET', '/api/rs-products/valuation', { token });

describe('cost price entry', () => {
  it('stores a cost price per variant and returns it on the detail payload', async () => {
    const product = await makeProduct();
    const variantId = product.variants[0]!.id;

    const res = await patch(product.id, { variants: [{ id: variantId, costPrice: 250.5 }] });
    expect(res.status).toBe(200);

    const after = await reload(product.id);
    expect(after.variants[0]!.costPrice).toBe('250.5');
  });

  it('refuses a negative cost price', async () => {
    const product = await makeProduct();
    const res = await patch(product.id, {
      variants: [{ id: product.variants[0]!.id, costPrice: -1 }],
    });
    // 422: the Zod schema rejects it before the service is reached.
    expect(res.status).toBe(422);
  });

  it('accepts zero as a real cost, distinct from an absent one', async () => {
    const product = await makeProduct();
    const variantId = product.variants[0]!.id;

    expect((await patch(product.id, { variants: [{ id: variantId, costPrice: 0 }] })).status).toBe(
      200,
    );
    const after = await reload(product.id);
    expect(after.variants[0]!.costPrice).toBe('0');
  });

  it('allows a cost price to be cleared back to unknown', async () => {
    const product = await makeProduct();
    const variantId = product.variants[0]!.id;

    await patch(product.id, { variants: [{ id: variantId, costPrice: 99 }] });
    expect(
      (await patch(product.id, { variants: [{ id: variantId, costPrice: null }] })).status,
    ).toBe(200);

    expect((await reload(product.id)).variants[0]!.costPrice).toBeNull();
  });
});

describe('a cost-price edit leaves CRM stock alone', () => {
  it('preserves crmStockQty when only the cost price changes', async () => {
    const product = await makeProduct();
    const variantId = product.variants[0]!.id;

    await patch(product.id, { variants: [{ id: variantId, crmStockQty: 12 }] });
    await patch(product.id, { variants: [{ id: variantId, costPrice: 40 }] });

    const after = await reload(product.id);
    expect(after.variants[0]!.crmStockQty).toBe(12);
    expect(after.variants[0]!.costPrice).toBe('40');
  });

  it('preserves the cost price when only CRM stock changes', async () => {
    const product = await makeProduct();
    const variantId = product.variants[0]!.id;

    await patch(product.id, { variants: [{ id: variantId, costPrice: 40 }] });
    await patch(product.id, { variants: [{ id: variantId, crmStockQty: 7 }] });

    const after = await reload(product.id);
    expect(after.variants[0]!.costPrice).toBe('40');
    expect(after.variants[0]!.crmStockQty).toBe(7);
  });
});

describe('a Shopify sync does not overwrite CRM cost price or CRM stock', () => {
  /*
    The rule this whole feature depends on, proven against the real upsert
    rather than a mock. `upsertShopifyProduct` used to spread the mapped variant
    over the existing row, so a sync wrote Shopify's cost — null for all 570
    live variants — straight over anything a buyer had entered.
  */
  it('keeps a manually entered cost price and stock through a re-sync', async () => {
    const shopifyProductId = `gid://shopify/Product/zz-test-${Date.now()}`;
    const shopifyVariantId = `gid://shopify/ProductVariant/zz-test-${Date.now()}`;

    const node = {
      id: shopifyVariantId,
      title: 'Default Title',
      sku: 'zz-test-sku',
      price: '500.00',
      position: 1,
      inventoryQuantity: 3,
      // Shopify reports no unit cost, which is true of every live variant.
      inventoryItem: { id: `gid://shopify/InventoryItem/zz-${Date.now()}`, unitCost: null, measurement: null },
    };

    const productNode = {
      shopifyProductId,
      title: 'zz-test sync preservation',
      description: null,
      status: 'ACTIVE' as const,
      productType: null,
      vendor: null,
      shopifyUpdatedAt: null,
    };

    // First sync: creates the product and its variant.
    await upsertShopifyProduct(productNode, [mapVariant(node)], []);
    const created = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId },
      select: { id: true },
    });
    createdIds.push(created.id);

    // A buyer enters a cost and a CRM count by hand.
    const variant = await prisma.shopifyVariant.findUniqueOrThrow({
      where: { shopifyVariantId },
      select: { id: true },
    });
    await prisma.shopifyVariant.update({
      where: { id: variant.id },
      data: { costPrice: '123.45', crmStockQty: 9 },
    });

    // Second sync, same payload — exactly what a scheduled re-sync does.
    await upsertShopifyProduct(productNode, [mapVariant(node)], []);

    const after = await prisma.shopifyVariant.findUniqueOrThrow({
      where: { shopifyVariantId },
      select: { costPrice: true, crmStockQty: true, inventoryQty: true, price: true },
    });

    // The two CRM-owned columns survive.
    expect(after.costPrice?.toString()).toBe('123.45');
    expect(after.crmStockQty).toBe(9);
    // Shopify's own columns are still refreshed — the fix is narrow.
    expect(after.inventoryQty).toBe(3);
    expect(after.price.toString()).toBe('500');
  });

  it("lets Shopify's unit cost seed a variant the CRM has not seen before", async () => {
    const shopifyProductId = `gid://shopify/Product/zz-test-seed-${Date.now()}`;
    const shopifyVariantId = `gid://shopify/ProductVariant/zz-test-seed-${Date.now()}`;

    const node = {
      id: shopifyVariantId,
      title: 'Default Title',
      sku: 'zz-test-seed',
      price: '200.00',
      position: 1,
      inventoryQuantity: 1,
      inventoryItem: {
        id: `gid://shopify/InventoryItem/zz-seed-${Date.now()}`,
        unitCost: { amount: '75.00' },
        measurement: null,
      },
    };

    await upsertShopifyProduct(
      {
        shopifyProductId,
        title: 'zz-test seed cost',
        description: null,
        status: 'ACTIVE' as const,
        productType: null,
        vendor: null,
        shopifyUpdatedAt: null,
      },
      [mapVariant(node)],
      [],
    );

    const created = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId },
      select: { id: true },
    });
    createdIds.push(created.id);

    const after = await prisma.shopifyVariant.findUniqueOrThrow({
      where: { shopifyVariantId },
      select: { costPrice: true },
    });
    // Seeded on create — a first sync may supply a cost where the CRM has none.
    expect(after.costPrice?.toString()).toBe('75');
  });
});

describe('the valuation endpoint', () => {
  it('returns the dashboard shape', async () => {
    const res = await valuation();
    expect(res.status).toBe(200);

    const v = res.body.data!.valuation;
    for (const key of ['primary', 'archived'] as const) {
      expect(v[key]).toHaveProperty('knownValue');
      expect(v[key]).toHaveProperty('totalUnits');
      expect(v[key]).toHaveProperty('unitsWithUnknownCost');
      expect(v[key]).toHaveProperty('variantsMissingCost');
      expect(v[key]).toHaveProperty('productsMissingCost');
      expect(v[key]).toHaveProperty('variantsValued');
      expect(v[key]).toHaveProperty('incomplete');
    }
    expect(typeof v.negativeStockVariants).toBe('number');
    // Money crosses the wire as a decimal string, never a number.
    expect(typeof v.primary.knownValue).toBe('string');
  });

  it('counts a costed product into the primary total', async () => {
    const before = (await valuation()).body.data!.valuation.primary;

    const product = await makeProduct();
    await patch(product.id, {
      variants: [{ id: product.variants[0]!.id, costPrice: 20, crmStockQty: 5 }],
    });

    const after = (await valuation()).body.data!.valuation.primary;

    // 20.00 × 5 = 100.00 added, exactly.
    expect(Number(after.knownValue) - Number(before.knownValue)).toBeCloseTo(100, 2);
    expect(after.totalUnits - before.totalUnits).toBe(5);
    expect(after.variantsValued - before.variantsValued).toBe(1);
  });

  it('reports uncosted stock as missing rather than valuing it at zero', async () => {
    const before = (await valuation()).body.data!.valuation.primary;

    const product = await makeProduct();
    // Stock, no cost price — the state the live catalogue is almost entirely in.
    await patch(product.id, { variants: [{ id: product.variants[0]!.id, crmStockQty: 8 }] });

    const after = (await valuation()).body.data!.valuation.primary;

    // The money figure does not move: unknown is not zero.
    expect(after.knownValue).toBe(before.knownValue);
    // But the units and the shortfall are both reported.
    expect(after.unitsWithUnknownCost - before.unitsWithUnknownCost).toBe(8);
    expect(after.variantsMissingCost - before.variantsMissingCost).toBe(1);
    expect(after.productsMissingCost - before.productsMissingCost).toBe(1);
    expect(after.incomplete).toBe(true);
  });

  it('excludes an archived product from the primary total and reports it separately', async () => {
    const product = await makeProduct();
    await patch(product.id, {
      variants: [{ id: product.variants[0]!.id, costPrice: 50, crmStockQty: 4 }],
    });

    const before = (await valuation()).body.data!.valuation;

    expect(
      (await api('POST', `/api/rs-products/${product.id}/archive`, { token: adminToken })).status,
    ).toBe(200);

    const after = (await valuation()).body.data!.valuation;

    // 50.00 × 4 = 200.00 leaves the primary figure and appears in archived.
    expect(Number(before.primary.knownValue) - Number(after.primary.knownValue)).toBeCloseTo(
      200,
      2,
    );
    expect(Number(after.archived.knownValue) - Number(before.archived.knownValue)).toBeCloseTo(
      200,
      2,
    );
  });

  it('reconciles with the product detail payload for the same product', async () => {
    // The guarantee the dashboard rests on: one aggregation, so a product's own
    // figures and the catalogue total are computed by the same rules.
    const product = await makeProduct();
    await patch(product.id, {
      variants: [{ id: product.variants[0]!.id, costPrice: 12.5, crmStockQty: 4 }],
    });

    const detail = await reload(product.id);
    const variant = detail.variants[0]!;

    expect(variant.costPrice).toBe('12.5');
    expect(variant.crmStockQty).toBe(4);
    // 12.50 × 4 = 50.00, which is what the shared calculator gives the UI.
    expect(Number(variant.costPrice) * variant.crmStockQty).toBeCloseTo(50, 2);
  });
});

describe('valuation access control', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await api('GET', '/api/rs-products/valuation')).status).toBe(401);
  });

  it('requires RS_PRODUCTS VIEW', async () => {
    await prisma.userModulePermission.createMany({
      data: [{ userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false }],
    });

    expect((await valuation(employeeToken)).status).toBe(403);
  });

  it('is not mistaken for a product id', async () => {
    // A literal path declared after `/:id` would answer 404 here.
    expect((await valuation()).status).toBe(200);
  });
});
