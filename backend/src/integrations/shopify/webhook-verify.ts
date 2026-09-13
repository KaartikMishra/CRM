/**
 * Shopify webhook authenticity — the only thing standing between a public
 * endpoint and our catalogue.
 *
 * A webhook route cannot use the CRM's session auth: Shopify has no session and
 * sends no bearer token. The HMAC *is* the authentication, so everything here
 * is written on the assumption that the caller is hostile until proven
 * otherwise.
 *
 * Three details make or break it:
 *
 *   - **The raw bytes.** The signature covers exactly what Shopify sent. A body
 *     that has been parsed and re-serialised will not match, because key order
 *     and whitespace are not preserved. Hence express.raw, mounted before the
 *     global JSON parser.
 *   - **The secret is the app's client secret.** Shopify does not issue a
 *     separate webhook signing key for app-configured subscriptions, so this
 *     reuses SHOPIFY_CLIENT_SECRET rather than inventing a variable nobody
 *     could populate.
 *   - **Timing-safe comparison.** A byte-by-byte `===` leaks how much of a
 *     forged signature was correct, which is enough to reconstruct one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/** The header Shopify signs each delivery with. */
export const HMAC_HEADER = 'x-shopify-hmac-sha256';
/** Unique per delivery; the idempotency key. */
export const WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';
export const TOPIC_HEADER = 'x-shopify-topic';
export const SHOP_DOMAIN_HEADER = 'x-shopify-shop-domain';

/**
 * Whether `rawBody` carries a signature Shopify could have produced.
 *
 * Returns false rather than throwing for every failure mode — a missing header,
 * a malformed one, an absent secret — so a caller cannot accidentally treat an
 * error as a pass.
 */
export function verifyShopifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = env.SHOPIFY_CLIENT_SECRET;

  // No secret configured means nothing can be verified, so nothing is trusted.
  if (!secret) return false;
  if (!signature || typeof signature !== 'string') return false;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // expected length. Checked first, and a wrong length is simply a failure.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/** The topics this CRM accepts. Anything else is refused before any work. */
export const ALLOWED_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'inventory_levels/update',
] as const;

export type ShopifyWebhookTopic = (typeof ALLOWED_TOPICS)[number];

/**
 * The `:topic` path segment, as a real topic.
 *
 * Shopify topics contain a slash, which cannot survive one path segment, so the
 * route carries them dash-separated: `products-create` → `products/create`.
 * Validated against the allowlist rather than pattern-matched, so an unexpected
 * topic can never reach a handler.
 */
export function parseTopic(segment: string): ShopifyWebhookTopic | null {
  const normalised = segment.replace(/-/g, '/');
  return (ALLOWED_TOPICS as readonly string[]).includes(normalised)
    ? (normalised as ShopifyWebhookTopic)
    : null;
}

/** Only ever the safe metadata: never the payload, never a credential. */
export type WebhookMeta = {
  webhookId: string | null;
  topic: string | null;
  shopDomain: string | null;
};

export function readWebhookMeta(headers: Record<string, unknown>): WebhookMeta {
  const read = (name: string): string | null => {
    const value = headers[name];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  return {
    webhookId: read(WEBHOOK_ID_HEADER),
    topic: read(TOPIC_HEADER),
    shopDomain: read(SHOP_DOMAIN_HEADER),
  };
}
