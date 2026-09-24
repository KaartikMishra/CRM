/**
 * The one definition of what a sales order comes to.
 *
 * Every tier reads this function and no tier restates it: the create form
 * previews a total with it, the create schema refuses an overpayment with it,
 * the API derives the money view with it, and the detail page renders the
 * breakup from that view. The only other statement of the same arithmetic is
 * the `sales_order_money_guard` trigger, which has to be in SQL because a
 * database invariant cannot call TypeScript — and the two are pinned to each
 * other by the rounding rules documented in both.
 *
 * GST is decided PER LINE, both the slab and whether the price includes it.
 * One order can carry a line at 5% exclusive beside a line at 18% inclusive
 * beside a line taxed at nothing, because that is what real orders look like —
 * goods bought on different terms are still one document. An order-level mode
 * would have forced a quotation to be re-typed to say what it already said.
 *
 * The order of operations is fixed and is the order a reader expects on an
 * invoice:
 *
 *     taxable subtotal  ->  GST  ->  charges  ->  discount  ->  payable
 *
 * Nothing here is stored. Totals are derived on every read, which is what
 * makes them impossible to disagree with the lines they came from.
 */

import type { GstMode, GstRate, SalesChargeType, TaxSplit } from '../constants/index.js';
import { DISCOUNT_CHARGE_TYPE } from '../constants/index.js';
import {
  addAmount,
  halveTax,
  lineTotal,
  normaliseAmount,
  splitInclusive,
  subtractAmount,
  sumAmounts,
  taxOnExclusive,
} from './money.js';

/** A line, reduced to just what the arithmetic needs. */
export type TaxableLine = {
  quantity: number;
  price: string;
  gstRate: GstRate | null;
  /** How THIS line's price is to be read. Independent of every other line. */
  gstMode: GstMode;
};

/** A charge, reduced likewise. Order level — never per line. */
export type ChargeLine = {
  type: SalesChargeType;
  amount: string;
};

/**
 * What one line contributed, in the order the line was given.
 *
 * Returned so the API can put these figures on the line itself: an invoice
 * shows the tax against the goods it was charged on, and recomputing them
 * anywhere else would be a second statement of this arithmetic.
 */
export type LineTaxBreakup = {
  /** quantity × price, as typed. */
  lineTotal: string;
  /** The value actually taxed. Lower than `lineTotal` when the price includes GST. */
  taxable: string;
  /** The tax on this line alone. */
  tax: string;
  /** What this line adds to the payable: taxable + tax. */
  payable: string;
};

/** One GST slab's contribution, for the rate-by-rate table on an invoice. */
export type TaxRateBreakup = {
  /** The slab, as a whole number of percent. Never 'NONE' and never zero. */
  rate: number;
  /** What was taxed at this rate. */
  taxable: string;
  /** The tax itself, however it is later split. */
  tax: string;
  /** Half each on an intra-state sale; both '0.00' on an inter-state one. */
  cgst: string;
  sgst: string;
  /** The whole tax on an inter-state sale; '0.00' on an intra-state one. */
  igst: string;
};

export type SalesTotals = {
  /** The value of the goods before tax, each line read its own way. */
  taxableSubtotal: string;
  /** What the lines add up to as typed, inclusive prices included in full. */
  lineSubtotal: string;
  taxTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  /** Which heads the tax was posted to. */
  split: TaxSplit;
  byRate: TaxRateBreakup[];
  /** Line by line, in input order. */
  perLine: LineTaxBreakup[];
  /** Everything added beyond the goods: duty, packing, shipping, and so on. */
  chargesTotal: string;
  /** What was taken off. Positive, and subtracted below. */
  discountTotal: string;
  /** taxableSubtotal + tax + charges - discount. What the customer owes. */
  payable: string;
};

/**
 * 'NONE' and '0' are different answers and both come to nothing here.
 *
 * Returning null rather than 0 keeps them distinguishable to the caller: a
 * line with no recorded decision does not belong in the rate-by-rate table at
 * all, and one taxed at zero percent arguably does. Neither adds any tax.
 */
function rateOf(gstRate: GstRate | null): number | null {
  if (gstRate === null || gstRate === 'NONE' || gstRate === '0') return null;
  const parsed = Number(gstRate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Splits a slab's tax into the heads that belong on the invoice.
 *
 * Intra-state is CGST + SGST at half each; inter-state is IGST at the whole
 * rate. The total is identical either way, which is why this happens once at
 * the end rather than being threaded through the arithmetic above.
 */
function postToHeads(tax: string, split: TaxSplit): { cgst: string; sgst: string; igst: string } {
  if (split === 'IGST') return { cgst: '0.00', sgst: '0.00', igst: normaliseAmount(tax) };
  const { cgst, sgst } = halveTax(tax);
  return { cgst, sgst, igst: '0.00' };
}

/**
 * One line, on its own terms.
 *
 * Exported because it is exactly what a single line's preview needs, and
 * because having one place that answers "what does this line come to" is what
 * stops a line card and an order summary disagreeing.
 */
export function computeLineTax(line: TaxableLine): LineTaxBreakup {
  const gross = lineTotal(line.price, line.quantity);
  const rate = rateOf(line.gstRate);

  // Untaxed, and still part of what the customer pays for the goods.
  if (rate === null) {
    return { lineTotal: gross, taxable: gross, tax: '0.00', payable: gross };
  }

  if (line.gstMode === 'INCLUSIVE') {
    const { base, tax } = splitInclusive(gross, rate);
    // The customer pays what was typed; the tax was already inside it.
    return { lineTotal: gross, taxable: base, tax, payable: gross };
  }

  const tax = taxOnExclusive(gross, rate);
  return { lineTotal: gross, taxable: gross, tax, payable: addAmount(gross, tax) };
}

export function computeSalesTotals(input: {
  split: TaxSplit;
  items: readonly TaxableLine[];
  charges?: readonly ChargeLine[];
}): SalesTotals {
  const { split, items, charges = [] } = input;

  /*
    Tax is worked out per line and rounded there, then summed — not worked out
    once on the order's total. A line is what carries a rate and a mode, so it
    is the only level at which "5% of what, read which way" has an answer, and
    rounding once per line is what an Indian tax invoice shows.
  */
  const perRate = new Map<number, { taxable: string; tax: string }>();
  const perLine: LineTaxBreakup[] = [];
  let taxableSubtotal = '0.00';
  let lineSubtotal = '0.00';

  for (const item of items) {
    const line = computeLineTax(item);
    perLine.push(line);

    lineSubtotal = addAmount(lineSubtotal, line.lineTotal);
    taxableSubtotal = addAmount(taxableSubtotal, line.taxable);

    const rate = rateOf(item.gstRate);
    if (rate === null) continue;

    /*
      Grouped by slab and not by (slab, mode). A 5% line entered inclusive and
      a 5% line entered exclusive are taxed at the same rate on different
      taxable values — the invoice says "5% on ₹X", and how each price was
      typed is the line's business, not the slab summary's.
    */
    const running = perRate.get(rate) ?? { taxable: '0.00', tax: '0.00' };
    perRate.set(rate, {
      taxable: addAmount(running.taxable, line.taxable),
      tax: addAmount(running.tax, line.tax),
    });
  }

  const byRate: TaxRateBreakup[] = [...perRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rate, { taxable, tax }]) => ({
      rate,
      taxable,
      tax,
      ...postToHeads(tax, split),
    }));

  // Summed from the per-slab figures rather than recomputed, so the total can
  // never disagree with the table printed above it.
  const taxTotal = sumAmounts(byRate.map((r) => r.tax));
  const cgstTotal = sumAmounts(byRate.map((r) => r.cgst));
  const sgstTotal = sumAmounts(byRate.map((r) => r.sgst));
  const igstTotal = sumAmounts(byRate.map((r) => r.igst));

  const chargesTotal = sumAmounts(
    charges.filter((c) => c.type !== DISCOUNT_CHARGE_TYPE).map((c) => c.amount),
  );
  const discountTotal = sumAmounts(
    charges.filter((c) => c.type === DISCOUNT_CHARGE_TYPE).map((c) => c.amount),
  );

  const payable = subtractAmount(
    addAmount(addAmount(taxableSubtotal, taxTotal), chargesTotal),
    discountTotal,
  );

  return {
    taxableSubtotal,
    lineSubtotal,
    taxTotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    split,
    byRate,
    perLine,
    chargesTotal,
    discountTotal,
    payable,
  };
}

/**
 * Which heads a sale posts to, from the two states involved.
 *
 * Same state, CGST + SGST. Different states, IGST. Where either state is
 * unrecorded the sale is treated as intra-state, because that is the common
 * case and because the alternative — guessing IGST — would overstate a single
 * head on a document somebody files.
 *
 * Order level, not line level: where the goods are going does not change from
 * one line of a document to the next.
 */
export function taxSplitFor(sellerState: string | null, customerState: string | null): TaxSplit {
  if (!sellerState || !customerState) return 'CGST_SGST';
  return sellerState.trim().toLowerCase() === customerState.trim().toLowerCase()
    ? 'CGST_SGST'
    : 'IGST';
}
