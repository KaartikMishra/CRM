/**
 * Webhook authenticity.
 *
 * No database and no network: these are the pure rules that decide whether a
 * request is Shopify's. They matter more than most tests in this codebase
 * because the endpoint is public and unauthenticated by any other means — the
 * HMAC is the only thing between the internet and the catalogue.
 *
 * The fake secret below is obvious nonsense and no real credential is used.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_SECRET = 'fake-client-secret-for-tests';
const testEnv: Record<string, string | undefined> = {};

vi.mock('../../../config/env.js', () => ({
  get env() {
    return {
      SHOPIFY_STORE_DOMAIN: testEnv.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_CLIENT_ID: testEnv.SHOPIFY_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET: testEnv.SHOPIFY_CLIENT_SECRET,
      SHOPIFY_API_VERSION: '2026-07',
    };
  },
  shopifyConfigured: () => true,
  isProduction: false,
  isDevelopment: false,
  isTest: true,
}));

const { verifyShopifyWebhook, parseTopic, readWebhookMeta, ALLOWED_TOPICS } = await import(
  '../webhook-verify.js'
);

/** Signs a body the way Shopify does: HMAC-SHA256, base64, client secret. */
const sign = (body: string, secret = FAKE_SECRET): string =>
  createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');

beforeEach(() => {
  testEnv.SHOPIFY_CLIENT_SECRET = FAKE_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HMAC verification', () => {
  it('accepts a body signed with the configured secret', () => {
    const body = JSON.stringify({ id: 123, title: 'Copper Bottle' });
    expect(verifyShopifyWebhook(Buffer.from(body, 'utf8'), sign(body))).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhook(Buffer.from(body, 'utf8'), sign(body, 'some-other-secret'))).toBe(
      false,
    );
  });

  it('rejects a body altered after signing — the whole point', () => {
    const original = JSON.stringify({ id: 123, title: 'Copper Bottle' });
    const signature = sign(original);
    const tampered = JSON.stringify({ id: 999, title: 'Copper Bottle' });

    expect(verifyShopifyWebhook(Buffer.from(tampered, 'utf8'), signature)).toBe(false);
  });

  it('rejects a body that was re-serialised rather than passed through', () => {
    // Exactly what happens if express.json() parses before verification: the
    // same data, different bytes, and the signature no longer matches.
    const asSent = '{"id":123,"title":"Copper Bottle"}';
    const signature = sign(asSent);
    const reSerialised = JSON.stringify(JSON.parse(asSent) as unknown, null, 2);

    expect(verifyShopifyWebhook(Buffer.from(reSerialised, 'utf8'), signature)).toBe(false);
  });

  it('rejects a missing signature', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyShopifyWebhook(body, undefined)).toBe(false);
    expect(verifyShopifyWebhook(body, '')).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    const body = Buffer.from('{"id":1}', 'utf8');
    expect(verifyShopifyWebhook(body, 'not-base64-!!!')).toBe(false);
    expect(verifyShopifyWebhook(body, 'c2hvcnQ=')).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(verifyShopifyWebhook(Buffer.alloc(0), sign(''))).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    // A missing secret must fail closed: unverifiable is not trusted.
    delete testEnv.SHOPIFY_CLIENT_SECRET;
    const body = JSON.stringify({ id: 1 });
    expect(verifyShopifyWebhook(Buffer.from(body, 'utf8'), sign(body))).toBe(false);
  });

  it('verifies byte-for-byte, including whitespace', () => {
    const spaced = '{ "id": 123 }';
    expect(verifyShopifyWebhook(Buffer.from(spaced, 'utf8'), sign(spaced))).toBe(true);
    expect(verifyShopifyWebhook(Buffer.from('{"id":123}', 'utf8'), sign(spaced))).toBe(false);
  });

  it('handles a realistically large payload', () => {
    const big = JSON.stringify({ id: 1, variants: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
    expect(verifyShopifyWebhook(Buffer.from(big, 'utf8'), sign(big))).toBe(true);
  });

  it('never places the secret in its own output', () => {
    const body = JSON.stringify({ id: 1 });
    const signature = sign(body);
    expect(signature).not.toContain(FAKE_SECRET);
  });
});

describe('topic validation', () => {
  it('accepts exactly the four approved topics', () => {
    expect([...ALLOWED_TOPICS]).toEqual([
      'products/create',
      'products/update',
      'products/delete',
      'inventory_levels/update',
    ]);
  });

  it('translates the dash-separated path segment', () => {
    // A Shopify topic contains a slash, which cannot survive a path segment.
    expect(parseTopic('products-create')).toBe('products/create');
    expect(parseTopic('products-update')).toBe('products/update');
    expect(parseTopic('products-delete')).toBe('products/delete');
    expect(parseTopic('inventory_levels-update')).toBe('inventory_levels/update');
  });

  it('refuses anything outside the allowlist', () => {
    expect(parseTopic('orders-create')).toBeNull();
    expect(parseTopic('customers-delete')).toBeNull();
    expect(parseTopic('products-destroy')).toBeNull();
    expect(parseTopic('')).toBeNull();
    expect(parseTopic('../../etc/passwd')).toBeNull();
  });
});

describe('header reading', () => {
  it('reads the metadata that is safe to log', () => {
    const meta = readWebhookMeta({
      'x-shopify-webhook-id': 'wh-123',
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': 'shop.myshopify.com',
    });

    expect(meta).toEqual({
      webhookId: 'wh-123',
      topic: 'products/update',
      shopDomain: 'shop.myshopify.com',
    });
  });

  it('returns null for absent or blank headers rather than empty strings', () => {
    const meta = readWebhookMeta({ 'x-shopify-webhook-id': '   ' });
    expect(meta.webhookId).toBeNull();
    expect(meta.topic).toBeNull();
    expect(meta.shopDomain).toBeNull();
  });

  it('carries no signature or secret in what it returns', () => {
    const meta = readWebhookMeta({
      'x-shopify-webhook-id': 'wh-1',
      'x-shopify-hmac-sha256': 'a-signature',
      authorization: 'Bearer something',
    });

    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain('a-signature');
    expect(serialised).not.toContain('Bearer');
  });
});
