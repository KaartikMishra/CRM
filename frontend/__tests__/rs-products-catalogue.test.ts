/**
 * The catalogue's display rules.
 *
 * Pure-logic, like the rest of the frontend suite: no DOM, no database. Each
 * rule below exists because the real catalogue contains a case that would
 * otherwise be rendered wrongly — repeated SKUs, a negative stock figure,
 * a 222-character title, variants at different prices.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RsProductListRow } from '@rs/shared';
import { RS_PRODUCT_SORTS, SHOPIFY_PRODUCT_STATUSES, PRODUCT_SOURCES } from '@rs/shared';
import {
  EMPTY,
  formatDimensions,
  formatInventory,
  formatPriceRange,
  formatSku,
  formatVolume,
  formatWeight,
  isNegativeStock,
  truncateTitle,
  variantSummary,
} from '@/components/rs-products/product-format';
import { RS_PRODUCT_PAGE_LIMIT } from '@/lib/rs-product-api';

const row = (over: Partial<RsProductListRow> = {}): RsProductListRow => ({
  id: 'clx0000000000000000000000',
  title: 'Copper Bottle',
  source: 'SHOPIFY',
  status: 'ACTIVE',
  productType: 'Drinkware',
  vendor: 'ROYAL STUFFS',
  imageUrl: 'https://cdn.shopify.com/x.jpg',
  imageAlt: null,
  sku: 'RS2331',
  variantCount: 1,
  priceMin: '1399.00',
  priceMax: '1399.00',
  inventoryQty: 994,
  crmStockQty: 0,
  weightValue: '0.6',
  weightUnit: 'KG',
  lengthValue: null,
  widthValue: null,
  heightValue: null,
  dimensionUnit: null,
  createdAt: '2026-09-11T00:00:00.000Z',
  ...over,
});

describe('price', () => {
  it('shows one price when every variant agrees', () => {
    const text = formatPriceRange(row({ priceMin: '1399.00', priceMax: '1399.00' }));
    expect(text).toContain('1,399.00');
    expect(text).not.toContain('–');
  });

  it('shows a range when variants differ — 36 live products do', () => {
    const text = formatPriceRange(row({ priceMin: '1080.15', priceMax: '2516.55' }));
    expect(text).toContain('1,080.15');
    expect(text).toContain('2,516.55');
    expect(text).toContain('–');
  });

  it('falls back to a dash when there is no price', () => {
    expect(formatPriceRange(row({ priceMin: null, priceMax: null }))).toBe(EMPTY);
  });
});

describe('weight', () => {
  it('keeps the unit Shopify recorded rather than converting', () => {
    expect(formatWeight(row({ weightValue: '0.6', weightUnit: 'KG' }))).toBe('0.6 kg');
    expect(formatWeight(row({ weightValue: '260', weightUnit: 'G' }))).toBe('260 g');
  });

  it('drops trailing zeros without losing precision', () => {
    expect(formatWeight(row({ weightValue: '1.250', weightUnit: 'KG' }))).toBe('1.25 kg');
    expect(formatWeight(row({ weightValue: '2.000', weightUnit: 'KG' }))).toBe('2 kg');
  });

  it('dashes when weight is absent', () => {
    expect(formatWeight(row({ weightValue: null, weightUnit: null }))).toBe(EMPTY);
  });
});

describe('dimensions and volume stay unstated', () => {
  it('renders a dash while the unit is unresolved', () => {
    expect(formatDimensions(row())).toBe(EMPTY);
    expect(formatVolume(row())).toBe(EMPTY);
  });

  it('is ready for real values, so confirming the unit needs no UI change', () => {
    const withDims = row({
      lengthValue: '3',
      widthValue: '3',
      heightValue: '9.8',
      dimensionUnit: 'IN',
    });
    expect(formatDimensions(withDims)).toBe('3 × 3 × 9.8 in');
    expect(formatVolume(withDims)).toBe('88.2 in³');
  });

  it('refuses to guess when the unit alone is missing', () => {
    // Exactly the live situation: three numbers, no unit anywhere.
    const noUnit = row({
      lengthValue: '3',
      widthValue: '3',
      heightValue: '9.8',
      dimensionUnit: null,
    });
    expect(formatDimensions(noUnit)).toBe(EMPTY);
    expect(formatVolume(noUnit)).toBe(EMPTY);
  });
});

describe('SKU', () => {
  it('shows the SKU for a single-variant product', () => {
    expect(formatSku(row({ sku: 'RS2331', variantCount: 1 }))).toBe('RS2331');
  });

  it('says how many more when a product has several variants', () => {
    expect(formatSku(row({ sku: 'RS2521', variantCount: 3 }))).toBe('RS2521 +2 more');
  });

  it('dashes when a variant has no SKU — 2 live variants do not', () => {
    expect(formatSku(row({ sku: null }))).toBe(EMPTY);
  });
});

describe('variant summary', () => {
  it('says nothing for a single variant, which is 465 of 501 products', () => {
    expect(variantSummary(row({ variantCount: 1 }))).toBeNull();
  });

  it('counts them when there is more than one', () => {
    expect(variantSummary(row({ variantCount: 3 }))).toBe('3 variants');
  });
});

describe('inventory', () => {
  it('formats a large quantity readably', () => {
    expect(formatInventory(row({ inventoryQty: 994 }))).toBe('994');
    expect(formatInventory(row({ inventoryQty: 100000 }))).toContain('1,00,000');
  });

  it('shows a negative figure rather than hiding an oversell', () => {
    expect(formatInventory(row({ inventoryQty: -10 }))).toBe('-10');
    expect(isNegativeStock(row({ inventoryQty: -10 }))).toBe(true);
    expect(isNegativeStock(row({ inventoryQty: 0 }))).toBe(false);
  });
});

describe('titles', () => {
  it('leaves a short title alone', () => {
    expect(truncateTitle('Copper Bottle')).toBe('Copper Bottle');
  });

  it('truncates the long ones — the live maximum is 222 characters', () => {
    const long = 'A'.repeat(222);
    const out = truncateTitle(long);
    expect(out.length).toBeLessThanOrEqual(70);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('contract and configuration', () => {
  it('agrees with the backend on every sort value', () => {
    expect([...RS_PRODUCT_SORTS]).toEqual(['title', 'price', 'inventory', 'newest']);
  });

  it('knows all four product statuses, UNLISTED included', () => {
    expect(SHOPIFY_PRODUCT_STATUSES).toContain('UNLISTED');
    expect(SHOPIFY_PRODUCT_STATUSES).toHaveLength(4);
  });

  it('knows both sources', () => {
    expect([...PRODUCT_SOURCES]).toEqual(['SHOPIFY', 'MANUAL']);
  });

  it('requests a page size the backend accepts', () => {
    expect(RS_PRODUCT_PAGE_LIMIT).toBeGreaterThan(0);
    expect(RS_PRODUCT_PAGE_LIMIT).toBeLessThanOrEqual(100);
  });

  it('declares the Shopify CDN as a permitted image host', () => {
    // next/image throws on an unconfigured remote host, so this declaration is
    // load-bearing: without it every one of the 2,231 thumbnails fails.
    const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('cdn.shopify.com');
    expect(config).toContain('remotePatterns');
  });

  it('never declares a NEXT_PUBLIC Shopify credential', () => {
    const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
    expect(config).not.toContain('NEXT_PUBLIC_SHOPIFY');
    expect(config).not.toContain('SHOPIFY_CLIENT_SECRET');
  });
});
