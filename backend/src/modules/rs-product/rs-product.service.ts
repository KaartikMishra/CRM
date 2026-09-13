/**
 * RS Products business logic.
 *
 * RS Products is the central product catalogue: Shopify as the primary source,
 * CRM-only products alongside it, and the legacy Procurement Product Master
 * migrated onto it later by a deliberate, verified step.
 *
 * The aggregation below is the module's one real piece of reasoning. A product
 * is the row; its variants are facts about that row. 465 of the 501 synced
 * products have exactly one variant, so showing one row per variant would
 * repeat the title needlessly — but the 36 that have several must not lie about
 * their price or stock, which is why a range and a sum appear rather than a
 * first-variant value.
 */

import type {
  CreateRsProductInput,
  RsProductDetail,
  RsProductListQuery,
  RsProductListRow,
  UpdateRsProductInput,
} from '@rs/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/AppError.js';
import * as repository from './rs-product.repository.js';
import type { RsProductPage } from './rs-product.repository.js';
import {
  checkConnection,
  type ShopifyConnectionStatus,
} from '../../integrations/shopify/connection.js';
import { syncShopifyCatalogue, type SyncReport } from './rs-product.sync.js';

type ProductWithChildren = Prisma.RsProductGetPayload<{
  include: { variants: true; images: true };
}>;

/** Decimal columns cross the wire as strings; no float ever touches a price. */
const decimalText = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toString();

/**
 * One product row, with its variants folded in.
 *
 * Inventory is summed and deliberately not clamped: one live variant holds −10,
 * and rounding that up to zero would conceal a real oversell.
 */
function toListRow(product: ProductWithChildren): RsProductListRow {
  const variants = product.variants;
  const prices = variants
    .map((v) => Number(v.price))
    .filter((n) => Number.isFinite(n));

  const first = variants[0] ?? null;
  const image = product.images[0] ?? null;

  return {
    id: product.id,
    title: product.title,
    source: product.source,
    status: product.status,
    productType: product.productType,
    vendor: product.vendor,

    imageUrl: image?.url ?? null,
    imageAlt: image?.altText ?? null,

    sku: first?.sku ?? null,
    variantCount: variants.length,

    priceMin: prices.length ? Math.min(...prices).toFixed(2) : null,
    priceMax: prices.length ? Math.max(...prices).toFixed(2) : null,

    inventoryQty: variants.reduce((sum, v) => sum + v.inventoryQty, 0),
    crmStockQty: variants.reduce((sum, v) => sum + v.crmStockQty, 0),

    weightValue: first ? decimalText(first.weightValue) : null,
    weightUnit: first?.weightUnit ?? null,

    // Null by design — the store records no unit for its dimension metafields.
    lengthValue: first ? decimalText(first.lengthValue) : null,
    widthValue: first ? decimalText(first.widthValue) : null,
    heightValue: first ? decimalText(first.heightValue) : null,
    dimensionUnit: first?.dimensionUnit ?? null,

    createdAt: product.createdAt.toISOString(),
  };
}

/**
 * A page of the catalogue.
 *
 * Price and inventory sorts are applied after aggregation and are therefore
 * page-local: both live on the variant, and ordering by them in SQL would
 * collapse the one-row-per-product shape the table depends on.
 */
export async function listRsProducts(query: RsProductListQuery): Promise<RsProductPage> {
  const { rows, nextCursor } = await repository.listRsProducts(query);
  const products = rows.map(toListRow);

  if (query.sort === 'price') {
    products.sort((a, b) => Number(a.priceMin ?? 0) - Number(b.priceMin ?? 0));
  } else if (query.sort === 'inventory') {
    products.sort((a, b) => b.inventoryQty - a.inventoryQty);
  }

  return { products, nextCursor };
}

/** The product types present, for the filter control. */
export function listProductTypes(): Promise<string[]> {
  return repository.listProductTypes();
}

/** One product, with its variants and the rules governing what may change. */
export async function getRsProduct(id: string): Promise<RsProductDetail> {
  const row = await repository.findRsProduct(id);
  if (!row) throw AppError.notFound('RS_PRODUCT_NOT_FOUND', 'That product could not be found.');
  return toDetail(row);
}

function toDetail(product: ProductWithChildren): RsProductDetail {
  // A Shopify product's descriptive fields belong to Shopify: the next sync
  // rewrites them from the payload, so a CRM edit would vanish without warning.
  const crmOwned = product.source === 'MANUAL';

  return {
    id: product.id,
    source: product.source,
    shopifyProductId: product.shopifyProductId,
    title: product.title,
    description: product.description,
    status: product.status,
    productType: product.productType,
    vendor: product.vendor,
    productId: product.productId,
    syncedAt: product.syncedAt?.toISOString() ?? null,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    variants: product.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price: v.price.toString(),
      costPrice: decimalText(v.costPrice),
      crmStockQty: v.crmStockQty,
      weightValue: decimalText(v.weightValue),
      weightUnit: v.weightUnit,
      lengthValue: decimalText(v.lengthValue),
      widthValue: decimalText(v.widthValue),
      heightValue: decimalText(v.heightValue),
      dimensionUnit: v.dimensionUnit,
      inventoryQty: v.inventoryQty,
      position: v.position,
    })),
    images: product.images.map((i) => ({
      id: i.id,
      url: i.url,
      altText: i.altText,
      position: i.position,
    })),
    editable: { productFields: crmOwned, shopifyOwnedVariantFields: crmOwned },
  };
}

/**
 * Applies an edit.
 *
 * The rule this enforces is the phase's central one: a field Shopify owns is
 * refused rather than accepted-then-reverted. Accepting a title change on a
 * synced product would look like it worked until the next sync silently undid
 * it, which is worse than a clear refusal.
 *
 * CRM-owned on every product, whatever the source: cost price, CRM stock and
 * dimensions. Shopify writes none of those — cost is null on all 569 synced
 * variants, and the dimension metafields carry no unit the CRM could trust.
 */
export async function updateRsProduct(
  id: string,
  input: UpdateRsProductInput,
): Promise<RsProductDetail> {
  const existing = await repository.findRsProduct(id);
  if (!existing) throw AppError.notFound('RS_PRODUCT_NOT_FOUND', 'That product could not be found.');

  const isShopify = existing.source === 'SHOPIFY';

  const productData: Prisma.RsProductUpdateInput = {};
  if (input.description !== undefined) productData.description = input.description;

  // Shopify owns title, status, type and vendor on a synced product.
  for (const field of ['title', 'status', 'productType', 'vendor'] as const) {
    if (input[field] === undefined) continue;
    if (isShopify) {
      throw AppError.badRequest(
        'SHOPIFY_OWNED_FIELD',
        `“${field}” is maintained by Shopify and would be overwritten by the next sync.`,
      );
    }
    Object.assign(productData, { [field]: input[field] });
  }

  const byId = new Map(existing.variants.map((v) => [v.id, v]));
  const variantUpdates: { id: string; data: Prisma.ShopifyVariantUpdateInput }[] = [];

  for (const variant of input.variants ?? []) {
    if (!byId.has(variant.id)) {
      throw AppError.badRequest('VARIANT_NOT_FOUND', 'That variant does not belong to this product.');
    }

    const data: Prisma.ShopifyVariantUpdateInput = {};

    // --- CRM-owned everywhere ------------------------------------------------
    if (variant.costPrice !== undefined) data.costPrice = variant.costPrice;
    if (variant.crmStockQty !== undefined) data.crmStockQty = variant.crmStockQty;
    if (variant.lengthValue !== undefined) data.lengthValue = variant.lengthValue;
    if (variant.widthValue !== undefined) data.widthValue = variant.widthValue;
    if (variant.heightValue !== undefined) data.heightValue = variant.heightValue;
    if (variant.dimensionUnit !== undefined) data.dimensionUnit = variant.dimensionUnit;

    // --- Shopify-owned on a synced product ----------------------------------
    for (const field of ['sku', 'price', 'weightValue', 'weightUnit'] as const) {
      if (variant[field] === undefined) continue;
      if (isShopify) {
        throw AppError.badRequest(
          'SHOPIFY_OWNED_FIELD',
          `“${field}” is maintained by Shopify and would be overwritten by the next sync.`,
        );
      }
      Object.assign(data, { [field]: variant[field] });
    }

    // A dimension set without a unit is a number nobody can interpret — the
    // exact problem the Shopify metafields already have.
    const hasDimension =
      variant.lengthValue != null || variant.widthValue != null || variant.heightValue != null;
    const unitAfter =
      variant.dimensionUnit !== undefined ? variant.dimensionUnit : byId.get(variant.id)?.dimensionUnit;
    if (hasDimension && !unitAfter) {
      throw AppError.badRequest(
        'DIMENSION_UNIT_REQUIRED',
        'Choose a dimension unit — a measurement without one cannot be interpreted.',
      );
    }

    if (Object.keys(data).length > 0) variantUpdates.push({ id: variant.id, data });
  }

  await repository.updateRsProduct(id, productData, variantUpdates);
  return getRsProduct(id);
}

/**
 * Archives a product — the only removal this module offers.
 *
 * Soft for both sources. A Shopify product must survive because the catalogue
 * may be re-created upstream; a manual one must survive because its history may
 * already be referenced. Nothing cascades.
 */
export async function archiveRsProduct(id: string): Promise<RsProductDetail> {
  const { archived } = await repository.archiveRsProduct(id);
  if (!archived) {
    throw AppError.notFound('RS_PRODUCT_NOT_FOUND', 'That product could not be found.');
  }
  return getRsProduct(id);
}

/**
 * Creates a CRM-only product.
 *
 * Always MANUAL, always without Shopify ids — which is precisely what keeps the
 * sync from ever claiming or overwriting it.
 */
export async function createManualProduct(
  input: CreateRsProductInput,
): Promise<RsProductListRow> {
  const { id } = await repository.createManualProduct({
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    productType: input.productType ?? null,
    vendor: input.vendor ?? null,
    price: input.price,
    sku: input.sku ?? null,
    inventoryQty: input.inventoryQty,
  });

  // Read back through the same shape the list returns, so a caller never has
  // to reconcile two representations of the same product.
  const created = await repository.findRsProduct(id);
  if (!created) {
    throw AppError.notFound('RS_PRODUCT_NOT_FOUND', 'That product could not be read back.');
  }
  return toListRow(created);
}

/**
 * Whether the configured Shopify store answers to our credentials.
 *
 * A diagnostic for administrators setting the integration up, not part of any
 * product flow. The service returns only what is safe to display — never the
 * access token, never the client secret.
 */
export function shopifyConnectionStatus(): Promise<ShopifyConnectionStatus> {
  return checkConnection();
}

/**
 * Pulls the whole Shopify catalogue into RS Products.
 *
 * Read-only against Shopify and idempotent: re-running updates the same rows
 * rather than duplicating them, and a CRM-only (MANUAL) product is never
 * touched. Returns a report naming any product it could not write.
 */
export function runShopifySync(): Promise<SyncReport> {
  return syncShopifyCatalogue();
}
