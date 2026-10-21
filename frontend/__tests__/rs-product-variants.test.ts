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
  formatVariantStockValue,
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
    // column labels must not let a reader conflate them. The Shopify column is
    // named "Shopify qty" since valuation added a cost column beside it —
    // "Shopify" alone would no longer say which Shopify figure it meant.
    const source = tableSource();
    expect(source).toContain('CRM stock');
    expect(source).toContain('>Shopify qty<');
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

describe('variant stock value display', () => {
  it('shows cost price x CRM stock', () => {
    const shown = formatVariantStockValue(variant({ costPrice: '250.00', crmStockQty: 4 }));
    expect(shown).toContain('1,000.00');
  });

  it('shows a dash, never a zero, when the cost price is unknown', () => {
    // A zero here would read as "this stock is worthless" rather than
    // "nobody has entered its cost".
    expect(formatVariantStockValue(variant({ costPrice: null, crmStockQty: 10 }))).toBe(EMPTY);
  });

  it('shows zero for costed stock of zero quantity, which is a real answer', () => {
    const shown = formatVariantStockValue(variant({ costPrice: '500.00', crmStockQty: 0 }));
    expect(shown).toContain('0.00');
    expect(shown).not.toBe(EMPTY);
  });

  it('keeps paise exact rather than drifting through a float', () => {
    expect(formatVariantStockValue(variant({ costPrice: '19.99', crmStockQty: 7 }))).toContain(
      '139.93',
    );
  });

  it('shows a negative value rather than clamping it', () => {
    const shown = formatVariantStockValue(variant({ costPrice: '100.00', crmStockQty: -3 }));
    expect(shown).toContain('300.00');
    expect(shown).toContain('-');
  });
});

describe('the variant table separates CRM money from Shopify money', () => {
  it('labels the Shopify price and the CRM cost distinctly', () => {
    // Confusing the two would misstate every valuation on the page.
    const source = tableSource();
    expect(source).toContain('Shopify price');
    expect(source).toContain('Cost price');
    expect(source).toContain('Stock value');
    expect(source).toContain('CRM stock');
    expect(source).toContain('Shopify qty');
  });

  it('marks an unset cost price rather than rendering a number', () => {
    expect(tableSource()).toContain('Not set');
  });

  it('computes value through the shared calculator, not its own arithmetic', () => {
    // One implementation, so the product total and the dashboard cannot drift.
    const source = tableSource();
    expect(source).toContain("from '@rs/shared'");
    expect(source).toContain('variantStockValue');
    expect(source).toContain('valueProduct');
    expect(source).not.toMatch(/costPrice\s*\*\s*/);
  });
});

describe('the product stock value panel', () => {
  it('states the total and the CRM units', () => {
    const source = tableSource();
    expect(source).toContain('Total stock value');
    expect(source).toContain('CRM units');
  });

  it('says so when a cost price is missing, instead of implying completeness', () => {
    const source = tableSource();
    expect(source).toContain('totals.incomplete');
    expect(source).toContain('Cost price missing');
    expect(source).toContain('unitsWithUnknownCost');
  });
});

describe('the dashboard stock valuation card', () => {
  const cardSource = (): string =>
    readFileSync(
      new URL('../components/rs-products/stock-valuation-card.tsx', import.meta.url),
      'utf8',
    );

  it('labels the figure as the known value', () => {
    // The total excludes every variant whose cost nobody has entered, and the
    // label has to say so rather than leaving it to a footnote.
    const source = cardSource();
    expect(source).toContain('Known value');
    expect(source).toContain('primary.knownValue');
  });

  it('shows units, missing-cost counts and the incomplete warning', () => {
    const source = cardSource();
    expect(source).toContain('primary.totalUnits');
    expect(source).toContain('primary.variantsMissingCost');
    expect(source).toContain('primary.productsMissingCost');
    expect(source).toContain('primary.unitsWithUnknownCost');
    expect(source).toContain('Valuation incomplete');
  });

  it('reports the archived exclusion rather than hiding it', () => {
    const source = cardSource();
    expect(source).toContain('Excludes archived products');
    expect(source).toContain('archived.knownValue');
  });

  it('surfaces negative CRM stock as an anomaly', () => {
    const source = cardSource();
    expect(source).toContain('negativeStockVariants');
    expect(source).toContain('negative CRM stock');
  });

  it('formats money through the signed shared formatter', () => {
    // formatStockMoney wraps formatINR, which rejects negatives outright —
    // a negative aggregate must render rather than throw.
    expect(cardSource()).toContain('formatStockMoney');
  });
});

describe('the dashboard gates the card on module access', () => {
  const dashboardSource = (): string =>
    readFileSync(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');

  it('asks for the valuation only when the viewer has RS_PRODUCTS', () => {
    // The dashboard's existing rule: the API is not asked for figures the
    // viewer may not see, because the request would be refused anyway.
    const source = dashboardSource();
    expect(source).toContain("hasModule(user, 'RS_PRODUCTS')");
    expect(source).toContain('canProducts ? fetchStockValuation() : null');
  });

  it('renders the card on success AND on failure, never omitting it', () => {
    /*
      Deliberately inverted from its original form. This test used to assert
      `canProducts && valuation?.success`, i.e. that a failed fetch hid the
      card — and that behaviour is exactly what made a stale backend build look
      like an unimplemented feature. The card now always renders for an
      entitled viewer; only which state it shows depends on the fetch.
    */
    const source = dashboardSource();
    expect(source).toContain('{canProducts && (');
    expect(source).not.toContain('canProducts && valuation?.success &&');
  });
});

describe('the dashboard never hides the card on a failed fetch', () => {
  /*
    The regression this guards. The card used to render only on
    `valuation?.success`, so a stale backend build serving no /valuation route
    produced an absent card — indistinguishable from the feature never having
    been built. That cost a full diagnostic cycle.
  */
  const dashboardSource = (): string =>
    readFileSync(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
  const cardSource = (): string =>
    readFileSync(
      new URL('../components/rs-products/stock-valuation-card.tsx', import.meta.url),
      'utf8',
    );

  it('renders the card whenever the viewer may see it, success or not', () => {
    const source = dashboardSource();
    // The gate is module access alone; the fetch outcome chooses WHICH state
    // renders, never WHETHER anything renders.
    expect(source).toContain('{canProducts && (');
    expect(source).toContain('valuation?.success ?');
    expect(source).toContain('unavailable');
  });

  it('keeps the RS_PRODUCTS permission gate intact', () => {
    // The fix must not widen access to make the card appear.
    const source = dashboardSource();
    expect(source).toContain("hasModule(user, 'RS_PRODUCTS')");
    expect(source).toContain('canProducts ? fetchStockValuation() : null');
  });

  it('shows a neutral unavailable state rather than a zero figure', () => {
    const source = cardSource();
    expect(source).toContain('Valuation unavailable');
    expect(source).toContain('misleading zero');
  });

  it('leaks no backend message, error code or request id into the card', () => {
    // A dashboard is the wrong place for internal error detail.
    const source = cardSource();
    expect(source).not.toContain('result.message');
    expect(source).not.toContain('props.message');
    expect(source).not.toContain('requestId');
  });

  it('types the two states as a union so a number cannot be rendered without one', () => {
    const source = cardSource();
    expect(source).toContain('unavailable: true');
    expect(source).toContain('props.valuation');
  });
});

describe('the valuation route contract', () => {
  it('calls the literal /valuation path, which must precede /:id', () => {
    // "valuation" reaching GET /:id answers 422 "Not a valid identifier" —
    // exactly what the stale build did.
    const api = readFileSync(new URL('../lib/rs-product-api.ts', import.meta.url), 'utf8');
    expect(api).toContain("'/api/rs-products/valuation'");
    expect(api).toContain('StockValuationView');
  });

  it('parses the response as { valuation: StockValuationView }', () => {
    const api = readFileSync(new URL('../lib/rs-product-api.ts', import.meta.url), 'utf8');
    expect(api).toContain('{ valuation: StockValuationView }');
  });
});
