/**
 * The webhook endpoint.
 *
 * Unlike every other controller in this codebase it holds real logic, because
 * the ordering of its steps *is* the security and reliability design:
 *
 *   1. verify the HMAC over the raw bytes — nothing before this is trusted
 *   2. parse the JSON — only now, and only because it is known to be Shopify's
 *   3. record the delivery — before processing, so a crash is recoverable
 *   4. process
 *   5. acknowledge
 *
 * Step 3 before step 4 is what makes a crash survivable: the row exists with
 * `processedAt` null, so a retry sees unfinished work rather than a duplicate.
 *
 * Responses follow Shopify's rules: only 2xx counts as success, 3xx is a
 * failure, and eight consecutive failures delete the subscription. So a 5xx is
 * returned only when a retry is genuinely wanted.
 */

import type { Request, Response } from 'express';
import { logger } from '../../config/logger.js';
import {
  HMAC_HEADER,
  parseTopic,
  readWebhookMeta,
  verifyShopifyWebhook,
} from '../../integrations/shopify/webhook-verify.js';
import {
  claimWebhook,
  completeWebhook,
  handleWebhook,
} from './rs-product.webhook.service.js';

export async function receive(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;
  const signature = req.headers[HMAC_HEADER] as string | undefined;

  // --- 1. authenticity ------------------------------------------------------
  // Shopify presents no CRM session, so the HMAC is the authentication. A
  // failure is logged with no detail that would help someone tune a forgery.
  if (!verifyShopifyWebhook(rawBody, signature)) {
    logger.warn({ path: req.path }, 'Rejected a Shopify webhook with an invalid signature');
    res.status(401).json({ success: false, message: 'Invalid signature.', code: 'INVALID_HMAC' });
    return;
  }

  const meta = readWebhookMeta(req.headers as Record<string, unknown>);
  const topic = parseTopic(String(req.params.topic ?? ''));

  if (!topic) {
    res.status(400).json({ success: false, message: 'Unsupported topic.', code: 'UNKNOWN_TOPIC' });
    return;
  }

  if (!meta.webhookId) {
    // Without the id there is no idempotency key, and processing could not be
    // made safe to repeat. Refused rather than guessed at.
    res
      .status(400)
      .json({ success: false, message: 'Missing webhook id.', code: 'MISSING_WEBHOOK_ID' });
    return;
  }

  // --- 2. parse -------------------------------------------------------------
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ success: false, message: 'Malformed body.', code: 'MALFORMED_BODY' });
    return;
  }

  // --- 3. record ------------------------------------------------------------
  let claim: Awaited<ReturnType<typeof claimWebhook>>;
  try {
    claim = await claimWebhook(meta.webhookId, topic);
  } catch (error) {
    // The delivery could not be recorded, so it cannot be made idempotent.
    // 5xx asks Shopify to retry — the one case where that is the right answer.
    logger.error({ err: error, topic }, 'Could not record a Shopify webhook delivery');
    res.status(503).json({ success: false, message: 'Try again.', code: 'WEBHOOK_NOT_RECORDED' });
    return;
  }

  if (!claim.claimed) {
    logger.info(
      { topic, webhookId: meta.webhookId, shop: meta.shopDomain, reason: claim.reason },
      'Shopify webhook not claimed',
    );

    // Someone is working on it, or another worker just took it over. A retry is
    // genuinely useful here: if that worker dies, the claim goes stale and the
    // next delivery recovers it. Acknowledging instead would end Shopify's
    // retries while the outcome is still unknown.
    if (claim.reason === 'IN_FLIGHT' || claim.reason === 'RECLAIMED_ELSEWHERE') {
      res
        .status(409)
        .json({ success: false, message: 'Already in progress.', code: 'WEBHOOK_IN_FLIGHT' });
      return;
    }

    // Finished, or retried past the point of usefulness. Acknowledged, because
    // Shopify has nothing useful to do with another delivery.
    res.status(200).json({ success: true, data: { status: 'duplicate' } });
    return;
  }

  // --- 4/5. process, then acknowledge --------------------------------------
  try {
    const outcome = await handleWebhook(topic, payload);
    await completeWebhook(meta.webhookId);

    // Metadata only: never the payload, never a credential.
    logger.info(
      {
        topic,
        webhookId: meta.webhookId,
        shop: meta.shopDomain,
        outcome: outcome.status,
        ...(outcome.status === 'ignored' ? { reason: outcome.reason } : {}),
      },
      'Shopify webhook handled',
    );

    res.status(200).json({ success: true, data: { status: outcome.status } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The event row stays with processedAt null, so Shopify's retry — or a
    // later recovery pass — will see unfinished work rather than a duplicate.
    await completeWebhook(meta.webhookId, reason).catch(() => undefined);

    logger.error({ topic, webhookId: meta.webhookId, reason }, 'Shopify webhook processing failed');
    res.status(500).json({ success: false, message: 'Processing failed.', code: 'WEBHOOK_FAILED' });
  }
}
