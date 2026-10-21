/**
 * Stock valuation arithmetic.
 *
 * Pure: no database, no HTTP. The functions under test are `@rs/shared`'s, and
 * they are the only implementation — the RS Products pages and the Admin
 * Dashboard both call them, so a rule proven here holds on both surfaces.
 *
 * The cases below are the ones that would misstate money if they were wrong.
 * The central one is that a missing cost price is NOT zero: no variant in the
 * live catalogue has a cost yet, so an implementation that valued them at zero
 * would report ₹0.00 and look finished.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_VALUATION,
  countNegativeStock,
  mergeValuations,
  valueCatalogue,
  valueProduct,
  variantStockValue,
  type ValuableProduct,
} from '@rs/shared';

const v = (costPrice: string | null, crmStockQty: number) => ({ costPrice, crmStockQty });
const product = (...variants: { costPrice: string | null; crmStockQty: number }[]): ValuableProduct => ({
  variants,
});

describe('one variant', () => {
  it('multiplies cost price by CRM stock', () => {
    expect(variantStockValue(v('250.00', 4))).toBe('1000.00');
  });

  it('keeps paise exact rather than drifting through a float', () => {
    // 0.1 * 3 is 0.30000000000000004 in binary floating point. Valuation is
    // money, so this must be exact.
    expect(variantStockValue(v('0.10', 3))).toBe('0.30');
    expect(variantStockValue(v('19.99', 7))).toBe('139.93');
    // 123,456 paise × 789 = 97,406,784 paise. Checked against exact decimal
    // arithmetic rather than a figure typed from memory.
    expect(variantStockValue(v('1234.56', 789))).toBe('974067.84');
  });

  it('returns null — not zero — when the cost price is absent', () => {
    // The rule the whole feature rests on. Zero would claim the stock is
    // worthless; null says nobody has priced it.
    expect(variantStockValue(v(null, 10))).toBeNull();
  });

  it('values costed stock of zero quantity at zero, which is a real answer', () => {
    // Distinct from unknown: the variant is priced and holds nothing.
    expect(variantStockValue(v('500.00', 0))).toBe('0.00');
  });

  it('values a zero cost price at zero when zero was actually entered', () => {
    // Someone may legitimately record a free item. That is a known cost of
    // nothing, not an absent one.
    expect(variantStockValue(v('0.00', 25))).toBe('0.00');
  });

  it('does not clamp a negative quantity', () => {
    // crmStockSchema forbids one, so a negative figure means validation was
    // bypassed. Returning a negative keeps that visible.
    expect(variantStockValue(v('100.00', -3))).toBe('-300.00');
  });
});

describe('one product', () => {
  it('sums its variants', () => {
    const totals = valueProduct(product(v('100.00', 2), v('50.50', 4), v('10.00', 1)));

    expect(totals.knownValue).toBe('412.00');
    expect(totals.totalUnits).toBe(7);
    expect(totals.variantsValued).toBe(3);
    expect(totals.incomplete).toBe(false);
    expect(totals.variantsMissingCost).toBe(0);
    expect(totals.productsMissingCost).toBe(0);
  });

  it('excludes an uncosted variant from the total and counts it instead', () => {
    const totals = valueProduct(product(v('100.00', 2), v(null, 5)));

    // 200.00 only — the uncosted 5 units are absent from the money figure.
    expect(totals.knownValue).toBe('200.00');
    // But their units are still counted, so nothing disappears silently.
    expect(totals.totalUnits).toBe(7);
    expect(totals.unitsWithUnknownCost).toBe(5);
    expect(totals.variantsMissingCost).toBe(1);
    expect(totals.productsMissingCost).toBe(1);
    expect(totals.variantsValued).toBe(1);
    expect(totals.incomplete).toBe(true);
  });

  it('does not flag an uncosted variant that holds no stock', () => {
    // 565 of 570 live variants are in exactly this state. Flagging them would
    // bury the ones that actually need a cost price.
    const totals = valueProduct(product(v('100.00', 2), v(null, 0)));

    expect(totals.variantsMissingCost).toBe(0);
    expect(totals.unitsWithUnknownCost).toBe(0);
    expect(totals.incomplete).toBe(false);
    expect(totals.knownValue).toBe('200.00');
  });

  it('counts a product once however many of its variants lack a cost', () => {
    const totals = valueProduct(product(v(null, 3), v(null, 4), v(null, 5)));

    expect(totals.variantsMissingCost).toBe(3);
    // One product, not three — the dashboard reports products needing
    // attention, not rows.
    expect(totals.productsMissingCost).toBe(1);
    expect(totals.unitsWithUnknownCost).toBe(12);
    expect(totals.knownValue).toBe('0.00');
    expect(totals.incomplete).toBe(true);
  });

  it('reports an empty product as zero and complete', () => {
    const totals = valueProduct(product());
    expect(totals).toEqual(EMPTY_VALUATION);
  });
});

describe('the catalogue', () => {
  it('sums products, and the total equals the sum of the product totals', () => {
    // The reconciliation the dashboard depends on: one aggregation, so the
    // dashboard figure and the product pages cannot disagree.
    const products = [
      product(v('100.00', 2), v('200.00', 1)),
      product(v('19.99', 3)),
      product(v(null, 4)),
    ];

    const catalogue = valueCatalogue(products);
    const byProduct = products.map(valueProduct);

    expect(catalogue.knownValue).toBe('459.97');
    expect(byProduct.reduce((sum, p) => sum + Number(p.knownValue), 0).toFixed(2)).toBe('459.97');
    expect(catalogue.totalUnits).toBe(10);
    expect(catalogue.variantsMissingCost).toBe(1);
    expect(catalogue.productsMissingCost).toBe(1);
    expect(catalogue.incomplete).toBe(true);
  });

  it('is associative, so the order products arrive in cannot change the total', () => {
    const a = product(v('33.33', 3));
    const b = product(v('66.67', 7));
    const c = product(v(null, 2));

    expect(valueCatalogue([a, b, c]).knownValue).toBe(valueCatalogue([c, b, a]).knownValue);
  });

  it('merges two valuations without losing a count', () => {
    const left = valueProduct(product(v('10.00', 1), v(null, 2)));
    const right = valueProduct(product(v('5.00', 2)));
    const merged = mergeValuations(left, right);

    expect(merged.knownValue).toBe('20.00');
    expect(merged.totalUnits).toBe(5);
    expect(merged.unitsWithUnknownCost).toBe(2);
    expect(merged.variantsMissingCost).toBe(1);
    expect(merged.productsMissingCost).toBe(1);
    expect(merged.variantsValued).toBe(2);
    expect(merged.incomplete).toBe(true);
  });

  it('returns the empty valuation for an empty catalogue', () => {
    expect(valueCatalogue([])).toEqual(EMPTY_VALUATION);
  });
});

describe('negative CRM stock', () => {
  it('is counted as an anomaly across products', () => {
    const products = [product(v('10.00', -1), v('10.00', 5)), product(v(null, -2))];
    expect(countNegativeStock(products)).toBe(2);
  });

  it('is zero for an ordinary catalogue', () => {
    expect(countNegativeStock([product(v('10.00', 0), v('10.00', 5))])).toBe(0);
  });
});
