/**
 * RS Products — database access.
 *
 * The catalogue is populated: the Shopify sync holds 501 products, 569 variants
 * and 2,231 images, and this is what reads them back.
 *
 * The listing is one query, not one per product. A catalogue table showing an
 * image and a variant summary per row is exactly the shape that becomes an
 * N+1 by accident, so variants and the first image are included in the same
 * findMany and aggregated in memory afterwards.
 */

import type { Prisma } from '@prisma/client';
import type { RsProductListQuery, RsProductListRow, ShopifyProductStatus } from '@rs/shared';
import { prisma } from '../../config/database.js';
import type { MappedImage, MappedProduct, MappedVariant } from './rs-product.mapper.js';
import { evaluateVariants, type EvaluationOutcome } from './inventory-alert.service.js';

export type RsProductPage = {
  products: RsProductListRow[];
  /** Keyset cursor; null when there is no further page. */
  nextCursor: string | null;
};

/**
 * Ordering, always ending in `id`.
 *
 * The tiebreaker is what makes keyset pagination correct: 501 products share
 * only 494 distinct titles, and several share a price, so ordering by those
 * alone would let a row appear on two pages or on none.
 */
function orderFor(sort: RsProductListQuery['sort']): Prisma.RsProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
    case 'price':
    case 'inventory':
      // Both live on the variant, so they cannot be ordered in SQL without
      // collapsing the one-row-per-product shape. Fetched in title order and
      // sorted per page in the service, which is honest about being page-local.
      return [{ title: 'asc' }, { id: 'asc' }];
    case 'title':
    default:
      return [{ title: 'asc' }, { id: 'asc' }];
  }
}

/** Translates the validated query into a Prisma filter. */
function whereFor(query: RsProductListQuery): Prisma.RsProductWhereInput {
  const where: Prisma.RsProductWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.source) where.source = query.source;
  if (query.productType) where.productType = query.productType;

  if (query.q) {
    // Title or SKU: staff recognise RS2331 more readily than the 80-character
    // title beside it.
    where.OR = [
      { title: { contains: query.q, mode: 'insensitive' } },
      { variants: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

/**
 * A page of the catalogue.
 *
 * Takes limit + 1 so the presence of a further page is known without a second
 * count query.
 */
export async function listRsProducts(query: RsProductListQuery): Promise<{
  rows: Prisma.RsProductGetPayload<{
    include: { variants: true; images: true };
  }>[];
  nextCursor: string | null;
}> {
  const rows = await prisma.rsProduct.findMany({
    where: whereFor(query),
    orderBy: orderFor(query.sort),
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      variants: { orderBy: { position: 'asc' } },
      // Shopify's own first image is the storefront's primary one.
      images: { orderBy: { position: 'asc' }, take: 1 },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

/** One product with its variants and first image, in the same shape as a list row. */
export function findRsProduct(id: string): Promise<Prisma.RsProductGetPayload<{
  include: { variants: true; images: true };
}> | null> {
  return prisma.rsProduct.findUnique({
    where: { id },
    include: {
      variants: { orderBy: { position: 'asc' } },
      images: { orderBy: { position: 'asc' }, take: 1 },
    },
  });
}

/**
 * Applies a product edit and its variant edits in one transaction.
 *
 * The service has already decided which fields this product's source permits;
 * this only writes what it was given. Variants are addressed by their CRM id
 * and scoped to the product, so a request cannot reach a variant belonging to
 * something else.
 */
export async function updateRsProduct(
  id: string,
  product: Prisma.RsProductUpdateInput,
  variants: { id: string; data: Prisma.ShopifyVariantUpdateInput }[],
): Promise<EvaluationOutcome[]> {
  return prisma.$transaction(
    async (tx) => {
      if (Object.keys(product).length > 0) {
        await tx.rsProduct.update({ where: { id }, data: product });
      }

      const stockTouched: string[] = [];

      for (const variant of variants) {
        // updateMany with rsProductId in the filter: an id from another product
        // simply matches nothing rather than being written.
        await tx.shopifyVariant.updateMany({
          where: { id: variant.id, rsProductId: id },
          data: variant.data,
        });

        /*
          CRM STOCK WRITER 1 of 2 — the manual edit.

          Only variants whose `crmStockQty` actually appears in this payload are
          evaluated. A cost-price or dimension edit cannot change a stock level,
          so evaluating it would be a lock and a query for a guaranteed no-op on
          a page people use constantly.
        */
        if (variant.data.crmStockQty !== undefined) stockTouched.push(variant.id);
      }

      /*
        Evaluated INSIDE this transaction, after the writes above. Two
        consequences, both wanted:

          - the alert sees the stock level that is actually being committed, not
            the one read before the update;
          - if this transaction rolls back, the alert goes with it. A stock
            change that never happened must not leave an alert claiming it did.
      */
      return evaluateVariants(tx, stockTouched);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/**
 * Archives a product.
 *
 * A status change and nothing else: variants, images, the legacy bridge and
 * every Sales, Procurement and Enquiry row are left exactly as they are. The
 * row is never removed, for either source — a re-created Shopify product would
 * otherwise lose its CRM history, and a deletion would cascade to children that
 * other records may reference.
 */
export async function archiveRsProduct(id: string): Promise<{ archived: boolean }> {
  const result = await prisma.rsProduct.updateMany({
    where: { id },
    data: { status: 'ARCHIVED' },
  });
  return { archived: result.count > 0 };
}

/** The product types actually present, for the filter control. */
export async function listProductTypes(): Promise<string[]> {
  const rows = await prisma.rsProduct.findMany({
    where: { productType: { not: null } },
    distinct: ['productType'],
    select: { productType: true },
    orderBy: { productType: 'asc' },
  });
  return rows.map((r) => r.productType).filter((t): t is string => t !== null);
}

/**
 * A CRM-only product and its single variant, in one transaction.
 *
 * `source` is fixed to MANUAL and every Shopify id left null — that is what
 * makes the row invisible to the sync, which addresses products only by
 * `shopifyProductId`.
 */
export async function createManualProduct(input: {
  title: string;
  description: string | null;
  status: MappedProduct['status'];
  productType: string | null;
  vendor: string | null;
  price: string;
  sku: string | null;
  inventoryQty: number;
}): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const product = await tx.rsProduct.create({
      data: {
        title: input.title,
        description: input.description,
        status: input.status,
        productType: input.productType,
        vendor: input.vendor,
        source: 'MANUAL',
        // Explicit rather than merely omitted: these nulls are the reason the
        // Shopify sync can never claim this row.
        shopifyProductId: null,
        syncedAt: null,
      },
      select: { id: true },
    });

    await tx.shopifyVariant.create({
      data: {
        rsProductId: product.id,
        shopifyVariantId: null,
        shopifyInventoryItemId: null,
        sku: input.sku,
        title: null,
        price: input.price,
        inventoryQty: input.inventoryQty,
        position: 1,
      },
    });

    return product;
  }, { timeout: 15_000, maxWait: 10_000 });
}

/**
 * One product transaction: the product, its variants and its images.
 *
 * Scoped to a single product deliberately. The whole catalogue in one
 * transaction would exceed the 15s budget this codebase uses everywhere else,
 * and would make a failure on product 400 discard the 399 that already worked.
 * Per-product means a failed product is the only thing left unwritten, and a
 * re-run fixes it.
 *
 * Everything is keyed on a Shopify id — never a title, SKU or normalised name —
 * so running this twice updates the same rows rather than creating a second
 * copy of the catalogue.
 */
export async function upsertShopifyProduct(
  product: MappedProduct,
  variants: MappedVariant[],
  images: MappedImage[],
): Promise<{ created: boolean; skippedManual: boolean; detachedMonitorIds: string[] }> {
  /*
    Collected inside the transaction, acted on after it commits. Declared out
    here so the value survives the callback — a monitoring configuration whose
    variant this sync deleted still needs archiving, and an alert it holds still
    needs closing with VARIANT_REMOVED.
  */
  let detachedMonitorIds: string[] = [];

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.rsProduct.findUnique({
        where: { shopifyProductId: product.shopifyProductId },
        select: { id: true, source: true },
      });

      // A MANUAL row must never be rewritten by a sync. It cannot normally hold
      // a Shopify id, but if one is ever attached by hand this is the guard
      // that stops the catalogue overwriting somebody's own product.
      if (existing && existing.source !== 'SHOPIFY') {
        // Nothing was deleted, so nothing was detached.
        return { created: false, skippedManual: true, detachedMonitorIds: [] };
      }

      const row = await tx.rsProduct.upsert({
        where: { shopifyProductId: product.shopifyProductId },
        create: { ...product, source: 'SHOPIFY', syncedAt: new Date() },
        update: { ...product, source: 'SHOPIFY', syncedAt: new Date() },
        select: { id: true },
      });

      /*
        Children are upserted by their own Shopify ids, so a re-run updates in
        place. Rows absent from this payload are removed, but only within this
        product — never a global delete.

        `costPrice` is deliberately absent from the update branch.

        It is the one column on this table that Shopify supplies AND the CRM
        maintains: Shopify exposes a unit cost on the inventory item, and a buyer
        also enters one by hand, because the store records a cost for none of the
        570 synced variants. Spreading the mapped variant over an existing row
        would therefore overwrite every manually entered cost with null on the
        next sync — destroying the figures stock valuation is computed from.

        So Shopify's cost may *seed* a variant the CRM has not seen before, and
        never overwrites one it already holds. `crmStockQty` needs no such care:
        it is absent from MappedVariant entirely, so no sync can reach it.
      */
      for (const variant of variants) {
        const { costPrice, ...shopifyOwned } = variant;

        await tx.shopifyVariant.upsert({
          where: { shopifyVariantId: variant.shopifyVariantId },
          create: { ...shopifyOwned, costPrice, rsProductId: row.id },
          update: { ...shopifyOwned, rsProductId: row.id },
        });
      }

      /*
        Variants Shopify no longer sends are removed. Before removing them, the
        monitoring configurations that point at them are read — because the
        `SET NULL` that detaches those configurations leaves nothing to
        identify afterwards, and a full-table sweep to rediscover them would
        scan every configuration on every product of every sync.

        Read first, delete second, inside this transaction. The ids are returned
        to the caller, which reconciles them only once this has committed.
      */
      const doomed = await tx.shopifyVariant.findMany({
        where: {
          rsProductId: row.id,
          shopifyVariantId: { notIn: variants.map((v) => v.shopifyVariantId) },
        },
        select: { monitoring: { select: { id: true } } },
      });
      detachedMonitorIds = doomed
        .map((v) => v.monitoring?.id)
        .filter((id): id is string => id !== undefined);

      await tx.shopifyVariant.deleteMany({
        where: {
          rsProductId: row.id,
          shopifyVariantId: { notIn: variants.map((v) => v.shopifyVariantId) },
        },
      });

      for (const image of images) {
        await tx.rsProductImage.upsert({
          where: { shopifyImageId: image.shopifyImageId },
          create: { ...image, rsProductId: row.id },
          update: { ...image, rsProductId: row.id },
        });
      }

      await tx.rsProductImage.deleteMany({
        where: {
          rsProductId: row.id,
          shopifyImageId: { notIn: images.map((i) => i.shopifyImageId) },
        },
      });

      return { created: existing === null, skippedManual: false, detachedMonitorIds };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/**
 * Every variant that could hold value, with its product's status.
 *
 * One query, not one per product. Valuation needs `costPrice` and
 * `crmStockQty` per variant plus the owning product's id and status — nothing
 * else — so only those four columns are selected. 570 variants of four narrow
 * columns is a few tens of kilobytes; selecting the rows whole would drag
 * descriptions and 2,231 image URLs through for no use.
 *
 * Variants holding neither cost nor stock are filtered out in SQL rather than
 * in memory: a variant with no cost price AND no stock contributes nothing to
 * any figure, and the live catalogue is almost entirely that case — 565 of 570
 * today. Excluding them in the database is what keeps this from growing into a
 * full-table load as the catalogue does.
 *
 * Ordered by product so the service can group without a second pass or a map
 * keyed on every product in the catalogue.
 */
export function findValuableVariants(): Promise<
  {
    rsProductId: string;
    costPrice: Prisma.Decimal | null;
    crmStockQty: number;
    rsProduct: { status: ShopifyProductStatus };
  }[]
> {
  return prisma.shopifyVariant.findMany({
    where: {
      OR: [{ costPrice: { not: null } }, { crmStockQty: { not: 0 } }],
    },
    select: {
      rsProductId: true,
      costPrice: true,
      crmStockQty: true,
      rsProduct: { select: { status: true } },
    },
    orderBy: { rsProductId: 'asc' },
  });
}
