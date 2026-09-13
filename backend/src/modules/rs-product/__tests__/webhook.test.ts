/**
 * Shopify webhooks, end to end through the real Express app.
 *
 * Deliveries are signed here exactly as Shopify signs them, so these exercise
 * the raw-body path, the HMAC check and the handlers as one piece. Nothing is
 * mocked except Shopify's own GraphQL endpoint, which the inventory handler
 * calls to re-read an aggregate quantity.
 *
 * Every product this suite touches is created by it and deleted afterwards, so
 * the 501 synced Shopify products are never modified.
 */

import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../config/database.js';
import { env } from '../../../config/env.js';
import { startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  MAX_ATTEMPTS,
  STALE_CLAIM_MS,
  findStaleWebhooks,
} from '../rs-product.webhook.service.js';

/** A product id well outside anything Shopify would issue for this store. */
const TEST_PRODUCT_ID = 900000000001;
const TEST_VARIANT_ID = 900000000101;
const TEST_INVENTORY_ITEM_ID = 900000000201;
const TEST_IMAGE_ID = 900000000301;

const gid = {
  product: (id: number) => `gid://shopify/Product/${id}`,
  variant: (id: number) => `gid://shopify/ProductVariant/${id}`,
  inventoryItem: (id: number) => `gid://shopify/InventoryItem/${id}`,
};

let baseUrl = '';
const createdWebhookIds: string[] = [];

/** Signs a body the way Shopify does — the same secret the app verifies with. */
function sign(body: string): string {
  return createHmac('sha256', env.SHOPIFY_CLIENT_SECRET as string)
    .update(Buffer.from(body, 'utf8'))
    .digest('base64');
}

/** Posts a signed delivery. `signature` overrides the correct one. */
async function deliver(
  topicSegment: string,
  payload: unknown,
  options: { webhookId?: string; signature?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify(payload);
  const webhookId = options.webhookId ?? `zz-test-wh-${Math.random().toString(36).slice(2, 12)}`;
  if (options.webhookId === undefined) createdWebhookIds.push(webhookId);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-webhook-id': webhookId,
    'x-shopify-topic': topicSegment.replace(/-/g, '/'),
    'x-shopify-shop-domain': 'test-store.myshopify.com',
  };

  const signature = options.signature === undefined ? sign(raw) : options.signature;
  if (signature !== null) headers['x-shopify-hmac-sha256'] = signature;

  const res = await fetch(`${baseUrl}/api/rs-products/webhooks/${topicSegment}`, {
    method: 'POST',
    headers,
    body: raw,
  });

  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A products/create or products/update payload, in Shopify's REST shape. */
const productPayload = (over: Record<string, unknown> = {}) => ({
  id: TEST_PRODUCT_ID,
  title: 'zz-test webhook product',
  body_html: '<p>From a webhook</p>',
  status: 'active',
  vendor: 'ROYAL STUFFS',
  product_type: 'Drinkware',
  updated_at: '2026-09-11T10:00:00Z',
  variants: [
    {
      id: TEST_VARIANT_ID,
      title: 'Default Title',
      sku: 'ZZ-TEST-001',
      price: '1499.00',
      position: 1,
      inventory_quantity: 42,
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      weight: 1.5,
      weight_unit: 'kg',
    },
  ],
  images: [{ id: TEST_IMAGE_ID, src: 'https://cdn.shopify.com/zz-test.jpg', alt: 'Test' }],
  ...over,
});

/** Removes everything this suite created, leaving the catalogue as found. */
async function cleanupTestRows(): Promise<void> {
  await prisma.rsProduct.deleteMany({
    where: { OR: [{ shopifyProductId: gid.product(TEST_PRODUCT_ID) }, { title: { startsWith: 'zz-test' } }] },
  });
  if (createdWebhookIds.length) {
    await prisma.shopifyWebhookEvent.deleteMany({ where: { webhookId: { in: createdWebhookIds } } });
  }
  await prisma.shopifyWebhookEvent.deleteMany({ where: { webhookId: { startsWith: 'zz-test-wh-' } } });
}

let baseline: { products: number; variants: number; images: number };

beforeAll(async () => {
  baseUrl = await startTestServer();
  await cleanupTestRows();
  baseline = {
    products: await prisma.rsProduct.count(),
    variants: await prisma.shopifyVariant.count(),
    images: await prisma.rsProductImage.count(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupTestRows();

  // The synced catalogue must be exactly as this suite found it.
  expect(await prisma.rsProduct.count()).toBe(baseline.products);
  expect(await prisma.shopifyVariant.count()).toBe(baseline.variants);
  expect(await prisma.rsProductImage.count()).toBe(baseline.images);

  await stopTestServer();
});

describe('authenticity', () => {
  it('accepts a correctly signed delivery', async () => {
    const res = await deliver('products-create', productPayload());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a missing signature with 401', async () => {
    const res = await deliver('products-create', productPayload(), { signature: null });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_HMAC');
  });

  it('rejects a wrong signature with 401', async () => {
    const res = await deliver('products-create', productPayload(), { signature: 'ZmFrZQ==' });
    expect(res.status).toBe(401);
  });

  it('rejects a body altered after signing — raw-body verification', async () => {
    // The signature is valid for *different* bytes. Only verification over the
    // exact raw body catches this; a parsed-and-reserialised body would not.
    const signed = JSON.stringify(productPayload());
    const tampered = JSON.stringify(productPayload({ title: 'zz-test tampered' }));

    const res = await fetch(`${baseUrl}/api/rs-products/webhooks/products-create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(signed),
        'x-shopify-webhook-id': 'zz-test-wh-tampered',
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it('writes nothing when the signature fails', async () => {
    const before = await prisma.rsProduct.count();
    await deliver('products-create', productPayload(), { signature: null });
    expect(await prisma.rsProduct.count()).toBe(before);
  });

  it('refuses a topic outside the allowlist, after the HMAC passes', async () => {
    const res = await deliver('orders-create', { id: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_TOPIC');
  });

  it('refuses a delivery with no webhook id — there would be no idempotency key', async () => {
    const raw = JSON.stringify(productPayload());
    const res = await fetch(`${baseUrl}/api/rs-products/webhooks/products-create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('MISSING_WEBHOOK_ID');
  });
});

describe('products/create and products/update', () => {
  it('creates the product, its variant and its image', async () => {
    await deliver('products-create', productPayload());

    const row = await prisma.rsProduct.findUnique({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
      include: { variants: true, images: true },
    });

    expect(row).toBeTruthy();
    expect(row!.source).toBe('SHOPIFY');
    expect(row!.status).toBe('ACTIVE');
    expect(row!.variants).toHaveLength(1);
    expect(row!.variants[0]?.sku).toBe('ZZ-TEST-001');
    expect(row!.variants[0]?.shopifyInventoryItemId).toBe(gid.inventoryItem(TEST_INVENTORY_ITEM_ID));
    expect(row!.images).toHaveLength(1);
  });

  it('maps weight through the same rules as the full sync', async () => {
    await deliver('products-create', productPayload());
    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyVariantId: gid.variant(TEST_VARIANT_ID) },
    });
    expect(variant.weightUnit).toBe('KG');
    expect(Number(variant.weightValue)).toBe(1.5);
    expect(Number(variant.weightInGrams)).toBe(1500);
  });

  it('writes no dimensions, because the unit is unresolved', async () => {
    await deliver('products-create', productPayload());
    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyVariantId: gid.variant(TEST_VARIANT_ID) },
    });
    expect(variant.lengthValue).toBeNull();
    expect(variant.dimensionUnit).toBeNull();
  });

  it('updates in place rather than duplicating', async () => {
    await deliver('products-create', productPayload());
    const before = await prisma.rsProduct.count();

    await deliver('products-update', productPayload({ title: 'zz-test renamed', status: 'draft' }));

    expect(await prisma.rsProduct.count()).toBe(before);
    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
    });
    expect(row.title).toBe('zz-test renamed');
    expect(row.status).toBe('DRAFT');
  });

  it('carries UNLISTED through without folding it into another status', async () => {
    await deliver('products-update', productPayload({ status: 'unlisted' }));
    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
    });
    expect(row.status).toBe('UNLISTED');
  });

  it('stays idempotent across different webhook ids for the same product', async () => {
    // Business-level repetition: two distinct deliveries, one product.
    await deliver('products-update', productPayload());
    const after1 = await prisma.rsProduct.count();
    await deliver('products-update', productPayload());
    expect(await prisma.rsProduct.count()).toBe(after1);

    const variants = await prisma.shopifyVariant.count({
      where: { shopifyVariantId: gid.variant(TEST_VARIANT_ID) },
    });
    expect(variants).toBe(1);
  });

  it('refuses a malformed payload without writing', async () => {
    const before = await prisma.rsProduct.count();
    const res = await deliver('products-create', { nonsense: true });
    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('ignored');
    expect(await prisma.rsProduct.count()).toBe(before);
  });
});

describe('products/delete', () => {
  it('archives the product and keeps its variants and images', async () => {
    await deliver('products-create', productPayload());

    const res = await deliver('products-delete', { id: TEST_PRODUCT_ID });
    expect(res.status).toBe(200);

    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
      include: { variants: true, images: true },
    });

    expect(row.status).toBe('ARCHIVED');
    // History survives: a re-created Shopify product keeps its CRM record.
    expect(row.variants.length).toBeGreaterThan(0);
    expect(row.images.length).toBeGreaterThan(0);
  });

  it('is safe when redelivered', async () => {
    await deliver('products-create', productPayload());
    await deliver('products-delete', { id: TEST_PRODUCT_ID });
    const res = await deliver('products-delete', { id: TEST_PRODUCT_ID });

    expect(res.status).toBe(200);
    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
    });
    expect(row.status).toBe('ARCHIVED');
  });

  it('is safe for a product that was never synced', async () => {
    const res = await deliver('products-delete', { id: 999000111222 });
    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('ignored');
  });
});

describe('idempotency', () => {
  it('processes a delivery once and ignores the repeat', async () => {
    const webhookId = `zz-test-wh-dup-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    const first = await deliver('products-create', productPayload(), { webhookId });
    expect((first.body.data as { status: string }).status).toBe('applied');

    const second = await deliver('products-update', productPayload({ title: 'zz-test should not apply' }), {
      webhookId,
    });
    expect(second.status).toBe(200);
    expect((second.body.data as { status: string }).status).toBe('duplicate');

    // The second delivery's payload must not have been applied.
    const row = await prisma.rsProduct.findUniqueOrThrow({
      where: { shopifyProductId: gid.product(TEST_PRODUCT_ID) },
    });
    expect(row.title).not.toBe('zz-test should not apply');
  });

  it('records the delivery before processing, so a crash is recoverable', async () => {
    const webhookId = `zz-test-wh-record-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    await deliver('products-create', productPayload(), { webhookId });

    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId } });
    expect(event.topic).toBe('products/create');
    expect(event.processedAt).not.toBeNull();
    expect(event.error).toBeNull();
  });

  it('reprocesses an event whose previous attempt failed', async () => {
    const webhookId = `zz-test-wh-unfinished-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    // A previous attempt ran and failed: processedAt null, error recorded.
    // Shopify's retry must pick this up rather than treat it as a duplicate.
    await prisma.shopifyWebhookEvent.create({
      data: { webhookId, topic: 'products/create', processedAt: null, error: 'simulated failure' },
    });

    const res = await deliver('products-create', productPayload(), { webhookId });
    expect((res.body.data as { status: string }).status).toBe('applied');

    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId } });
    expect(event.processedAt).not.toBeNull();
    expect(event.error).toBeNull();
  });

  it('does not race an event another worker is still holding', async () => {
    const webhookId = `zz-test-wh-inflight-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    // Claimed moments ago and unfinished: a worker is busy with it. Refused
    // with 409 rather than processed, because a concurrent double-apply is a
    // real corruption — and 409 keeps Shopify retrying, so the event is still
    // recoverable if that worker dies.
    await prisma.shopifyWebhookEvent.create({
      data: { webhookId, topic: 'products/create', processedAt: null, claimedAt: new Date() },
    });

    const res = await deliver('products-create', productPayload(), { webhookId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WEBHOOK_IN_FLIGHT');
  });

  it('recovers an event whose worker died mid-handler', async () => {
    // The Phase 7 risk: claimed, unfinished, no error recorded — a crash. Left
    // unrecovered this would be lost once Shopify's retries ran out.
    const webhookId = `zz-test-wh-stale-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    const longAgo = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
    await prisma.shopifyWebhookEvent.create({
      data: {
        webhookId,
        topic: 'products/create',
        processedAt: null,
        error: null,
        claimedAt: longAgo,
        attempts: 1,
      },
    });

    const res = await deliver('products-create', productPayload(), { webhookId });

    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('applied');

    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId } });
    expect(event.processedAt).not.toBeNull();
    // The claim was re-stamped, so age is measured from the latest attempt.
    expect(event.attempts).toBeGreaterThan(1);
  });

  it('lets only one of two workers recover the same stale event', async () => {
    const webhookId = `zz-test-wh-race-stale-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    await prisma.shopifyWebhookEvent.create({
      data: {
        webhookId,
        topic: 'products/create',
        processedAt: null,
        claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000),
        attempts: 1,
      },
    });

    const [a, b] = await Promise.all([
      deliver('products-create', productPayload(), { webhookId }),
      deliver('products-create', productPayload(), { webhookId }),
    ]);

    // The compare-and-set on claimedAt means exactly one take succeeds.
    const applied = [a, b].filter(
      (r) => r.status === 200 && (r.body.data as { status: string } | undefined)?.status === 'applied',
    );
    expect(applied).toHaveLength(1);
    expect(await prisma.shopifyWebhookEvent.count({ where: { webhookId } })).toBe(1);
  });

  it('stops retrying an event that has failed too many times', async () => {
    const webhookId = `zz-test-wh-exhausted-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    await prisma.shopifyWebhookEvent.create({
      data: {
        webhookId,
        topic: 'products/create',
        processedAt: null,
        error: 'repeatedly failing',
        claimedAt: null,
        attempts: MAX_ATTEMPTS,
      },
    });

    const res = await deliver('products-create', productPayload(), { webhookId });

    // Acknowledged so Shopify stops, and left in the table with its error.
    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('duplicate');

    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId } });
    expect(event.processedAt).toBeNull();
    expect(event.error).toBe('repeatedly failing');
  });

  it('reports stale events for diagnosis without reprocessing them', async () => {
    const webhookId = `zz-test-wh-report-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    await prisma.shopifyWebhookEvent.create({
      data: {
        webhookId,
        topic: 'products/update',
        processedAt: null,
        claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000),
        attempts: 1,
      },
    });

    const stale = await findStaleWebhooks();
    expect(stale.map((s) => s.webhookId)).toContain(webhookId);

    // Reporting only: the event is untouched by the query.
    const event = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId } });
    expect(event.processedAt).toBeNull();
    expect(event.attempts).toBe(1);
  });

  it('does not report a recently claimed event as stale', async () => {
    const webhookId = `zz-test-wh-fresh-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    await prisma.shopifyWebhookEvent.create({
      data: { webhookId, topic: 'products/update', processedAt: null, claimedAt: new Date() },
    });

    const stale = await findStaleWebhooks();
    expect(stale.map((s) => s.webhookId)).not.toContain(webhookId);
  });

  it('applies once when two identical deliveries race', async () => {
    const webhookId = `zz-test-wh-race-${Date.now()}`;
    createdWebhookIds.push(webhookId);

    const [a, b] = await Promise.all([
      deliver('products-create', productPayload(), { webhookId }),
      deliver('products-create', productPayload(), { webhookId }),
    ]);

    // Exactly one worker applies it. The loser gets 409 rather than an
    // acknowledgement: while the winner is still running the outcome is
    // unknown, and 409 keeps Shopify retrying so a crash mid-handler is still
    // recoverable once the claim goes stale.
    const applied = [a, b].filter(
      (r) => r.status === 200 && (r.body.data as { status: string } | undefined)?.status === 'applied',
    );
    expect(applied).toHaveLength(1);

    const loser = [a, b].find((r) => r !== applied[0])!;
    expect([200, 409]).toContain(loser.status);

    expect(await prisma.shopifyWebhookEvent.count({ where: { webhookId } })).toBe(1);
  });
});

describe('inventory_levels/update', () => {
  /** Stubs only Shopify's GraphQL endpoint; the token request still succeeds. */
  function stubAggregate(quantity: number): void {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0], init) => {
      const url = String(input);
      if (url.includes('/admin/api/') && url.includes('graphql.json')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { productVariant: { inventoryQuantity: quantity } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/admin/oauth/access_token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'zz-test-token', scope: 'read_products', expires_in: 86399 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return realFetch(input, init);
    });
  }

  it('resolves the variant by inventory item id and writes the aggregate', async () => {
    await deliver('products-create', productPayload());
    stubAggregate(777);

    const res = await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 500, // per-location; deliberately NOT what gets written
      updated_at: '2026-09-11T12:00:00Z',
    });

    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('applied');

    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
    });
    // The aggregate, not the payload's location-specific `available`.
    expect(variant.inventoryQty).toBe(777);
    expect(variant.inventoryQty).not.toBe(500);
    expect(variant.inventoryUpdatedAt).not.toBeNull();
  });

  it('rejects an event older than the state already stored', async () => {
    // Each inventory test seeds its own state rather than inheriting it: the
    // suite shares one test product, and a products-create in a neighbouring
    // test would otherwise reset the quantity underneath this one.
    await deliver('products-create', productPayload());
    await prisma.shopifyVariant.updateMany({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
      data: { inventoryQty: 800, inventoryUpdatedAt: new Date('2026-09-11T12:00:00Z') },
    });

    // An out-of-order delivery, dated earlier. Applying it would restore a
    // stale quantity and leave it wrong until the next change.
    stubAggregate(100);
    const res = await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 100,
      updated_at: '2026-09-11T11:00:00Z',
    });

    expect((res.body.data as { status: string }).status).toBe('ignored');

    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
    });
    expect(variant.inventoryQty).toBe(800);
  });

  it('rejects an event bearing exactly the stored timestamp', async () => {
    // A redelivery of an already-applied event carries the same updated_at.
    await deliver('products-create', productPayload());
    await prisma.shopifyVariant.updateMany({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
      data: { inventoryQty: 500, inventoryUpdatedAt: new Date('2026-09-11T12:00:00Z') },
    });

    stubAggregate(1);
    const res = await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 1,
      updated_at: '2026-09-11T12:00:00Z',
    });

    expect((res.body.data as { status: string }).status).toBe('ignored');
    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
    });
    expect(variant.inventoryQty).toBe(500);
  });

  it('applies a newer event after an older one', async () => {
    await deliver('products-create', productPayload());
    await prisma.shopifyVariant.updateMany({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
      data: { inventoryQty: 300, inventoryUpdatedAt: new Date('2026-09-11T12:00:00Z') },
    });

    stubAggregate(950);
    await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 950,
      updated_at: '2026-09-11T13:00:00Z',
    });

    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
    });
    expect(variant.inventoryQty).toBe(950);
  });

  it('applies the first inventory event even with no stored timestamp', async () => {
    await deliver('products-create', productPayload());
    await prisma.shopifyVariant.updateMany({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
      data: { inventoryUpdatedAt: null },
    });

    stubAggregate(64);
    const res = await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 64,
      updated_at: '2026-01-01T00:00:00Z',
    });

    expect((res.body.data as { status: string }).status).toBe('applied');
    const variant = await prisma.shopifyVariant.findFirstOrThrow({
      where: { shopifyInventoryItemId: gid.inventoryItem(TEST_INVENTORY_ITEM_ID) },
    });
    expect(variant.inventoryQty).toBe(64);
  });

  it('ignores an unknown inventory item', async () => {
    const res = await deliver('inventory_levels-update', {
      inventory_item_id: 999000111333,
      available: 5,
      updated_at: '2026-09-11T12:00:00Z',
    });
    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }).status).toBe('ignored');
  });

  it('never touches the legacy InventoryItem table', async () => {
    const before = await prisma.inventoryItem.count();

    await deliver('products-create', productPayload());
    stubAggregate(640);
    await deliver('inventory_levels-update', {
      inventory_item_id: TEST_INVENTORY_ITEM_ID,
      available: 640,
      updated_at: '2026-09-11T14:00:00Z',
    });

    expect(await prisma.inventoryItem.count()).toBe(before);
  });
});

describe('MANUAL products are never touched', () => {
  it('leaves a CRM-only product alone across every topic', async () => {
    const manual = await prisma.rsProduct.create({
      data: { title: 'zz-test manual product', source: 'MANUAL', status: 'ACTIVE' },
      select: { id: true, title: true, source: true, status: true },
    });

    await deliver('products-create', productPayload());
    await deliver('products-update', productPayload({ title: 'zz-test renamed again' }));
    await deliver('products-delete', { id: TEST_PRODUCT_ID });

    const after = await prisma.rsProduct.findUniqueOrThrow({ where: { id: manual.id } });
    expect(after.source).toBe('MANUAL');
    expect(after.title).toBe('zz-test manual product');
    expect(after.status).toBe('ACTIVE');
    expect(after.shopifyProductId).toBeNull();

    await prisma.rsProduct.delete({ where: { id: manual.id } });
  });
});

describe('shipped modules are unaffected', () => {
  it('leaves Product, InventoryItem and every business table untouched', async () => {
    // Captured first: the database also holds rows created through the app by
    // hand, so the claim is "a webhook changes nothing here", not "these
    // tables are empty".
    const before = {
      product: await prisma.product.count(),
      inventoryItem: await prisma.inventoryItem.count(),
      salesOrder: await prisma.salesOrder.count(),
      purchaseBill: await prisma.purchaseBill.count(),
      productEnquiry: await prisma.productEnquiry.count(),
    };

    await deliver('products-create', productPayload());
    await deliver('products-delete', { id: TEST_PRODUCT_ID });

    expect(await prisma.product.count()).toBe(before.product);
    expect(await prisma.inventoryItem.count()).toBe(before.inventoryItem);
    expect(await prisma.salesOrder.count()).toBe(before.salesOrder);
    expect(await prisma.purchaseBill.count()).toBe(before.purchaseBill);
    expect(await prisma.productEnquiry.count()).toBe(before.productEnquiry);
  });

  it('leaves the synced Shopify catalogue at 501 products', async () => {
    const synced = await prisma.rsProduct.count({
      where: { source: 'SHOPIFY', shopifyProductId: { not: gid.product(TEST_PRODUCT_ID) } },
    });
    expect(synced).toBe(501);
  });
});
