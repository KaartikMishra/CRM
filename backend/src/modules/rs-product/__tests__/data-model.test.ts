/**
 * RS Products — the data model itself.
 *
 * These assert the constraints the database enforces, not application logic:
 * which identities are unique, which may repeat, what cascades and what does
 * not. They exist because the whole design rests on a few deliberate choices —
 * Shopify ids are identity, titles and SKUs are not — and a schema change that
 * quietly reversed one of them would otherwise surface as corrupt sync data
 * much later.
 *
 * Every row created here is deleted again, and the existing business tables are
 * asserted untouched at the end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCT_SOURCES, SHOPIFY_PRODUCT_STATUSES } from '@rs/shared';
import { prisma } from '../../../config/database.js';

/** Unique-enough suffix so parallel runs never collide on a Shopify id. */
const tag = () => `zz-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createdRsProductIds: string[] = [];
const createdWebhookIds: string[] = [];
/** Legacy Product rows this suite creates to exercise the bridge. */
const createdProductIds: string[] = [];

async function makeRsProduct(data: Record<string, unknown> = {}): Promise<string> {
  const row = await prisma.rsProduct.create({
    data: { title: `${tag()} product`, ...data },
    select: { id: true },
  });
  createdRsProductIds.push(row.id);
  return row.id;
}

/** Counts of everything Phase 2 must not disturb. */
async function businessSnapshot() {
  const [
    product, inventory, salesOrder, salesOrderItem, purchaseBill, purchaseBillItem,
    purchaseAllocation, enquiry, enquiryProduct, changeRequest, notification, mediaAsset,
    user, permission,
  ] = await Promise.all([
    prisma.product.count(), prisma.inventoryItem.count(),
    prisma.salesOrder.count(), prisma.salesOrderItem.count(),
    prisma.purchaseBill.count(), prisma.purchaseBillItem.count(),
    prisma.purchaseAllocation.count(), prisma.productEnquiry.count(),
    prisma.enquiryProduct.count(), prisma.salesItemChangeRequest.count(),
    prisma.notification.count(), prisma.mediaAsset.count(),
    prisma.user.count(), prisma.userModulePermission.count(),
  ]);
  return {
    product, inventory, salesOrder, salesOrderItem, purchaseBill, purchaseBillItem,
    purchaseAllocation, enquiry, enquiryProduct, changeRequest, notification, mediaAsset,
    user, permission,
  };
}

let before: Awaited<ReturnType<typeof businessSnapshot>>;

beforeAll(async () => {
  before = await businessSnapshot();
});

afterAll(async () => {
  // Variants and images cascade from RsProduct; the bridge is SET NULL, so the
  // legacy products must go separately and only after the catalogue rows.
  if (createdRsProductIds.length) {
    await prisma.rsProduct.deleteMany({ where: { id: { in: createdRsProductIds } } });
  }
  if (createdWebhookIds.length) {
    await prisma.shopifyWebhookEvent.deleteMany({ where: { id: { in: createdWebhookIds } } });
  }
  if (createdProductIds.length) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }

  // Nothing this suite created may survive it.
  //
  // Scoped to this suite's own rows rather than asserting the tables are
  // globally empty: they were, before the Shopify catalogue was synced, and a
  // global count would now be measuring the catalogue rather than this suite.
  expect(
    await prisma.rsProduct.count({ where: { id: { in: createdRsProductIds } } }),
  ).toBe(0);
  expect(
    await prisma.shopifyVariant.count({
      where: { rsProduct: { id: { in: createdRsProductIds } } },
    }),
  ).toBe(0);
  expect(
    await prisma.rsProductImage.count({
      where: { rsProduct: { id: { in: createdRsProductIds } } },
    }),
  ).toBe(0);
  expect(
    await prisma.shopifyWebhookEvent.count({ where: { id: { in: createdWebhookIds } } }),
  ).toBe(0);
  expect(await prisma.product.count({ where: { id: { in: createdProductIds } } })).toBe(0);
});

describe('RsProduct identity', () => {
  it('exists as a CRM-only product with no Shopify id', async () => {
    const id = await makeRsProduct({ source: 'MANUAL', shopifyProductId: null });

    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id } });
    expect(row.source).toBe('MANUAL');
    expect(row.shopifyProductId).toBeNull();
    expect(row.status).toBe('ACTIVE');
  });

  it('exists as a Shopify product carrying its Shopify id', async () => {
    const shopifyProductId = `gid://shopify/Product/${tag()}`;
    const id = await makeRsProduct({ source: 'SHOPIFY', shopifyProductId });

    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id } });
    expect(row.source).toBe('SHOPIFY');
    expect(row.shopifyProductId).toBe(shopifyProductId);
  });

  it('refuses a second product with the same Shopify id', async () => {
    const shopifyProductId = `gid://shopify/Product/${tag()}`;
    await makeRsProduct({ shopifyProductId });

    await expect(makeRsProduct({ shopifyProductId })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows many CRM-only products, because null is not a duplicate', async () => {
    // Postgres treats NULLs as distinct in a unique index. Without that, only
    // one manual product could ever exist.
    await makeRsProduct({ source: 'MANUAL', shopifyProductId: null });
    await makeRsProduct({ source: 'MANUAL', shopifyProductId: null });
    await makeRsProduct({ source: 'MANUAL', shopifyProductId: null });

    const manual = await prisma.rsProduct.count({
      where: { id: { in: createdRsProductIds }, source: 'MANUAL', shopifyProductId: null },
    });
    expect(manual).toBeGreaterThanOrEqual(3);
  });

  it('allows two products to share a title — the key difference from Product', async () => {
    // Shopify titles legitimately repeat. Enforcing uniqueness here, as the
    // legacy Product table does, would make a real catalogue fail to sync.
    const title = `${tag()} duplicate title`;
    await makeRsProduct({ title });
    await expect(makeRsProduct({ title })).resolves.toBeTruthy();
  });

  it('accepts every declared source and status value', async () => {
    for (const source of PRODUCT_SOURCES) {
      for (const status of SHOPIFY_PRODUCT_STATUSES) {
        await expect(makeRsProduct({ source, status })).resolves.toBeTruthy();
      }
    }
  });

  it('stores UNLISTED, which the live catalogue actually returns', async () => {
    // Shopify added UNLISTED after this enum was first written, and the store
    // holds 23 of them. Without the value those products cannot be inserted at
    // all, so this asserts the database — not just TypeScript — accepts it.
    expect(SHOPIFY_PRODUCT_STATUSES).toContain('UNLISTED');

    const id = await makeRsProduct({ status: 'UNLISTED' });
    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('UNLISTED');
  });
});

describe('ShopifyVariant', () => {
  it('lets one product hold many variants — a product is not one variant', async () => {
    const rsProductId = await makeRsProduct();

    await prisma.shopifyVariant.createMany({
      data: [
        { rsProductId, title: 'Small', price: '100.00', position: 1 },
        { rsProductId, title: 'Medium', price: '150.00', position: 2 },
        { rsProductId, title: 'Large', price: '200.00', position: 3 },
      ],
    });

    const variants = await prisma.shopifyVariant.findMany({
      where: { rsProductId },
      orderBy: { position: 'asc' },
    });
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.title)).toEqual(['Small', 'Medium', 'Large']);
  });

  it('refuses a duplicate Shopify variant id', async () => {
    const rsProductId = await makeRsProduct();
    const shopifyVariantId = `gid://shopify/Variant/${tag()}`;

    await prisma.shopifyVariant.create({ data: { rsProductId, price: '10.00', shopifyVariantId } });

    await expect(
      prisma.shopifyVariant.create({ data: { rsProductId, price: '20.00', shopifyVariantId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a duplicate Shopify inventory item id', async () => {
    // This is the only key inventory_levels/update carries, so a collision
    // would make that webhook resolve to the wrong variant.
    const rsProductId = await makeRsProduct();
    const shopifyInventoryItemId = `gid://shopify/InventoryItem/${tag()}`;

    await prisma.shopifyVariant.create({
      data: { rsProductId, price: '10.00', shopifyInventoryItemId },
    });

    await expect(
      prisma.shopifyVariant.create({
        data: { rsProductId, price: '20.00', shopifyInventoryItemId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows repeated and null SKUs, which Shopify does not guarantee', async () => {
    const rsProductId = await makeRsProduct();
    const sku = `SKU-${tag()}`;

    await prisma.shopifyVariant.createMany({
      data: [
        { rsProductId, price: '10.00', sku },
        { rsProductId, price: '20.00', sku },
        { rsProductId, price: '30.00', sku: null },
        { rsProductId, price: '40.00', sku: null },
      ],
    });

    expect(await prisma.shopifyVariant.count({ where: { rsProductId, sku } })).toBe(2);
    expect(await prisma.shopifyVariant.count({ where: { rsProductId, sku: null } })).toBe(2);
  });

  it('stores structured dimensions and weight, all optional', async () => {
    const rsProductId = await makeRsProduct();

    const variant = await prisma.shopifyVariant.create({
      data: {
        rsProductId,
        price: '1299.50',
        costPrice: '800.00',
        weightValue: '1.250',
        weightUnit: 'KG',
        weightInGrams: '1250.000',
        lengthValue: '30.00',
        widthValue: '20.00',
        heightValue: '10.00',
        dimensionUnit: 'CM',
        lengthMm: '300.00',
        widthMm: '200.00',
        heightMm: '100.00',
        inventoryQty: 42,
      },
    });

    expect(variant.price.toString()).toBe('1299.5');
    expect(variant.weightUnit).toBe('KG');
    expect(variant.dimensionUnit).toBe('CM');
    expect(variant.inventoryQty).toBe(42);
  });

  it('defaults inventory to zero and leaves every measurement null', async () => {
    const rsProductId = await makeRsProduct();
    const variant = await prisma.shopifyVariant.create({
      data: { rsProductId, price: '5.00' },
    });

    expect(variant.inventoryQty).toBe(0);
    expect(variant.costPrice).toBeNull();
    expect(variant.weightValue).toBeNull();
    expect(variant.dimensionUnit).toBeNull();
  });

  it('is removed with its product', async () => {
    const rsProductId = await makeRsProduct();
    await prisma.shopifyVariant.create({ data: { rsProductId, price: '1.00' } });

    await prisma.rsProduct.delete({ where: { id: rsProductId } });
    createdRsProductIds.splice(createdRsProductIds.indexOf(rsProductId), 1);

    expect(await prisma.shopifyVariant.count({ where: { rsProductId } })).toBe(0);
  });
});

describe('RsProductImage', () => {
  it('relates many images to one product, in position order', async () => {
    const rsProductId = await makeRsProduct();

    await prisma.rsProductImage.createMany({
      data: [
        { rsProductId, url: 'https://cdn.shopify.com/a.jpg', position: 1, altText: 'Front' },
        { rsProductId, url: 'https://cdn.shopify.com/b.jpg', position: 2 },
      ],
    });

    const images = await prisma.rsProductImage.findMany({
      where: { rsProductId },
      orderBy: { position: 'asc' },
    });
    expect(images).toHaveLength(2);
    expect(images[0]?.altText).toBe('Front');
    expect(images[1]?.altText).toBeNull();
  });

  it('refuses a duplicate Shopify image id', async () => {
    const rsProductId = await makeRsProduct();
    const shopifyImageId = `gid://shopify/ProductImage/${tag()}`;

    await prisma.rsProductImage.create({
      data: { rsProductId, url: 'https://cdn.shopify.com/a.jpg', shopifyImageId },
    });

    await expect(
      prisma.rsProductImage.create({
        data: { rsProductId, url: 'https://cdn.shopify.com/b.jpg', shopifyImageId },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('is removed with its product', async () => {
    const rsProductId = await makeRsProduct();
    await prisma.rsProductImage.create({
      data: { rsProductId, url: 'https://cdn.shopify.com/x.jpg' },
    });

    await prisma.rsProduct.delete({ where: { id: rsProductId } });
    createdRsProductIds.splice(createdRsProductIds.indexOf(rsProductId), 1);

    expect(await prisma.rsProductImage.count({ where: { rsProductId } })).toBe(0);
  });
});

describe('ShopifyWebhookEvent idempotency', () => {
  it('accepts a delivery and records it as unprocessed', async () => {
    const row = await prisma.shopifyWebhookEvent.create({
      data: { webhookId: tag(), topic: 'products/update' },
    });
    createdWebhookIds.push(row.id);

    expect(row.processedAt).toBeNull();
    expect(row.error).toBeNull();
    expect(row.receivedAt).toBeInstanceOf(Date);
  });

  it('refuses a replayed webhook id — the point of the table', async () => {
    // Shopify retries for up to 48 hours, so duplicate delivery is expected.
    // The handler reads this P2002 as "already handled" and acknowledges.
    const webhookId = tag();
    const first = await prisma.shopifyWebhookEvent.create({
      data: { webhookId, topic: 'products/create' },
    });
    createdWebhookIds.push(first.id);

    await expect(
      prisma.shopifyWebhookEvent.create({ data: { webhookId, topic: 'products/create' } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await prisma.shopifyWebhookEvent.count({ where: { webhookId } })).toBe(1);
  });

  it('records an outcome without a second row', async () => {
    const row = await prisma.shopifyWebhookEvent.create({
      data: { webhookId: tag(), topic: 'inventory_levels/update' },
    });
    createdWebhookIds.push(row.id);

    const done = await prisma.shopifyWebhookEvent.update({
      where: { id: row.id },
      data: { processedAt: new Date(), error: null },
    });
    expect(done.processedAt).not.toBeNull();
  });
});

describe('the bridge to the legacy Product Master', () => {
  it('defaults to null — nothing is migrated in this phase', async () => {
    const id = await makeRsProduct();
    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id } });
    expect(row.productId).toBeNull();
  });

  it('links to a legacy product when set, and reads back through the relation', async () => {
    const name = `${tag()} legacy`;
    const legacy = await prisma.product.create({
      data: { name, normalizedName: name.toLowerCase().replace(/\s+/g, '') },
      select: { id: true },
    });
    createdProductIds.push(legacy.id);

    const id = await makeRsProduct({ productId: legacy.id });

    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { id },
      include: { product: true },
    });
    expect(row.productId).toBe(legacy.id);
    expect(row.product?.id).toBe(legacy.id);
  });

  it('survives deletion of the legacy product by nulling the bridge', async () => {
    // SET NULL, never cascade: retiring a legacy product must not delete a
    // catalogue row that may already be referenced elsewhere.
    const name = `${tag()} legacy doomed`;
    const legacy = await prisma.product.create({
      data: { name, normalizedName: name.toLowerCase().replace(/\s+/g, '') },
      select: { id: true },
    });
    const id = await makeRsProduct({ productId: legacy.id });

    await prisma.product.delete({ where: { id: legacy.id } });

    const row = await prisma.rsProduct.findUniqueOrThrow({ where: { id } });
    expect(row.productId).toBeNull();
  });

  it('refuses a bridge pointing at a product that does not exist', async () => {
    await expect(
      makeRsProduct({ productId: 'clx0000000000000000000000' }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('existing modules are untouched by this phase', () => {
  it('leaves Product and InventoryItem structurally unchanged', async () => {
    // The RS Products tables are separate precisely so Procurement's identity
    // rules keep working. Both of these uniques must still bite.
    const name = `${tag()} unique check`;
    const normalizedName = name.toLowerCase().replace(/\s+/g, '');
    const first = await prisma.product.create({
      data: { name, normalizedName },
      select: { id: true },
    });
    createdProductIds.push(first.id);

    await expect(
      prisma.product.create({ data: { name, normalizedName } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does not let an RS Products row reach InventoryItem', async () => {
    const inventoryBefore = await prisma.inventoryItem.count();

    const rsProductId = await makeRsProduct();
    await prisma.shopifyVariant.create({
      data: { rsProductId, price: '99.00', inventoryQty: 500 },
    });

    // Shopify quantity lives on the variant. Procurement's warehouse count is a
    // different number and must not have moved.
    expect(await prisma.inventoryItem.count()).toBe(inventoryBefore);
  });

  it('leaves every existing business table at the count it started with', async () => {
    const now = await businessSnapshot();

    // The bridge tests create and delete legacy products, so Product is
    // compared after this suite's own rows are accounted for.
    const outstanding = await prisma.product.count({
      where: { id: { in: createdProductIds } },
    });

    expect(now.product - outstanding).toBe(before.product);
    expect(now.inventory).toBe(before.inventory);
    expect(now.salesOrder).toBe(before.salesOrder);
    expect(now.salesOrderItem).toBe(before.salesOrderItem);
    expect(now.purchaseBill).toBe(before.purchaseBill);
    expect(now.purchaseBillItem).toBe(before.purchaseBillItem);
    expect(now.purchaseAllocation).toBe(before.purchaseAllocation);
    expect(now.enquiry).toBe(before.enquiry);
    expect(now.enquiryProduct).toBe(before.enquiryProduct);
    expect(now.changeRequest).toBe(before.changeRequest);
    expect(now.mediaAsset).toBe(before.mediaAsset);
  });

  it('leaves notifications, users and permissions untouched', async () => {
    const now = await businessSnapshot();
    expect(now.notification).toBe(before.notification);
    expect(now.user).toBe(before.user);
    expect(now.permission).toBe(before.permission);
  });
});
