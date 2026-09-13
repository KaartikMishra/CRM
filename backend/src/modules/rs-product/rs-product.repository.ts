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
import type { RsProductListQuery, RsProductListRow } from '@rs/shared';
import { prisma } from '../../config/database.js';
import type { MappedImage, MappedProduct, MappedVariant } from './rs-product.mapper.js';

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
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      if (Object.keys(product).length > 0) {
        await tx.rsProduct.update({ where: { id }, data: product });
      }

      for (const variant of variants) {
        // updateMany with rsProductId in the filter: an id from another product
        // simply matches nothing rather than being written.
        await tx.shopifyVariant.updateMany({
          where: { id: variant.id, rsProductId: id },
          data: variant.data,
        });
      }
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
): Promise<{ created: boolean; skippedManual: boolean }> {
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
        return { created: false, skippedManual: true };
      }

      const row = await tx.rsProduct.upsert({
        where: { shopifyProductId: product.shopifyProductId },
        create: { ...product, source: 'SHOPIFY', syncedAt: new Date() },
        update: { ...product, source: 'SHOPIFY', syncedAt: new Date() },
        select: { id: true },
      });

      // Children are upserted by their own Shopify ids, so a re-run updates in
      // place. Rows absent from this payload are removed, but only within this
      // product — never a global delete.
      for (const variant of variants) {
        await tx.shopifyVariant.upsert({
          where: { shopifyVariantId: variant.shopifyVariantId },
          create: { ...variant, rsProductId: row.id },
          update: { ...variant, rsProductId: row.id },
        });
      }

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

      return { created: existing === null, skippedManual: false };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}
