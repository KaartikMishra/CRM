/**
 * Incremental Shopify sync — what a webhook actually does once it is trusted.
 *
 * Verification happens in the controller; by the time anything here runs the
 * payload is known to be Shopify's. What remains is making the effect safe to
 * repeat, because it will be repeated: Shopify retries for up to four hours and
 * replays are ordinary, not exceptional.
 *
 * Three separate guarantees are at work, and they protect different things:
 *
 *   - **Transport idempotency** — the same `X-Shopify-Webhook-Id` twice does
 *     nothing the second time, enforced by a unique index.
 *   - **Business idempotency** — two *different* webhook ids describing the
 *     same product converge, because every write is an upsert keyed on a
 *     Shopify id rather than an insert.
 *   - **Ordering** — inventory events carry Shopify's own timestamp, and an
 *     older one is discarded rather than applied. Without this, a retried
 *     event delivered after a newer change would silently restore a stale
 *     quantity.
 *
 * MANUAL products are untouchable throughout: every lookup is by
 * `shopifyProductId`, which a CRM-only product does not have.
 */

import { logger } from '../../config/logger.js';
import { prisma } from '../../config/database.js';
import { shopifyAdminGraphQL } from '../../integrations/shopify/client.js';
import type { ShopifyWebhookTopic } from '../../integrations/shopify/webhook-verify.js';
import { mapImage, mapProduct, mapVariant } from './rs-product.mapper.js';
import type { ShopifyProductNode } from '../../integrations/shopify/product-query.js';
import { upsertShopifyProduct } from './rs-product.repository.js';

/** What a handler did, for the event record and the logs. */
export type WebhookOutcome =
  | { status: 'applied'; detail?: string }
  | { status: 'ignored'; reason: string };

/**
 * Records that a delivery arrived, or reports that it already had.
 *
 * The row is written *before* processing, deliberately. If the process dies
 * mid-handler the row survives with `processedAt` null, which is how a retry
 * knows the work is unfinished rather than done — the difference between
 * recovering and silently losing an event.
 */
/**
 * How long a claim may sit unfinished before it is assumed abandoned.
 *
 * Bounded on both sides. It must exceed the slowest honest run — a product
 * upsert is one transaction against Neon, and an inventory event adds a Shopify
 * round trip on top, so a few seconds is the realistic ceiling and two minutes
 * is generous. It must also be short enough that Shopify's retries, which run
 * for four hours, still arrive while recovery is possible.
 *
 * Too short would let a live worker be overtaken, which is the one outcome
 * worse than a lost event.
 */
export const STALE_CLAIM_MS = 2 * 60 * 1000;

/** Beyond this, an event has failed enough times to be worth looking at. */
export const MAX_ATTEMPTS = 8;

export type ClaimResult = { claimed: boolean; reason?: string };

/**
 * Takes ownership of a delivery, or explains who already has it.
 *
 * The insert is the claim: two deliveries racing cannot both create the same
 * webhookId, so the unique index picks the winner. Checking before inserting
 * would let both find nothing and both proceed.
 *
 * When the row already exists, `claimedAt` is what makes the outcome decidable.
 * Without it, "unfinished and unmarked" could equally mean a worker is busy or
 * a worker died, and treating both as busy loses the second kind for good.
 */
export async function claimWebhook(webhookId: string, topic: string): Promise<ClaimResult> {
  const now = new Date();

  try {
    await prisma.shopifyWebhookEvent.create({
      data: { webhookId, topic, claimedAt: now, attempts: 1 },
    });
    return { claimed: true };
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }

  const existing = await prisma.shopifyWebhookEvent.findUnique({
    where: { webhookId },
    select: { processedAt: true, error: true, claimedAt: true, attempts: true },
  });

  if (!existing) {
    // The row vanished between the failed insert and this read — only possible
    // if something else removed it. Treat as unclaimable rather than guessing.
    return { claimed: false, reason: 'CLAIM_RACE' };
  }

  // Finished: an ordinary duplicate delivery, and nothing to repeat.
  if (existing.processedAt) return { claimed: false, reason: 'ALREADY_PROCESSED' };

  if (existing.attempts >= MAX_ATTEMPTS) {
    // Retried past the point of usefulness. Acknowledged so Shopify stops, and
    // left in the table with its error for somebody to look at.
    return { claimed: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
  }

  // Recorded as failed, or claimed long enough ago that the worker is gone.
  // Both mean the work is outstanding and may be taken.
  const staleSince = new Date(now.getTime() - STALE_CLAIM_MS);
  const abandoned = existing.claimedAt === null || existing.claimedAt < staleSince;

  if (existing.error !== null || abandoned) {
    return reclaim(webhookId, existing.claimedAt, now, existing.error !== null);
  }

  // Claimed recently and still running. Left strictly alone: a concurrent
  // double-apply is a real corruption, and Shopify will retry anyway.
  return { claimed: false, reason: 'IN_FLIGHT' };
}

/**
 * Takes over an outstanding event, conditionally.
 *
 * `updateMany` filtered on the exact `claimedAt` observed a moment ago is what
 * keeps two recovering workers from both succeeding: the filter matches only
 * while the row is unchanged, so whichever writes first moves the timestamp and
 * the other matches nothing. A compare-and-set, using the row itself as the
 * lock rather than adding one.
 */
async function reclaim(
  webhookId: string,
  observedClaimedAt: Date | null,
  now: Date,
  afterFailure: boolean,
): Promise<ClaimResult> {
  const result = await prisma.shopifyWebhookEvent.updateMany({
    where: { webhookId, processedAt: null, claimedAt: observedClaimedAt },
    data: { claimedAt: now, attempts: { increment: 1 }, error: null },
  });

  if (result.count === 0) {
    // Another worker reclaimed it in the meantime.
    return { claimed: false, reason: 'RECLAIMED_ELSEWHERE' };
  }

  return {
    claimed: true,
    reason: afterFailure ? 'RETRY_AFTER_FAILURE' : 'RECOVERED_STALE_CLAIM',
  };
}

/** Marks the delivery finished, or records why it was not. */
export async function completeWebhook(webhookId: string, error?: string): Promise<void> {
  await prisma.shopifyWebhookEvent.update({
    where: { webhookId },
    data: error
      ? // Failed: the claim is released so a retry can take it immediately
        // rather than waiting out the stale threshold.
        { error, claimedAt: null }
      : { processedAt: new Date(), error: null },
  });
}

/**
 * Events that look abandoned right now.
 *
 * Diagnostic only — it reports rather than reprocesses, because Shopify's own
 * retries are the recovery path and a sweep that also processed would be a
 * second, competing one. Exposed so an operator can see whether anything is
 * stuck without reading the table by hand.
 */
export async function findStaleWebhooks(now = new Date()): Promise<
  { webhookId: string; topic: string; attempts: number; claimedAt: Date | null }[]
> {
  return prisma.shopifyWebhookEvent.findMany({
    where: {
      processedAt: null,
      OR: [
        { claimedAt: null },
        { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
      ],
    },
    select: { webhookId: true, topic: true, attempts: true, claimedAt: true },
    orderBy: { receivedAt: 'asc' },
    take: 100,
  });
}

/** Dispatches a verified payload to the handler for its topic. */
export async function handleWebhook(
  topic: ShopifyWebhookTopic,
  payload: unknown,
): Promise<WebhookOutcome> {
  switch (topic) {
    case 'products/create':
    case 'products/update':
      return upsertFromPayload(payload);
    case 'products/delete':
      return archiveProduct(payload);
    case 'inventory_levels/update':
      return applyInventory(payload);
  }
}

/** Shopify's REST webhook payload shape, which differs from the GraphQL one. */
type RestProductPayload = {
  id?: number | string;
  title?: string;
  body_html?: string | null;
  status?: string;
  vendor?: string | null;
  product_type?: string | null;
  updated_at?: string | null;
  variants?: RestVariant[];
  images?: RestImage[];
};

type RestVariant = {
  id?: number | string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  position?: number | null;
  inventory_quantity?: number | null;
  inventory_item_id?: number | string | null;
  grams?: number | null;
  weight?: number | null;
  weight_unit?: string | null;
};

type RestImage = { id?: number | string; src?: string; alt?: string | null };

/** REST webhooks send numeric ids; the catalogue is keyed on GraphQL gids. */
const productGid = (id: number | string): string => `gid://shopify/Product/${id}`;
const variantGid = (id: number | string): string => `gid://shopify/ProductVariant/${id}`;
const imageGid = (id: number | string): string => `gid://shopify/ProductImage/${id}`;
const inventoryItemGid = (id: number | string): string => `gid://shopify/InventoryItem/${id}`;

/** Shopify's REST weight units, mapped onto the GraphQL spelling. */
function restWeightUnit(unit: string | null | undefined): 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | null {
  switch (unit) {
    case 'kg':
      return 'KILOGRAMS';
    case 'g':
      return 'GRAMS';
    case 'lb':
      return 'POUNDS';
    default:
      return null;
  }
}

/**
 * Reshapes a REST webhook payload into the node the mapper already understands.
 *
 * Reusing the mapper rather than writing a second set of rules is the point:
 * the full sync and the webhook then agree by construction on status mapping,
 * weight conversion and what counts as absent.
 */
function toProductNode(payload: RestProductPayload): ShopifyProductNode | null {
  if (payload.id === undefined || payload.id === null) return null;
  if (typeof payload.title !== 'string') return null;

  const variants = (payload.variants ?? [])
    .filter((v) => v.id !== undefined && v.id !== null)
    .map((v) => {
      const unit = restWeightUnit(v.weight_unit);
      return {
        id: variantGid(v.id as number | string),
        title: v.title ?? null,
        sku: v.sku ?? null,
        price: v.price ?? null,
        position: v.position ?? null,
        inventoryQuantity: v.inventory_quantity ?? null,
        inventoryItem:
          v.inventory_item_id === undefined || v.inventory_item_id === null
            ? null
            : {
                id: inventoryItemGid(v.inventory_item_id),
                // REST webhooks carry no cost; leaving it null rather than
                // guessing keeps a real cost from being erased on update.
                unitCost: null,
                measurement:
                  unit && typeof v.weight === 'number'
                    ? { weight: { value: v.weight, unit } }
                    : { weight: null },
              },
      };
    });

  const images = (payload.images ?? [])
    .filter((i) => i.id !== undefined && i.id !== null && typeof i.src === 'string')
    .map((i) => ({
      id: imageGid(i.id as number | string),
      url: i.src as string,
      altText: i.alt ?? null,
    }));

  return {
    id: productGid(payload.id),
    title: payload.title,
    descriptionHtml: payload.body_html ?? null,
    status: (payload.status ?? '').toUpperCase(),
    vendor: payload.vendor ?? null,
    productType: payload.product_type ?? null,
    updatedAt: payload.updated_at ?? null,
    variants: { edges: variants.map((node) => ({ node })) },
    images: { edges: images.map((node) => ({ node })) },
  };
}

/** products/create and products/update share one path: both are upserts. */
async function upsertFromPayload(payload: unknown): Promise<WebhookOutcome> {
  const node = toProductNode(payload as RestProductPayload);
  if (!node) return { status: 'ignored', reason: 'MALFORMED_PRODUCT_PAYLOAD' };

  const { skippedManual } = await upsertShopifyProduct(
    mapProduct(node),
    node.variants.edges.map((e) => mapVariant(e.node)),
    node.images.edges.map((e, i) => mapImage(e.node, i)),
  );

  if (skippedManual) return { status: 'ignored', reason: 'MANUAL_PRODUCT_PROTECTED' };
  return { status: 'applied' };
}

/**
 * products/delete — archive, never remove.
 *
 * The payload carries only an id, so resolution is by `shopifyProductId` alone.
 * Variants and images stay: a re-created Shopify product would otherwise lose
 * its CRM history, and the nullable bridge to the legacy Product master would
 * be severed by a cascade nobody asked for.
 */
async function archiveProduct(payload: unknown): Promise<WebhookOutcome> {
  const id = (payload as { id?: number | string }).id;
  if (id === undefined || id === null) {
    return { status: 'ignored', reason: 'MALFORMED_DELETE_PAYLOAD' };
  }

  const result = await prisma.rsProduct.updateMany({
    // source is part of the filter, not just the lookup: a MANUAL row must not
    // be archived even if one somehow carried this Shopify id.
    where: { shopifyProductId: productGid(id), source: 'SHOPIFY' },
    data: { status: 'ARCHIVED' },
  });

  // Nothing matched: already archived-and-removed, never synced, or manual.
  // A redelivered delete is therefore harmless.
  return result.count > 0
    ? { status: 'applied', detail: 'ARCHIVED' }
    : { status: 'ignored', reason: 'PRODUCT_NOT_FOUND' };
}

type InventoryPayload = {
  inventory_item_id?: number | string;
  available?: number;
  updated_at?: string;
};

/**
 * inventory_levels/update.
 *
 * The payload's `available` is deliberately *not* written. It is the quantity
 * at one location, whereas `inventoryQty` holds the aggregate the full sync
 * stored; writing one into the other would understate stock the moment a second
 * location exists. Instead the variant's aggregate is re-read from the Admin
 * API — which needs no scope beyond the `read_inventory` already held, and so
 * avoids requiring `read_locations`.
 */
async function applyInventory(payload: unknown): Promise<WebhookOutcome> {
  const body = payload as InventoryPayload;
  if (body.inventory_item_id === undefined || body.inventory_item_id === null) {
    return { status: 'ignored', reason: 'MALFORMED_INVENTORY_PAYLOAD' };
  }

  const inventoryItemId = inventoryItemGid(body.inventory_item_id);
  const eventAt = body.updated_at ? new Date(body.updated_at) : null;

  const variant = await prisma.shopifyVariant.findUnique({
    where: { shopifyInventoryItemId: inventoryItemId },
    select: { id: true, shopifyVariantId: true, inventoryUpdatedAt: true },
  });

  if (!variant) return { status: 'ignored', reason: 'VARIANT_NOT_FOUND' };

  // The ordering guard. An event older than the state already stored is a
  // reordered delivery, and applying it would restore a stale quantity.
  if (eventAt && variant.inventoryUpdatedAt && eventAt <= variant.inventoryUpdatedAt) {
    return { status: 'ignored', reason: 'STALE_INVENTORY_EVENT' };
  }

  if (!variant.shopifyVariantId) return { status: 'ignored', reason: 'VARIANT_NOT_SHOPIFY_OWNED' };

  const aggregate = await fetchAggregateInventory(variant.shopifyVariantId);
  if (aggregate === null) return { status: 'ignored', reason: 'AGGREGATE_UNAVAILABLE' };

  await prisma.shopifyVariant.update({
    where: { id: variant.id },
    // Only these two columns. InventoryItem.onHand is Procurement's warehouse
    // count and is never written here.
    data: { inventoryQty: aggregate, inventoryUpdatedAt: eventAt ?? new Date() },
  });

  return { status: 'applied', detail: `qty=${aggregate}` };
}

/** The variant's aggregate quantity across locations, straight from Shopify. */
async function fetchAggregateInventory(variantGidValue: string): Promise<number | null> {
  try {
    const result = await shopifyAdminGraphQL<{
      productVariant: { inventoryQuantity: number | null } | null;
    }>('query V($id: ID!) { productVariant(id: $id) { inventoryQuantity } }', {
      id: variantGidValue,
    });

    const qty = result.data.productVariant?.inventoryQuantity;
    return typeof qty === 'number' ? qty : null;
  } catch (error) {
    // Logged without the payload; the caller records the event as unprocessed
    // so a Shopify retry picks it up again.
    logger.error({ err: error }, 'Could not re-read aggregate inventory from Shopify');
    return null;
  }
}
