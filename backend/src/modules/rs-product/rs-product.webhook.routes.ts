/**
 * The Shopify webhook router.
 *
 * Kept separate from rs-product.routes.ts for one structural reason: that
 * router applies `requireAuth` to everything under it, and Shopify presents no
 * CRM session. Mounting a webhook there would either break the delivery or
 * force a hole in the auth guard — neither acceptable. A separate router with
 * no session middleware makes the exemption explicit and bounded.
 *
 * This is also the only router in the codebase mounted *before* the global JSON
 * parser, because HMAC verification needs the exact bytes Shopify signed.
 *
 * Authentication here is the HMAC, checked in the controller before anything
 * else happens. There is no unauthenticated path to a database write.
 */

import express, { Router } from 'express';
import * as controller from './rs-product.webhook.controller.js';

/**
 * Shopify's product payloads carry every variant and image inline, so they run
 * larger than a form post. 2mb leaves headroom above the global 1mb JSON cap
 * without accepting anything unbounded.
 */
const MAX_WEBHOOK_BYTES = '2mb';

export const shopifyWebhookRoutes = Router();

/**
 * The topic travels dash-separated because a Shopify topic contains a slash,
 * which cannot survive a single path segment: `products-create` for
 * `products/create`. The controller validates it against the allowlist.
 */
shopifyWebhookRoutes.post(
  '/:topic',
  // Raw, not parsed: the signature covers the bytes as sent, and a
  // re-serialised body will not match.
  express.raw({ type: 'application/json', limit: MAX_WEBHOOK_BYTES }),
  controller.receive,
);
