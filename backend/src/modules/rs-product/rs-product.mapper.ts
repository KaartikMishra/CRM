/**
 * Shopify's shapes translated into ours — pure functions, no I/O.
 *
 * Separated from the sync service so the rules that are easy to get subtly
 * wrong (unit conversion, what counts as absent, which status maps to what) can
 * be asserted directly without a database or a network.
 *
 * Two principles run through all of it:
 *
 *   - Absent means null. A missing cost is not zero, a missing weight is not
 *     zero, and a blank SKU is not an empty string pretending to be a value.
 *   - Nothing is inferred. If Shopify does not say it, this does not invent it.
 */

import type { Prisma } from '@prisma/client';
import type { ShopifyProductStatus, WeightUnit } from '@rs/shared';
import type {
  ShopifyImageNode,
  ShopifyProductNode,
  ShopifyVariantNode,
  ShopifyWeightUnit,
} from '../../integrations/shopify/product-query.js';

/** Grams per one of each unit we accept, for the normalised column. */
const GRAMS_PER: Record<WeightUnit, number> = { G: 1, KG: 1000, LB: 453.59237 };

/**
 * A product's CRM stock: the sum of its variants' hand-maintained counts.
 *
 * The one definition of "this product's stock", used by the RS Products
 * catalogue row and by Procurement alike. It lives here rather than in either
 * caller because the two must agree by construction: Procurement displays the
 * figure RS Products owns, and a second summation in another file could drift
 * from this one without anything failing.
 *
 * Deliberately not clamped, matching `inventoryQty`: a negative CRM count is a
 * real bookkeeping fact, and rounding it up to zero would hide it.
 *
 * Never Shopify's `inventoryQty`, which is overwritten by every sync pass, and
 * never `InventoryItem.onHand`, which is the legacy warehouse count.
 */
export function crmStockOf(variants: { crmStockQty: number }[]): number {
  return variants.reduce((sum, v) => sum + v.crmStockQty, 0);
}

/**
 * A product's RS stock: the sum of its variants' Shopify quantities.
 *
 * The companion to `crmStockOf`, and deliberately a separate function over a
 * separate column rather than a parameter on one. These are two different
 * numbers about the same goods:
 *
 *   crmStockOf  →  crmStockQty    what the CRM has counted, entered by hand
 *   rsStockOf   →  inventoryQty   what Shopify says is sellable
 *
 * They routinely disagree, and the disagreement is the useful part — it is how
 * a mis-set storefront quantity or an uncounted delivery becomes visible. One
 * function switching on a flag would make substituting one for the other a
 * one-character mistake; two functions mean a caller has to say which question
 * it is asking.
 *
 * Not clamped, matching `crmStockOf`: Shopify reports negative sellable
 * quantities when a product oversells, and that is a real fact about the store.
 */
export function rsStockOf(variants: { inventoryQty: number }[]): number {
  return variants.reduce((sum, v) => sum + v.inventoryQty, 0);
}

/**
 * Shopify's weight units to ours.
 *
 * OUNCES has no equivalent in the CRM's WeightUnit enum and the store uses none,
 * so it maps to null rather than being rounded into something it is not.
 */
export function mapWeightUnit(unit: ShopifyWeightUnit | null | undefined): WeightUnit | null {
  switch (unit) {
    case 'KILOGRAMS':
      return 'KG';
    case 'GRAMS':
      return 'G';
    case 'POUNDS':
      return 'LB';
    default:
      return null;
  }
}

/**
 * Shopify's product status to ours.
 *
 * UNLISTED is carried through as itself. It means "reachable by link, hidden
 * from listings", which is neither ACTIVE nor DRAFT; folding it into either
 * would discard a distinction the storefront actually makes.
 *
 * An unknown future status becomes DRAFT: the conservative choice, since DRAFT
 * is the one status that implies "not on sale" without claiming the product was
 * deliberately archived.
 */
export function mapProductStatus(status: string | null | undefined): ShopifyProductStatus {
  switch (status) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'ARCHIVED':
      return 'ARCHIVED';
    case 'DRAFT':
      return 'DRAFT';
    case 'UNLISTED':
      return 'UNLISTED';
    default:
      return 'DRAFT';
  }
}

/** Trimmed, or null when the value is absent or blank. */
function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A decimal string Prisma will accept, or null. Never a float. */
function decimalOrNull(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  return Number.isFinite(Number(text)) ? text : null;
}

export type MappedProduct = {
  shopifyProductId: string;
  title: string;
  description: string | null;
  status: ShopifyProductStatus;
  productType: string | null;
  vendor: string | null;
  shopifyUpdatedAt: Date | null;
};

export function mapProduct(node: ShopifyProductNode): MappedProduct {
  return {
    shopifyProductId: node.id,
    title: node.title,
    description: textOrNull(node.descriptionHtml),
    status: mapProductStatus(node.status),
    productType: textOrNull(node.productType),
    vendor: textOrNull(node.vendor),
    shopifyUpdatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

export type MappedVariant = {
  shopifyVariantId: string;
  shopifyInventoryItemId: string | null;
  sku: string | null;
  title: string | null;
  price: Prisma.Decimal | string;
  costPrice: string | null;
  weightValue: string | null;
  weightUnit: WeightUnit | null;
  weightInGrams: string | null;
  inventoryQty: number;
  position: number;
};

/**
 * One variant.
 *
 * `price` falls back to "0" rather than null because the column is NOT NULL and
 * a variant Shopify sells always has one; a missing price is a malformed
 * payload, and the sync reports the product rather than inventing a number.
 *
 * Dimensions are absent on purpose — see the note in product-query.ts.
 */
export function mapVariant(node: ShopifyVariantNode): MappedVariant {
  const weight = node.inventoryItem?.measurement?.weight ?? null;
  const weightUnit = mapWeightUnit(weight?.unit);
  const weightValue = weight && weightUnit ? decimalOrNull(weight.value) : null;

  // Normalised so mixed units still sort and filter together, matching how
  // EnquiryProduct already stores weight.
  const weightInGrams =
    weightValue && weightUnit
      ? (Number(weightValue) * GRAMS_PER[weightUnit]).toFixed(3)
      : null;

  return {
    shopifyVariantId: node.id,
    shopifyInventoryItemId: node.inventoryItem?.id ?? null,
    sku: textOrNull(node.sku),
    title: textOrNull(node.title),
    price: decimalOrNull(node.price) ?? '0',
    // Absent cost stays absent. Never substituted from price or anything else.
    costPrice: decimalOrNull(node.inventoryItem?.unitCost?.amount ?? null),
    weightValue,
    weightUnit,
    weightInGrams,
    inventoryQty: typeof node.inventoryQuantity === 'number' ? node.inventoryQuantity : 0,
    position: typeof node.position === 'number' && node.position > 0 ? node.position : 1,
  };
}

export type MappedImage = {
  shopifyImageId: string;
  url: string;
  altText: string | null;
  position: number;
};

/** Images keep Shopify's own order, which is the order the storefront shows. */
export function mapImage(node: ShopifyImageNode, index: number): MappedImage {
  return {
    shopifyImageId: node.id,
    url: node.url,
    altText: textOrNull(node.altText),
    position: index + 1,
  };
}
