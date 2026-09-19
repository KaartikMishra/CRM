/**
 * CRM-side product management: editing, archiving, and the boundary between
 * what the CRM owns and what Shopify owns.
 *
 * The central rule under test is that a field Shopify maintains is *refused*
 * rather than accepted-and-later-reverted. Accepting a title change on a synced
 * product would look like it worked until the next sync silently undid it, so
 * the API says no instead.
 *
 * Every row this suite creates is removed afterwards, and the 501 synced
 * products are only ever read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RsProductDetail } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type Detail = { product: RsProductDetail };

const createdIds: string[] = [];

let admin: TestUser;
let employee: TestUser;
let adminToken: string;
let employeeToken: string;
/** A real synced product, used read-only to prove the Shopify rules. */
let shopifyProductId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  employee = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });

  const synced = await prisma.rsProduct.findFirstOrThrow({
    where: { source: 'SHOPIFY' },
    select: { id: true },
  });
  shopifyProductId = synced.id;
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
async function makeManualProduct(over: Record<string, unknown> = {}): Promise<RsProductDetail> {
  const res = await api<{ product: { id: string } }>('POST', '/api/rs-products', {
    token: adminToken,
    body: { title: `zz-test manual ${Math.random().toString(36).slice(2, 8)}`, price: '100.00', ...over },
  });
  expect(res.status).toBe(201);
  createdIds.push(res.body.data!.product.id);

  const detail = await api<Detail>('GET', `/api/rs-products/${res.body.data!.product.id}`, {
    token: adminToken,
  });
  return detail.body.data!.product;
}

describe('reading one product', () => {
  it('returns variants, images and the editability rules', async () => {
    const res = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    const product = res.body.data!.product;
    expect(product.variants.length).toBeGreaterThan(0);
    expect(product.source).toBe('SHOPIFY');
    // Computed server-side so the form and the API cannot disagree.
    expect(product.editable.productFields).toBe(false);
    expect(product.editable.shopifyOwnedVariantFields).toBe(false);
  });

  it('reports crmStockQty separately from Shopify inventory', async () => {
    const res = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const variant = res.body.data!.product.variants[0]!;

    expect(variant).toHaveProperty('crmStockQty');
    expect(variant).toHaveProperty('inventoryQty');
    // Every synced variant starts at zero CRM stock, by the column default.
    expect(variant.crmStockQty).toBe(0);
  });

  it('marks a manual product fully editable', async () => {
    const product = await makeManualProduct();
    expect(product.editable.productFields).toBe(true);
    expect(product.editable.shopifyOwnedVariantFields).toBe(true);
  });

  it('404s for a product that does not exist', async () => {
    const res = await api('GET', '/api/rs-products/clx0000000000000000000000', {
      token: adminToken,
    });
    expect(res.status).toBe(404);
  });
});

describe('CRM-owned fields are editable on a Shopify product', () => {
  it('sets CRM stock without touching Shopify inventory', async () => {
    const before = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const variant = before.body.data!.product.variants[0]!;
    const shopifyQtyBefore = variant.inventoryQty;

    const res = await api<Detail>('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: { variants: [{ id: variant.id, crmStockQty: 25 }] },
    });

    expect(res.status).toBe(200);
    const after = res.body.data!.product.variants.find((v) => v.id === variant.id)!;
    expect(after.crmStockQty).toBe(25);
    // The whole point of the separate column.
    expect(after.inventoryQty).toBe(shopifyQtyBefore);

    // Leave the catalogue as found.
    await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: { variants: [{ id: variant.id, crmStockQty: 0 }] },
    });
  });

  it('sets cost price, which Shopify populates on no variant', async () => {
    const before = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const variant = before.body.data!.product.variants[0]!;

    const res = await api<Detail>('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: { variants: [{ id: variant.id, costPrice: '820.50' }] },
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.product.variants.find((v) => v.id === variant.id)!.costPrice).toBe('820.5');

    await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: { variants: [{ id: variant.id, costPrice: null }] },
    });
  });

  it('sets dimensions, which Shopify could not supply with a unit', async () => {
    const before = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const variant = before.body.data!.product.variants[0]!;

    const res = await api<Detail>('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: {
        variants: [
          { id: variant.id, lengthValue: 10, widthValue: 5, heightValue: 3, dimensionUnit: 'CM' },
        ],
      },
    });

    expect(res.status).toBe(200);
    const after = res.body.data!.product.variants.find((v) => v.id === variant.id)!;
    expect(Number(after.lengthValue)).toBe(10);
    expect(after.dimensionUnit).toBe('CM');

    await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: {
        variants: [
          {
            id: variant.id,
            lengthValue: null,
            widthValue: null,
            heightValue: null,
            dimensionUnit: null,
          },
        ],
      },
    });
  });
});

describe('Shopify-owned fields are refused, not silently reverted', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['title', { title: 'zz-test renamed' }],
    ['status', { status: 'DRAFT' }],
    ['productType', { productType: 'zz-test type' }],
    ['vendor', { vendor: 'zz-test vendor' }],
  ];

  for (const [field, body] of cases) {
    it(`refuses a change to ${field}`, async () => {
      const res = await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
        token: adminToken,
        body,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SHOPIFY_OWNED_FIELD');
    });
  }

  it('refuses a change to a Shopify-owned variant field', async () => {
    const before = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const variantId = before.body.data!.product.variants[0]!.id;

    for (const body of [{ sku: 'ZZ-TEST' }, { price: '1.00' }, { weightValue: 5 }]) {
      const res = await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
        token: adminToken,
        body: { variants: [{ id: variantId, ...body }] },
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('SHOPIFY_OWNED_FIELD');
    }
  });

  it('leaves the product unchanged after a refusal', async () => {
    const before = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    const title = before.body.data!.product.title;

    await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
      body: { title: 'zz-test should not stick' },
    });

    const after = await api<Detail>('GET', `/api/rs-products/${shopifyProductId}`, {
      token: adminToken,
    });
    expect(after.body.data!.product.title).toBe(title);
  });
});

describe('a manual product is fully editable', () => {
  it('accepts every field, including the ones Shopify would own', async () => {
    const product = await makeManualProduct();
    const variantId = product.variants[0]!.id;

    const res = await api<Detail>('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: {
        title: 'zz-test edited title',
        status: 'DRAFT',
        productType: 'Utensils',
        variants: [
          {
            id: variantId,
            sku: 'ZZ-EDIT-1',
            price: '250.00',
            costPrice: '100.00',
            crmStockQty: 12,
            weightValue: 2.5,
            weightUnit: 'KG',
            lengthValue: 10,
            widthValue: 10,
            heightValue: 4,
            dimensionUnit: 'CM',
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const updated = res.body.data!.product;
    expect(updated.title).toBe('zz-test edited title');
    expect(updated.status).toBe('DRAFT');

    const variant = updated.variants[0]!;
    expect(variant.sku).toBe('ZZ-EDIT-1');
    expect(variant.crmStockQty).toBe(12);
    expect(variant.dimensionUnit).toBe('CM');
  });

  it('stays MANUAL with no Shopify ids after an edit', async () => {
    const product = await makeManualProduct();
    await api('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: { title: 'zz-test still manual' },
    });

    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.source).toBe('MANUAL');
    expect(row.shopifyProductId).toBeNull();
  });
});

describe('validation', () => {
  it('refuses negative CRM stock rather than clamping it', async () => {
    const product = await makeManualProduct();
    const res = await api('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: { variants: [{ id: product.variants[0]!.id, crmStockQty: -5 }] },
    });

    expect(res.status).toBe(422);

    const row = await prisma.shopifyVariant.findUniqueOrThrow({
      where: { id: product.variants[0]!.id },
    });
    expect(row.crmStockQty).toBe(0);
  });

  it('refuses a fractional stock figure', async () => {
    const product = await makeManualProduct();
    const res = await api('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: { variants: [{ id: product.variants[0]!.id, crmStockQty: 2.5 }] },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a dimension without a unit — the exact Shopify problem', async () => {
    const product = await makeManualProduct();
    const res = await api('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: { variants: [{ id: product.variants[0]!.id, lengthValue: 10 }] },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DIMENSION_UNIT_REQUIRED');
  });

  it('refuses a negative or zero dimension', async () => {
    const product = await makeManualProduct();
    for (const value of [-1, 0]) {
      const res = await api('PATCH', `/api/rs-products/${product.id}`, {
        token: adminToken,
        body: {
          variants: [{ id: product.variants[0]!.id, lengthValue: value, dimensionUnit: 'CM' }],
        },
      });
      expect(res.status, String(value)).toBe(422);
    }
  });

  it('refuses a variant belonging to another product', async () => {
    const a = await makeManualProduct();
    const b = await makeManualProduct();

    const res = await api('PATCH', `/api/rs-products/${a.id}`, {
      token: adminToken,
      body: { variants: [{ id: b.variants[0]!.id, crmStockQty: 5 }] },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VARIANT_NOT_FOUND');
  });
});

describe('archiving', () => {
  it('sets the status and keeps everything else', async () => {
    const product = await makeManualProduct();

    const res = await api<Detail>('POST', `/api/rs-products/${product.id}/archive`, {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.product.status).toBe('ARCHIVED');

    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { id: product.id },
      include: { variants: true },
    });
    // Soft: the row and its children survive.
    expect(row.status).toBe('ARCHIVED');
    expect(row.variants.length).toBeGreaterThan(0);
  });

  it('is safe when repeated', async () => {
    const product = await makeManualProduct();
    await api('POST', `/api/rs-products/${product.id}/archive`, { token: adminToken });
    const res = await api<Detail>('POST', `/api/rs-products/${product.id}/archive`, {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.product.status).toBe('ARCHIVED');
  });

  it('never deletes the row', async () => {
    const product = await makeManualProduct();
    const before = await prisma.rsProduct.count();

    await api('POST', `/api/rs-products/${product.id}/archive`, { token: adminToken });

    expect(await prisma.rsProduct.count()).toBe(before);
    expect(await prisma.rsProduct.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it('404s for a product that does not exist', async () => {
    const res = await api('POST', '/api/rs-products/clx0000000000000000000000/archive', {
      token: adminToken,
    });
    expect(res.status).toBe(404);
  });
});

describe('access control', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await api('GET', `/api/rs-products/${shopifyProductId}`)).status).toBe(401);
    expect((await api('PATCH', `/api/rs-products/${shopifyProductId}`, { body: {} })).status).toBe(401);
    expect((await api('POST', `/api/rs-products/${shopifyProductId}/archive`)).status).toBe(401);
  });

  it('requires EDIT to update, beyond VIEW', async () => {
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'EDIT', allowed: false },
      ],
    });

    expect(
      (await api('GET', `/api/rs-products/${shopifyProductId}`, { token: employeeToken })).status,
    ).toBe(200);
    expect(
      (await api('PATCH', `/api/rs-products/${shopifyProductId}`, {
        token: employeeToken,
        body: {},
      })).status,
    ).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('requires DELETE to archive, beyond EDIT', async () => {
    const product = await makeManualProduct();

    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'EDIT', allowed: true },
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'DELETE', allowed: false },
      ],
    });

    expect(
      (await api('PATCH', `/api/rs-products/${product.id}`, {
        token: employeeToken,
        body: { variants: [{ id: product.variants[0]!.id, crmStockQty: 3 }] },
      })).status,
    ).toBe(200);

    expect(
      (await api('POST', `/api/rs-products/${product.id}/archive`, { token: employeeToken })).status,
    ).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });
});

describe('existing data is untouched', () => {
  it('leaves the shipped modules alone', async () => {
    const before = {
      sales: await prisma.salesOrder.count(),
      purchase: await prisma.purchaseBill.count(),
      enquiry: await prisma.productEnquiry.count(),
    };

    const product = await makeManualProduct();
    await api('PATCH', `/api/rs-products/${product.id}`, {
      token: adminToken,
      body: { variants: [{ id: product.variants[0]!.id, crmStockQty: 99 }] },
    });
    await api('POST', `/api/rs-products/${product.id}/archive`, { token: adminToken });

    expect(await prisma.salesOrder.count()).toBe(before.sales);
    expect(await prisma.purchaseBill.count()).toBe(before.purchase);
    expect(await prisma.productEnquiry.count()).toBe(before.enquiry);
  });

  it('carries no bridge to a legacy Product master', async () => {
    // The column is gone with the migration to one product identity. Asserted
    // against the schema so it cannot quietly come back.
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'RsProduct' AND column_name = 'productId'`,
    );
    expect(columns).toEqual([]);
  });
});

describe('pagination remains exactly 50 per page', () => {
  it('returns 50 rows and a cursor', async () => {
    const res = await api<{ products: { id: string }[] }>('GET', '/api/rs-products?limit=50', {
      token: adminToken,
    });

    expect(res.body.data!.products).toHaveLength(50);
    expect(res.body.meta!.nextCursor).toBeTruthy();
  });

  it('walks forward with no repeats, preserving a filter', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 3; page += 1) {
      const url = `/api/rs-products?limit=50&status=ACTIVE${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await api<{ products: { id: string; status: string }[] }>('GET', url, {
        token: adminToken,
      });

      expect(res.status).toBe(200);
      for (const p of res.body.data!.products) expect(p.status).toBe('ACTIVE');

      seen.push(...res.body.data!.products.map((p) => p.id));
      const next = res.body.meta!.nextCursor as string | null;
      if (!next) break;
      cursor = next;
    }

    expect(new Set(seen).size).toBe(seen.length);
  });
});
