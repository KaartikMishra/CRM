import type { RsProductListRow } from '@rs/shared';

/**
 * How a catalogue row's numbers become text.
 *
 * Pure functions, exported separately from the table so the DOM-less frontend
 * test suite can assert them directly. Each one has a rule that is easy to get
 * quietly wrong, and every one of those rules comes from the real catalogue.
 */

/** What an absent value looks like. One dash, used everywhere. */
export const EMPTY = '—';

/**
 * A price, or a range when a product's variants disagree.
 *
 * 36 of the 501 products have variants at different prices; showing only the
 * first variant's price would misstate those by hundreds of rupees.
 */
export function formatPriceRange(row: Pick<RsProductListRow, 'priceMin' | 'priceMax'>): string {
  if (row.priceMin === null || row.priceMax === null) return EMPTY;

  const min = Number(row.priceMin);
  const max = Number(row.priceMax);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return EMPTY;

  const money = (n: number): string =>
    n.toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

/** Weight as Shopify recorded it, unit preserved rather than converted. */
export function formatWeight(
  row: Pick<RsProductListRow, 'weightValue' | 'weightUnit'>,
): string {
  if (row.weightValue === null || row.weightUnit === null) return EMPTY;

  const value = Number(row.weightValue);
  if (!Number.isFinite(value)) return EMPTY;

  // Trailing zeros make a table noisier without making it more precise.
  const text = value % 1 === 0 ? String(value) : String(Number(value.toFixed(3)));
  return `${text} ${row.weightUnit.toLowerCase()}`;
}

/**
 * Dimensions.
 *
 * Always a dash today: the store's dimension metafields carry no unit anywhere,
 * so a number here would have no stateable meaning. The function is written for
 * the values arriving rather than hardcoding the dash, so the column starts
 * working the moment the unit is confirmed.
 */
export function formatDimensions(
  row: Pick<RsProductListRow, 'lengthValue' | 'widthValue' | 'heightValue' | 'dimensionUnit'>,
): string {
  const { lengthValue, widthValue, heightValue, dimensionUnit } = row;
  if (!lengthValue || !widthValue || !heightValue || !dimensionUnit) return EMPTY;

  const n = (v: string): string => String(Number(v));
  return `${n(lengthValue)} × ${n(widthValue)} × ${n(heightValue)} ${dimensionUnit.toLowerCase()}`;
}

/**
 * Volume, derived from dimensions rather than stored.
 *
 * Consequently also a dash today. Deriving it from numbers whose unit is
 * unknown would produce a figure that is wrong by a factor of 16,000 if the
 * guess between inches and centimetres went the wrong way.
 */
export function formatVolume(
  row: Pick<RsProductListRow, 'lengthValue' | 'widthValue' | 'heightValue' | 'dimensionUnit'>,
): string {
  const { lengthValue, widthValue, heightValue, dimensionUnit } = row;
  if (!lengthValue || !widthValue || !heightValue || !dimensionUnit) return EMPTY;

  const volume = Number(lengthValue) * Number(widthValue) * Number(heightValue);
  if (!Number.isFinite(volume)) return EMPTY;

  return `${Number(volume.toFixed(2))} ${dimensionUnit.toLowerCase()}³`;
}

/**
 * The SKU column.
 *
 * SKUs repeat and may be blank — 13 values repeat across the live catalogue and
 * 2 variants have none — so this never treats one as an identifier.
 */
export function formatSku(row: Pick<RsProductListRow, 'sku' | 'variantCount'>): string {
  if (!row.sku) return EMPTY;
  return row.variantCount > 1 ? `${row.sku} +${row.variantCount - 1} more` : row.sku;
}

/** "3 variants", or null when there is nothing worth saying. */
export function variantSummary(row: Pick<RsProductListRow, 'variantCount'>): string | null {
  return row.variantCount > 1 ? `${row.variantCount} variants` : null;
}

/**
 * Inventory, never clamped.
 *
 * One live variant holds −10. Rounding that to zero would hide a real oversell,
 * so the number is shown as it is and the caller styles it.
 */
export function formatInventory(row: Pick<RsProductListRow, 'inventoryQty'>): string {
  return row.inventoryQty.toLocaleString('en-IN');
}

export const isNegativeStock = (row: Pick<RsProductListRow, 'inventoryQty'>): boolean =>
  row.inventoryQty < 0;

/** Long titles are common — the catalogue's longest is 222 characters. */
export function truncateTitle(title: string, max = 70): string {
  return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`;
}
