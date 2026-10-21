/**
 * The product detail page's variant rules.
 *
 * Pure-logic, like the rest of the frontend suite: no DOM, no database. The
 * display helpers are asserted directly; the page and table are asserted
 * against their source, which is how this suite already checks declarations it
 * cannot execute (see the next.config.ts cases in rs-products-catalogue).
 *
 * Each rule below exists because the real catalogue contains a case that would
 * otherwise read wrongly: 465 products whose only variant is called "Default
 * Title", 36 with several variants, 2 variants with no SKU, and a live variant
 * holding a negative quantity.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ShopifyVariantView } from '@rs/shared';
import {
  formatVariantPrice,
  formatVariantTitle,
  isNegativeVariantStock,
} from '@/components/rs-products/variant-table';
import { EMPTY } from '@/components/rs-products/product-format';

const variant = (over: Partial<ShopifyVariantView> = {}): ShopifyVariantView => ({
  id: 'clx0000000000000000000001',
  shopifyVariantId: 'gid://shopify/ProductVariant/123',
  shopifyInventoryItemId: 'gid://shopify/InventoryItem/456',
  sku: 'RS2331',
  title: 'Default Title',
  price: '499.00',
  costPrice: null,
  crmStockQty: 0,
  weightValue: null,
  weightUnit: null,
  lengthValue: null,
  widthValue: null,
  heightValue: null,
  dimensionUnit: null,
  inventoryQty: 12,
  position: 1,
  ...over,
});

const pageSource = (): string =>
  readFileSync(new URL('../app/(app)/rs-products/[id]/page.tsx', import.meta.url), 'utf8');

const tableSource = (): string =>
  readFileSync(new URL('../components/rs-products/variant-table.tsx', import.meta.url), 'utf8');

describe('variant price', () => {
  it('formats a price as rupees with two decimals', () => {
    expect(formatVariantPrice('499')).toContain('499.00');
    expect(formatVariantPrice('1234.5')).toContain('1,234.50');
  });

  it('falls back to the placeholder rather than printing NaN', () => {
    expect(formatVariantPrice(null)).toBe(EMPTY);
    expect(formatVariantPrice('not a number')).toBe(EMPTY);
  });

  it('keeps paise rather than rounding to the rupee', () => {
    // Prices cross the wire as strings precisely so none is rounded in transit;
    // the display must not undo that.
    expect(formatVariantPrice('99.99')).toContain('99.99');
  });
});

describe('variant title', () => {
  it("suppresses Shopify's Default Title placeholder", () => {
    // 465 of 501 products have exactly one variant, named this by Shopify.
    // Printing it 465 times would say nothing.
    expect(formatVariantTitle('Default Title')).toBe(EMPTY);
  });

  it('shows a real option label', () => {
    expect(formatVariantTitle('Red / Large')).toBe('Red / Large');
  });

  it('handles an absent or empty title', () => {
    expect(formatVariantTitle(null)).toBe(EMPTY);
    expect(formatVariantTitle('')).toBe(EMPTY);
  });
});

describe('negative Shopify stock', () => {
  it('marks a negative quantity rather than clamping it', () => {
    // One live variant holds a negative figure. It is a real oversell, and the
    // catalogue table already shows it rather than rounding up to zero.
    expect(isNegativeVariantStock(variant({ inventoryQty: -10 }))).toBe(true);
    expect(isNegativeVariantStock(variant({ inventoryQty: 0 }))).toBe(false);
    expect(isNegativeVariantStock(variant({ inventoryQty: 5 }))).toBe(false);
  });
});

describe('the variant table', () => {
  it('renders one row per variant, keyed by variant id', () => {
    const source = tableSource();
    expect(source).toContain('variants.map');
    expect(source).toContain('key={variant.id}');
  });

  it('shows every field the detail API actually provides', () => {
    const source = tableSource();
    for (const field of [
      'variant.sku',
      'variant.position',
      'variant.crmStockQty',
      'variant.inventoryQty',
      'variant.shopifyVariantId',
    ]) {
      expect(source, field).toContain(field);
    }
    expect(source).toContain('formatWeight(variant)');
  });

  it('separates CRM stock from Shopify quantity in the headings', () => {
    // The two numbers answer different questions and are never summed, so the
    // column labels must not let a reader conflate them.
    const source = tableSource();
    expect(source).toContain('CRM stock');
    expect(source).toContain('>Shopify<');
  });

  it('states the absence instead of rendering an empty table', () => {
    expect(tableSource()).toContain('no variants recorded');
  });

  it('adds no edit or delete control', () => {
    // The page is read-only by specification; editing stays in the edit form.
    const source = tableSource();
    expect(source).not.toContain('<Input');
    expect(source).not.toContain('<form');
    expect(source).not.toContain('onSubmit');
    expect(source).not.toContain("'use client'");
  });
});

describe('the detail page', () => {
  it('is gated on RS_PRODUCTS VIEW, not EDIT', () => {
    // Reading the catalogue is the lesser privilege. The API enforces the same
    // rule again; this only decides what is worth rendering.
    const source = pageSource();
    expect(source).toContain("requireModule('RS_PRODUCTS')");
    expect(source).toContain("'RS_PRODUCTS', 'VIEW'");
    expect(source).toContain('NoModuleAccess');
  });

  it('awaits params, as this version of Next requires', () => {
    const source = pageSource();
    expect(source).toContain('params: Promise<{ id: string }>');
    expect(source).toContain('await params');
  });

  it('renders the API failure instead of throwing', () => {
    // A missing product answers 404 and ErrorMessage states that plainly,
    // which beats a generic not-found page.
    const source = pageSource();
    expect(source).toContain('if (!result.success)');
    expect(source).toContain('ErrorMessage');
  });

  it('reuses the existing fetcher, badges and variant table', () => {
    const source = pageSource();
    expect(source).toContain('fetchRsProduct');
    expect(source).toContain('ProductStatusBadge');
    expect(source).toContain('ProductSourceBadge');
    expect(source).toContain('<VariantTable variants={product.variants} />');
  });

  it('offers the edit link only to someone who may edit', () => {
    const source = pageSource();
    expect(source).toContain("'RS_PRODUCTS', 'EDIT'");
    expect(source).toContain('canEdit &&');
  });

  it('renders the Shopify description as text, never as markup', () => {
    // Shopify sends description HTML. dangerouslySetInnerHTML here would let
    // the store inject into the CRM.
    expect(pageSource()).not.toContain('dangerouslySetInnerHTML');
  });

  it('does not hide an archived or unlisted product', () => {
    // Status is shown, never a reason to withhold the row: products/delete
    // archives rather than removes, and the variants survive.
    const source = pageSource();
    expect(source).not.toContain("status !== 'ARCHIVED'");
    expect(source).not.toContain('notFound()');
  });
});

describe('the catalogue row links to the detail page', () => {
  it('wraps the product title in a link to /rs-products/[id]', () => {
    const source = readFileSync(
      new URL('../components/rs-products/product-table.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('href={`/rs-products/${product.id}`}');
    expect(source).toContain("import Link from 'next/link'");
  });

  it('keeps the table a Server Component', () => {
    // A plain Link ships no JavaScript; making the row interactive would.
    const source = readFileSync(
      new URL('../components/rs-products/product-table.tsx', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain("'use client'");
  });
});
