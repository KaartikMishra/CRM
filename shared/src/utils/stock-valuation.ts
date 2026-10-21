/**
 * Stock valuation — the one place the rules live.
 *
 * `variantStockValue = costPrice × crmStockQty`, summed to a product and then
 * to a catalogue. Both the RS Products detail page and the Admin Dashboard call
 * these functions, so the product totals and the dashboard total cannot
 * disagree: there is no second implementation to drift.
 *
 * ### Money
 *
 * Every amount is a decimal string and every multiplication goes through
 * `lineTotal`, which is exact BigInt paise. No float touches a valuation — a
 * catalogue of 570 variants summed in binary floating point would be wrong by
 * paise, and a figure an administrator reconciles against a bank balance has to
 * be exact.
 *
 * ### The rule that matters most: a missing cost is not zero
 *
 * No variant in the live catalogue has a cost price yet, so this is the normal
 * case rather than an edge one. Valuing an uncosted variant at zero would say
 * "this stock is worthless" when the truth is "nobody has entered its cost",
 * and a dashboard reading ₹0.00 would look like a finished answer. So uncosted
 * stock is excluded from the total and counted instead — `variantsMissingCost`,
 * `unitsWithUnknownCost`, and the `incomplete` flag the UI must surface.
 *
 * ### CRM stock, never Shopify's
 *
 * `crmStockQty` is the hand-maintained count. `inventoryQty` is Shopify's
 * sellable figure, is overwritten by every sync and inventory webhook, and can
 * legitimately be negative. Valuing Shopify's number would value stock the
 * warehouse does not hold, so it is never read here.
 */

import { addAmount, lineTotal } from './money.js';
import type { StockValuationTotals } from '../types/rs-product.js';

/** The minimum a valuation needs to know about one variant. */
export type ValuableVariant = {
  /** Decimal string, or null when nobody has entered a cost. */
  costPrice: string | null;
  /** The CRM's own count. Never Shopify's `inventoryQty`. */
  crmStockQty: number;
};

/** A product's variants, grouped so "products missing cost" can be counted. */
export type ValuableProduct = {
  variants: ValuableVariant[];
};

/** An empty valuation — the identity this module accumulates onto. */
export const EMPTY_VALUATION: StockValuationTotals = {
  knownValue: '0.00',
  totalUnits: 0,
  unitsWithUnknownCost: 0,
  variantsMissingCost: 0,
  productsMissingCost: 0,
  variantsValued: 0,
  incomplete: false,
};

/**
 * One variant's stock value, or null when it cannot be known.
 *
 * Null rather than "0.00" for a missing cost, so a caller cannot accidentally
 * add an unknown into a total — the type forces the distinction that the whole
 * design rests on.
 *
 * Zero stock with a known cost returns "0.00", which is a real answer: the
 * variant is costed and holds nothing, so it contributes nothing. That is not
 * the same as an unknown.
 *
 * A negative quantity is multiplied as given rather than clamped.
 * `crmStockSchema` forbids one, so a negative figure here means stock moved
 * through a path that bypassed validation; returning a negative value keeps
 * that visible instead of absorbing it.
 */
export function variantStockValue(variant: ValuableVariant): string | null {
  if (variant.costPrice === null) return null;
  return lineTotal(variant.costPrice, variant.crmStockQty);
}

/**
 * A product's total, and what it could not account for.
 *
 * `productsMissingCost` is 1 when any of this product's variants holds stock
 * without a cost — counted per product rather than per variant, so the
 * dashboard can say how many products need attention rather than how many rows.
 */
export function valueProduct(product: ValuableProduct): StockValuationTotals {
  let knownValue = '0.00';
  let totalUnits = 0;
  let unitsWithUnknownCost = 0;
  let variantsMissingCost = 0;
  let variantsValued = 0;

  for (const variant of product.variants) {
    totalUnits += variant.crmStockQty;

    const value = variantStockValue(variant);

    if (value === null) {
      /*
        Uncosted. Counted as missing only when it actually holds stock: a
        variant with no cost and no stock contributes nothing either way, and
        flagging it would bury the ones that matter under 565 rows that do not.
      */
      if (variant.crmStockQty !== 0) {
        variantsMissingCost += 1;
        unitsWithUnknownCost += variant.crmStockQty;
      }
      continue;
    }

    knownValue = addAmount(knownValue, value);
    variantsValued += 1;
  }

  return {
    knownValue,
    totalUnits,
    unitsWithUnknownCost,
    variantsMissingCost,
    productsMissingCost: variantsMissingCost > 0 ? 1 : 0,
    variantsValued,
    incomplete: variantsMissingCost > 0,
  };
}

/** Accumulates two valuations. Associative, so the order of pages cannot matter. */
export function mergeValuations(
  a: StockValuationTotals,
  b: StockValuationTotals,
): StockValuationTotals {
  return {
    knownValue: addAmount(a.knownValue, b.knownValue),
    totalUnits: a.totalUnits + b.totalUnits,
    unitsWithUnknownCost: a.unitsWithUnknownCost + b.unitsWithUnknownCost,
    variantsMissingCost: a.variantsMissingCost + b.variantsMissingCost,
    productsMissingCost: a.productsMissingCost + b.productsMissingCost,
    variantsValued: a.variantsValued + b.variantsValued,
    incomplete: a.incomplete || b.incomplete,
  };
}

/** A catalogue's total — the dashboard figure, and the product figures summed. */
export function valueCatalogue(products: ValuableProduct[]): StockValuationTotals {
  return products.map(valueProduct).reduce(mergeValuations, EMPTY_VALUATION);
}

/** Variants whose CRM stock is negative — an anomaly to report, never to clamp. */
export function countNegativeStock(products: ValuableProduct[]): number {
  return products.reduce(
    (count, product) => count + product.variants.filter((v) => v.crmStockQty < 0).length,
    0,
  );
}
