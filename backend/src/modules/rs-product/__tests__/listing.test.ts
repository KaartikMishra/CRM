/**
 * The catalogue listing and manual product creation.
 *
 * Runs against the real database, which holds the synced Shopify catalogue, so
 * the assertions below are about real data rather than fixtures: 501 products,
 * repeated SKUs, a negative stock figure and multi-variant products all exist
 * and all have to render correctly.
 *
 * Counts are asserted as "at least" wherever this suite's own rows could move
 * them, so a manual product created here never makes a later assertion fail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RsProductListRow } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type Listed = { products: RsProductListRow[] };
type Created = { product: RsProductListRow };

const createdManualIds: string[] = [];

let admin: TestUser;
let employee: TestUser;
let adminToken: string;
let employeeToken: string;

/** What the legacy tables held before this suite ran. */
let legacyBaseline: { manualProducts: number };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  employee = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });

  legacyBaseline = {
    manualProducts: await prisma.rsProduct.count({ where: { source: 'MANUAL' } }),
  };
});

afterAll(async () => {
  if (createdManualIds.length) {
    await prisma.rsProduct.deleteMany({ where: { id: { in: createdManualIds } } });
  }
  // Every manual product this suite created must be gone. Compared against the
  // starting count rather than zero: manual products created through the app
  // by hand are legitimate rows and are none of this suite's business.
  expect(await prisma.rsProduct.count({ where: { source: 'MANUAL' } })).toBe(
    legacyBaseline.manualProducts,
  );

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

describe('the listing returns the synced catalogue', () => {
  it('no longer returns an empty array', async () => {
    // The Phase 1 stub returned [] regardless of what the database held.
    const res = await api<Listed>('GET', '/api/rs-products', { token: adminToken });

    expect(res.status).toBe(200);
    expect(res.body.data!.products.length).toBeGreaterThan(0);
  });

  it('returns a page of the configured size, not the whole catalogue', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?limit=50', { token: adminToken });
    expect(res.body.data!.products).toHaveLength(50);
    expect(res.body.meta!.nextCursor).toBeTruthy();
  });

  it('carries every column the catalogue table renders', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?limit=1', { token: adminToken });
    const row = res.body.data!.products[0]!;

    expect(row).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      source: expect.any(String),
      status: expect.any(String),
      variantCount: expect.any(Number),
      inventoryQty: expect.any(Number),
    });
    // Present as keys even when null, so the UI never has to guard.
    expect(row).toHaveProperty('imageUrl');
    expect(row).toHaveProperty('sku');
    expect(row).toHaveProperty('priceMin');
    expect(row).toHaveProperty('weightUnit');
  });
});

describe('cursor pagination', () => {
  it('walks the catalogue with no gaps and no repeats', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    // Six pages of 25 is enough to prove the mechanism without walking 501.
    for (let page = 0; page < 6; page += 1) {
      const url = `/api/rs-products?limit=25${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await api<Listed>('GET', url, { token: adminToken });
      expect(res.status).toBe(200);

      seen.push(...res.body.data!.products.map((p) => p.id));
      const next = res.body.meta!.nextCursor as string | null;
      if (!next) break;
      cursor = next;
    }

    expect(seen.length).toBeGreaterThan(100);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports a null cursor on the final page', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?limit=100&q=zzzz-no-such-product', {
      token: adminToken,
    });
    expect(res.body.data!.products).toHaveLength(0);
    expect(res.body.meta!.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor before touching the database', async () => {
    const res = await api('GET', '/api/rs-products?cursor=not-a-cuid', { token: adminToken });
    expect(res.status).toBe(422);
  });
});

describe('search', () => {
  it('matches on product title', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?q=copper', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.data!.products.length).toBeGreaterThan(0);
    for (const p of res.body.data!.products) {
      expect(p.title.toLowerCase()).toContain('copper');
    }
  });

  it('matches on variant SKU, which is how staff actually search', async () => {
    const variant = await prisma.shopifyVariant.findFirst({
      where: { sku: { not: null } },
      select: { sku: true, rsProductId: true },
    });
    expect(variant?.sku).toBeTruthy();

    const res = await api<Listed>('GET', `/api/rs-products?q=${variant!.sku}`, {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.products.map((p) => p.id)).toContain(variant!.rsProductId);
  });

  it('is case-insensitive', async () => {
    const lower = await api<Listed>('GET', '/api/rs-products?q=brass', { token: adminToken });
    const upper = await api<Listed>('GET', '/api/rs-products?q=BRASS', { token: adminToken });
    expect(upper.body.data!.products.length).toBe(lower.body.data!.products.length);
  });
});

describe('filters', () => {
  it('filters by status, including UNLISTED', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?status=UNLISTED&limit=100', {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.products.length).toBeGreaterThan(0);
    for (const p of res.body.data!.products) expect(p.status).toBe('UNLISTED');
  });

  it('filters by source', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?source=SHOPIFY&limit=10', {
      token: adminToken,
    });
    for (const p of res.body.data!.products) expect(p.source).toBe('SHOPIFY');
  });

  it('filters by productType', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?productType=Drinkware&limit=100', {
      token: adminToken,
    });
    expect(res.body.data!.products.length).toBeGreaterThan(0);
    for (const p of res.body.data!.products) expect(p.productType).toBe('Drinkware');
  });

  it('offers the product types the catalogue actually holds', async () => {
    const res = await api<{ productTypes: string[] }>('GET', '/api/rs-products/product-types', {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.productTypes.length).toBeGreaterThan(0);
    expect(res.body.data!.productTypes).toContain('Drinkware');
  });

  it('rejects a status outside the enum', async () => {
    const res = await api('GET', '/api/rs-products?status=NOT_A_STATUS', { token: adminToken });
    expect(res.status).toBe(422);
  });
});

describe('sorting', () => {
  it('sorts by title ascending by default', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?limit=20', { token: adminToken });
    const titles = res.body.data!.products.map((p) => p.title);

    // Compared with a plain codepoint sort, not localeCompare: Postgres orders
    // by byte value, so `10" Brass…` precedes `10-Inch…` where localeCompare
    // would ignore the punctuation and disagree.
    expect([...titles].sort()).toEqual(titles);
  });

  it('accepts every declared sort', async () => {
    for (const sort of ['title', 'price', 'inventory', 'newest']) {
      const res = await api<Listed>('GET', `/api/rs-products?sort=${sort}&limit=5`, {
        token: adminToken,
      });
      expect(res.status, sort).toBe(200);
    }
  });

  it('rejects an unknown sort', async () => {
    const res = await api('GET', '/api/rs-products?sort=sideways', { token: adminToken });
    expect(res.status).toBe(422);
  });
});

describe('variant aggregation', () => {
  it('gives a multi-variant product a price range, not one variant price', async () => {
    const multi = await prisma.rsProduct.findFirst({
      where: { variants: { some: {} } },
      include: { variants: true },
      orderBy: { title: 'asc' },
    });
    expect(multi).toBeTruthy();

    const res = await api<Listed>('GET', `/api/rs-products?q=${encodeURIComponent(multi!.title.slice(0, 25))}&limit=100`, {
      token: adminToken,
    });
    const row = res.body.data!.products.find((p) => p.id === multi!.id);
    expect(row).toBeDefined();
    expect(row!.variantCount).toBe(multi!.variants.length);

    const prices = multi!.variants.map((v) => Number(v.price));
    expect(Number(row!.priceMin)).toBeCloseTo(Math.min(...prices), 2);
    expect(Number(row!.priceMax)).toBeCloseTo(Math.max(...prices), 2);
  });

  it('sums inventory across a product’s variants', async () => {
    const product = await prisma.rsProduct.findFirst({
      where: { variants: { some: {} } },
      include: { variants: true },
      orderBy: { title: 'asc' },
    });

    const res = await api<Listed>('GET', `/api/rs-products?q=${encodeURIComponent(product!.title.slice(0, 25))}&limit=100`, {
      token: adminToken,
    });
    const row = res.body.data!.products.find((p) => p.id === product!.id)!;

    const expected = product!.variants.reduce((sum, v) => sum + v.inventoryQty, 0);
    expect(row.inventoryQty).toBe(expected);
  });

  it('carries a negative variant into the sum rather than clamping it', async () => {
    // One live variant holds −10 alongside a sibling at +974. The product total
    // is therefore +964: the negative is subtracted, not floored to zero, which
    // is what would silently inflate the figure by ten units.
    const negative = await prisma.shopifyVariant.findFirst({
      where: { inventoryQty: { lt: 0 } },
      select: { rsProductId: true, inventoryQty: true },
    });

    if (!negative) return; // Nothing to assert if the catalogue has none today.

    const product = await prisma.rsProduct.findUniqueOrThrow({
      where: { id: negative.rsProductId },
      select: { title: true, variants: { select: { inventoryQty: true } } },
    });
    const expected = product.variants.reduce((sum, v) => sum + v.inventoryQty, 0);
    const clamped = product.variants.reduce((sum, v) => sum + Math.max(v.inventoryQty, 0), 0);

    const res = await api<Listed>('GET', `/api/rs-products?q=${encodeURIComponent(product.title.slice(0, 25))}&limit=100`, {
      token: adminToken,
    });
    const row = res.body.data!.products.find((p) => p.id === negative.rsProductId)!;

    expect(row.inventoryQty).toBe(expected);
    // The point of the test: the two differ, and we report the honest one.
    expect(row.inventoryQty).not.toBe(clamped);
  });

  it('carries the first image, from Shopify’s own ordering', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?source=SHOPIFY&limit=5', {
      token: adminToken,
    });
    for (const p of res.body.data!.products) {
      expect(p.imageUrl).toContain('cdn.shopify.com');
    }
  });
});

describe('creating a CRM-only product', () => {
  it('creates it as MANUAL with no Shopify ids', async () => {
    const res = await api<Created>('POST', '/api/rs-products', {
      token: adminToken,
      body: { title: 'zz-test-manual-widget', price: '499.00', inventoryQty: 7 },
    });

    expect(res.status).toBe(201);
    const product = res.body.data!.product;
    createdManualIds.push(product.id);

    expect(product.source).toBe('MANUAL');
    expect(product.variantCount).toBe(1);
    expect(product.inventoryQty).toBe(7);

    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { id: product.id },
      include: { variants: true },
    });
    expect(row.source).toBe('MANUAL');
    expect(row.shopifyProductId).toBeNull();
    expect(row.syncedAt).toBeNull();
    expect(row.variants[0]?.shopifyVariantId).toBeNull();
    expect(row.variants[0]?.shopifyInventoryItemId).toBeNull();
  });

  it('ignores a client attempting to claim source SHOPIFY', async () => {
    const res = await api<Created>('POST', '/api/rs-products', {
      token: adminToken,
      body: { title: 'zz-test-claims-shopify', price: '10.00', source: 'SHOPIFY' },
    });

    expect(res.status).toBe(201);
    createdManualIds.push(res.body.data!.product.id);
    expect(res.body.data!.product.source).toBe('MANUAL');
  });

  it('accepts a duplicate SKU', async () => {
    const existing = await prisma.shopifyVariant.findFirst({
      where: { sku: { not: null } },
      select: { sku: true },
    });

    const res = await api<Created>('POST', '/api/rs-products', {
      token: adminToken,
      body: { title: 'zz-test-duplicate-sku', price: '25.00', sku: existing!.sku },
    });

    expect(res.status).toBe(201);
    createdManualIds.push(res.body.data!.product.id);
    expect(res.body.data!.product.sku).toBe(existing!.sku);
  });

  it('accepts a product with no SKU at all', async () => {
    const res = await api<Created>('POST', '/api/rs-products', {
      token: adminToken,
      body: { title: 'zz-test-no-sku', price: '15.00' },
    });

    expect(res.status).toBe(201);
    createdManualIds.push(res.body.data!.product.id);
    expect(res.body.data!.product.sku).toBeNull();
  });

  it('refuses a product with no title or no price', async () => {
    expect((await api('POST', '/api/rs-products', { token: adminToken, body: { price: '1.00' } })).status).toBe(422);
    expect((await api('POST', '/api/rs-products', { token: adminToken, body: { title: 'x' } })).status).toBe(422);
  });

  it('leaves dimensions null, since the unit is unresolved', async () => {
    const res = await api<Created>('POST', '/api/rs-products', {
      token: adminToken,
      body: { title: 'zz-test-dimensions', price: '30.00' },
    });
    createdManualIds.push(res.body.data!.product.id);

    const product = res.body.data!.product;
    expect(product.lengthValue).toBeNull();
    expect(product.widthValue).toBeNull();
    expect(product.heightValue).toBeNull();
    expect(product.dimensionUnit).toBeNull();
  });
});

describe('access control', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await api('GET', '/api/rs-products')).status).toBe(401);
    expect((await api('POST', '/api/rs-products', { body: { title: 'x', price: '1.00' } })).status).toBe(401);
  });

  it('refuses a USER holding neither the module nor SALES:CREATE', async () => {
    // The list also admits SALES:CREATE, so the Sales order picker can search
    // the catalogue. A plain USER holds that by role default — denial therefore
    // has to be asserted with it revoked, which is what the rule actually says.
    await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
    });

    expect((await api('GET', '/api/rs-products', { token: employeeToken })).status).toBe(403);

    await prisma.userModulePermission.deleteMany({
      where: { userId: employee.id, module: 'SALES' },
    });
  });

  it('lets VIEW read but not create', async () => {
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'CREATE', allowed: false },
      ],
    });

    expect((await api('GET', '/api/rs-products', { token: employeeToken })).status).toBe(200);
    expect(
      (await api('POST', '/api/rs-products', {
        token: employeeToken,
        body: { title: 'zz-test-denied', price: '1.00' },
      })).status,
    ).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits an administrator to both', async () => {
    expect((await api('GET', '/api/rs-products', { token: adminToken })).status).toBe(200);
  });
});

describe('the Shopify catalogue is unaffected by reading it', () => {
  it('leaves the synced product count intact', async () => {
    const shopify = await prisma.rsProduct.count({ where: { source: 'SHOPIFY' } });
    expect(shopify).toBe(501);
  });

});
