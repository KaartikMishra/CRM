/**
 * The Shopify catalogue sync.
 *
 * Walks every page of products and writes each one in its own transaction.
 * Read-only against Shopify: this issues queries and never a mutation.
 *
 * The design's three load-bearing properties:
 *
 *   - **Idempotent.** Every write is an upsert keyed on a Shopify id, so a
 *     second run updates the same rows. Counts stay put; nothing duplicates.
 *   - **MANUAL products are untouchable.** Sync only ever addresses rows by
 *     `shopifyProductId`, which a manual product does not have, and the
 *     repository refuses outright if it somehow finds a non-SHOPIFY row.
 *   - **A failure is local.** One product failing leaves that product
 *     unwritten and nothing else, because its transaction is its own. The run
 *     continues and reports it.
 *
 * Progress is summarised per page rather than per record: 2,235 images would
 * otherwise produce 2,235 log lines and bury anything worth reading.
 */

import { logger } from '../../config/logger.js';
import {
  shopifyAdminGraphQL,
  type ShopifyGraphQLResult,
} from '../../integrations/shopify/client.js';
import {
  PRODUCT_PAGE_QUERY,
  type ProductPage,
  type ShopifyProductNode,
} from '../../integrations/shopify/product-query.js';
import { mapImage, mapProduct, mapVariant } from './rs-product.mapper.js';
import { upsertShopifyProduct } from './rs-product.repository.js';

/** Products per page. Comfortably inside Shopify's cost budget per request. */
const PAGE_SIZE = 50;

/**
 * Guards the page loop against a cursor that never terminates. At 50 per page
 * this allows 25,000 products — far beyond this catalogue, and a cheap way to
 * ensure a Shopify bug cannot spin forever.
 */
const MAX_PAGES = 500;

/** What Shopify said, and what we did about it. */
export type SyncReport = {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  pages: number;
  /** Counts as they arrived from Shopify. */
  shopify: { products: number; variants: number; images: number };
  /** Counts as they were written. */
  written: { created: number; updated: number; variants: number; images: number };
  /** Products that could not be written, with the reason. */
  failures: { shopifyProductId: string; title: string; reason: string }[];
  /** Products skipped because the CRM row is MANUAL, not Shopify-owned. */
  skippedManual: string[];
  /** Products whose variant/image list hit the per-product fetch limit. */
  truncated: string[];
  throttle: { minAvailable: number | null; maximumAvailable: number | null };
};

/**
 * Runs a full catalogue sync.
 *
 * Returns a report rather than throwing on a per-product failure: one bad
 * product should not discard 500 good ones, and the caller needs to see what
 * was missed. A Shopify-level failure (auth, rate limit exhaustion) does throw,
 * because there is nothing useful to continue with.
 */
export async function syncShopifyCatalogue(): Promise<SyncReport> {
  const startedAt = new Date();
  const report: SyncReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    elapsedMs: 0,
    pages: 0,
    shopify: { products: 0, variants: 0, images: 0 },
    written: { created: 0, updated: 0, variants: 0, images: 0 },
    failures: [],
    skippedManual: [],
    truncated: [],
    throttle: { minAvailable: null, maximumAvailable: null },
  };

  let after: string | null = null;

  logger.info('Shopify catalogue sync started');

  for (;;) {
    const page: ShopifyGraphQLResult<ProductPage> = await shopifyAdminGraphQL<ProductPage>(
      PRODUCT_PAGE_QUERY,
      { first: PAGE_SIZE, after },
    );

    report.pages += 1;

    const throttle = page.cost?.throttleStatus ?? null;
    if (throttle) {
      report.throttle.maximumAvailable = throttle.maximumAvailable;
      report.throttle.minAvailable =
        report.throttle.minAvailable === null
          ? throttle.currentlyAvailable
          : Math.min(report.throttle.minAvailable, throttle.currentlyAvailable);
    }

    for (const edge of page.data.products.edges) {
      await syncOneProduct(edge.node, report);
    }

    logger.info(
      {
        page: report.pages,
        products: report.shopify.products,
        variants: report.shopify.variants,
        images: report.shopify.images,
        failures: report.failures.length,
      },
      'Shopify sync page complete',
    );

    if (!page.data.products.pageInfo.hasNextPage) break;
    after = page.data.products.pageInfo.endCursor;

    if (report.pages >= MAX_PAGES) {
      logger.error({ pages: report.pages }, 'Shopify sync stopped at the page ceiling');
      break;
    }
  }

  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.elapsedMs = finishedAt.getTime() - startedAt.getTime();

  logger.info(
    {
      pages: report.pages,
      products: report.shopify.products,
      created: report.written.created,
      updated: report.written.updated,
      variants: report.written.variants,
      images: report.written.images,
      failures: report.failures.length,
      elapsedMs: report.elapsedMs,
    },
    'Shopify catalogue sync finished',
  );

  return report;
}

/** One product, in its own transaction, with its failure contained. */
async function syncOneProduct(node: ShopifyProductNode, report: SyncReport): Promise<void> {
  const variantNodes = node.variants?.edges ?? [];
  const imageNodes = node.images?.edges ?? [];

  report.shopify.products += 1;
  report.shopify.variants += variantNodes.length;
  report.shopify.images += imageNodes.length;

  // The query asks for 100 of each; hitting that means the payload was cut and
  // the CRM copy would be silently incomplete. Worth reporting, not guessing.
  if (variantNodes.length >= 100 || imageNodes.length >= 100) {
    report.truncated.push(node.id);
  }

  try {
    const product = mapProduct(node);
    const variants = variantNodes.map((edge) => mapVariant(edge.node));
    const images = imageNodes.map((edge, index) => mapImage(edge.node, index));

    const { created, skippedManual } = await upsertShopifyProduct(product, variants, images);

    // A MANUAL row carrying this Shopify id: the repository refuses it, so the
    // product is recorded as skipped rather than counted as written.
    if (skippedManual) {
      report.skippedManual.push(node.id);
      return;
    }

    if (created) report.written.created += 1;
    else report.written.updated += 1;

    report.written.variants += variants.length;
    report.written.images += images.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    report.failures.push({ shopifyProductId: node.id, title: node.title, reason });
    logger.error(
      { shopifyProductId: node.id, reason },
      'Shopify sync could not write a product',
    );
  }
}
