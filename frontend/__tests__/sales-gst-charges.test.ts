/**
 * The GST and charges arithmetic, and the form that shows it.
 *
 * GST is decided PER LINE — both the slab and whether the price includes it —
 * so most of what is asserted below is that two lines of one order can differ
 * on both and still each come out right.
 *
 * The calculation half runs against the real exported function in @rs/shared —
 * the same one the create form previews with, the create schema validates with,
 * and the API derives the money view with. There is no second implementation to
 * test, which is the point.
 *
 * The SQL half — that `sales_order_money_guard` agrees with this to the paise —
 * cannot be asserted here because it needs a database. It is covered in
 * backend/src/modules/sales/__tests__/gst-and-charges.test.ts, which pays an
 * order the exact figure this function returns and then closes it; the trigger
 * only permits that when the two agree exactly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeLineTax,
  computeSalesTotals,
  createSalesOrderSchema,
  halveTax,
  splitInclusive,
  taxSplitFor,
  COUNTRIES,
  DEFAULT_COUNTRY,
  GST_MODES,
  INDIA_STATES,
  SALES_CHARGE_TYPES,
} from '@rs/shared';
import type { ChargeLine, GstMode, GstRate, TaxSplit } from '@rs/shared';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/** A line, with its own slab and its own reading. */
const line = (quantity: number, price: string, gstRate: GstRate, gstMode: GstMode) => ({
  quantity,
  price,
  gstRate,
  gstMode,
});

const totals = (
  items: ReturnType<typeof line>[],
  charges: ChargeLine[] = [],
  split: TaxSplit = 'CGST_SGST',
) => computeSalesTotals({ split, items, charges });

// ===========================================================================
//  A + B — one line, each mode
// ===========================================================================

describe('a single line', () => {
  it('EXCLUDED: the price is the taxable value and GST is added', () => {
    const t = totals([line(1, '90.00', '5', 'EXCLUSIVE')]);

    expect(t.taxableSubtotal).toBe('90.00');
    expect(t.taxTotal).toBe('4.50');
    expect(t.payable).toBe('94.50');
    expect(t.perLine[0]).toEqual({
      lineTotal: '90.00',
      taxable: '90.00',
      tax: '4.50',
      payable: '94.50',
    });
  });

  it('INCLUDED: the price already contains the GST', () => {
    const t = totals([line(1, '90.00', '5', 'INCLUSIVE')]);

    expect(t.taxableSubtotal).toBe('85.71');
    expect(t.taxTotal).toBe('4.29');
    // The customer still pays what was typed.
    expect(t.payable).toBe('90.00');
    expect(t.perLine[0]!.payable).toBe('90.00');
  });

  it('never loses a paisa carving tax out of an inclusive price', () => {
    // base + tax must be the gross exactly, at every rate and every awkward
    // amount. Rounding both halves independently would let them miss each
    // other and produce an invoice that does not add up.
    for (const rate of [5, 12, 18, 28]) {
      for (const gross of ['0.01', '0.99', '1.00', '33.33', '99.99', '12345.67']) {
        const { base, tax } = splitInclusive(gross, rate);
        expect(Number(base) + Number(tax)).toBeCloseTo(Number(gross), 2);
      }
    }
  });

  it('offers exactly two modes', () => {
    expect([...GST_MODES]).toEqual(['EXCLUSIVE', 'INCLUSIVE']);
  });
});

// ===========================================================================
//  C — mixed modes in ONE order. The whole point of this change.
// ===========================================================================

describe('mixed GST modes in the same order', () => {
  it('reads each line on its own terms', () => {
    // Exactly the worked example from the requirement.
    const t = totals([line(1, '1000.00', '5', 'EXCLUSIVE'), line(1, '1000.00', '18', 'INCLUSIVE')]);

    expect(t.perLine[0]).toEqual({
      lineTotal: '1000.00',
      taxable: '1000.00',
      tax: '50.00',
      payable: '1050.00',
    });
    expect(t.perLine[1]).toEqual({
      lineTotal: '1000.00',
      taxable: '847.46',
      tax: '152.54',
      payable: '1000.00',
    });

    expect(t.taxableSubtotal).toBe('1847.46');
    expect(t.taxTotal).toBe('202.54');
    expect(t.payable).toBe('2050.00');
  });

  it('does not let one line change another', () => {
    // Flipping line 2's mode must move line 2 and nothing else.
    const before = totals([line(1, '500.00', '5', 'EXCLUSIVE'), line(1, '500.00', '5', 'EXCLUSIVE')]);
    const after = totals([line(1, '500.00', '5', 'EXCLUSIVE'), line(1, '500.00', '5', 'INCLUSIVE')]);

    expect(after.perLine[0]).toEqual(before.perLine[0]);
    expect(after.perLine[1]).not.toEqual(before.perLine[1]);
  });

  it('is identical however the lines are ordered', () => {
    const a = totals([line(1, '1000.00', '5', 'EXCLUSIVE'), line(1, '1000.00', '18', 'INCLUSIVE')]);
    const b = totals([line(1, '1000.00', '18', 'INCLUSIVE'), line(1, '1000.00', '5', 'EXCLUSIVE')]);

    expect(b.payable).toBe(a.payable);
    expect(b.taxTotal).toBe(a.taxTotal);
  });
});

// ===========================================================================
//  D + E — slabs, and the untaxed line
// ===========================================================================

describe('slabs', () => {
  it('reports each slab separately, smallest first', () => {
    const t = totals([
      line(1, '100.00', '18', 'EXCLUSIVE'),
      line(1, '100.00', '5', 'EXCLUSIVE'),
    ]);

    expect(t.byRate.map((r) => r.rate)).toEqual([5, 18]);
    expect(t.byRate[0]!.tax).toBe('5.00');
    expect(t.byRate[1]!.tax).toBe('18.00');
    expect(t.taxTotal).toBe('23.00');
  });

  it('groups a slab by rate, not by how each price was typed', () => {
    // 5% inclusive and 5% exclusive belong to the same slab row; the taxable
    // value each contributed differs, and the row sums both.
    const t = totals([line(1, '105.00', '5', 'INCLUSIVE'), line(1, '100.00', '5', 'EXCLUSIVE')]);

    expect(t.byRate).toHaveLength(1);
    expect(t.byRate[0]!.rate).toBe(5);
    expect(t.byRate[0]!.taxable).toBe('200.00');
    expect(t.byRate[0]!.tax).toBe('10.00');
  });

  it('taxes NONE and 0 at nothing, and still counts them as goods', () => {
    const t = totals([
      line(2, '50.00', 'NONE', 'EXCLUSIVE'),
      line(1, '25.00', '0', 'INCLUSIVE'),
    ]);

    expect(t.taxTotal).toBe('0.00');
    expect(t.taxableSubtotal).toBe('125.00');
    expect(t.payable).toBe('125.00');
    // Neither belongs in a rate table: one is no decision, the other is a
    // decision to charge nothing, and neither is a slab.
    expect(t.byRate).toHaveLength(0);
  });

  it('ignores the mode entirely on an untaxed line', () => {
    const excl = computeLineTax(line(1, '100.00', 'NONE', 'EXCLUSIVE'));
    const incl = computeLineTax(line(1, '100.00', 'NONE', 'INCLUSIVE'));

    expect(incl).toEqual(excl);
    expect(excl.payable).toBe('100.00');
  });
});

// ===========================================================================
//  F + G — the heads
// ===========================================================================

describe('the tax is posted to the right heads', () => {
  it('splits an intra-state sale in half', () => {
    const t = totals([line(1, '90.00', '5', 'EXCLUSIVE')]);

    expect(t.cgstTotal).toBe('2.25');
    expect(t.sgstTotal).toBe('2.25');
    expect(t.igstTotal).toBe('0.00');
  });

  it('puts the whole rate on IGST for an inter-state sale', () => {
    const t = totals([line(1, '90.00', '5', 'EXCLUSIVE')], [], 'IGST');

    expect(t.igstTotal).toBe('4.50');
    expect(t.cgstTotal).toBe('0.00');
    expect(t.sgstTotal).toBe('0.00');
    // Same tax either way — only the heads differ.
    expect(t.taxTotal).toBe('4.50');
    expect(t.payable).toBe('94.50');
  });

  it('splits a mixed-mode order the same way', () => {
    const items = [line(1, '1000.00', '5', 'EXCLUSIVE'), line(1, '1000.00', '18', 'INCLUSIVE')];
    const intra = totals(items);
    const inter = totals(items, [], 'IGST');

    // Per slab: 5% -> 50.00 split 25/25; 18% -> 152.54 split 76.27/76.27.
    expect(intra.byRate[0]!.cgst).toBe('25.00');
    expect(intra.byRate[1]!.cgst).toBe('76.27');
    // The order totals are the sum of both slabs, not either one.
    expect(intra.cgstTotal).toBe('101.27');
    expect(intra.sgstTotal).toBe('101.27');
    expect(inter.igstTotal).toBe(intra.taxTotal);
    // The heads change; the payable does not.
    expect(inter.payable).toBe(intra.payable);
  });

  it('halves an odd number of paise without losing one', () => {
    const { cgst, sgst } = halveTax('4.29');

    expect(cgst).toBe('2.15');
    expect(sgst).toBe('2.14');
    expect(Number(cgst) + Number(sgst)).toBeCloseTo(4.29, 2);
  });

  it('decides the heads from the two states, order level', () => {
    const inIndia = (state: string | null) => ({ state, country: 'India' });

    expect(taxSplitFor('Karnataka', inIndia('Karnataka'))).toBe('CGST_SGST');
    expect(taxSplitFor('Karnataka', inIndia('Maharashtra'))).toBe('IGST');
    // Unknown either side falls back to intra-state rather than guessing IGST,
    // which would overstate a head on a document somebody files.
    expect(taxSplitFor('Karnataka', inIndia(null))).toBe('CGST_SGST');
    expect(taxSplitFor(null, inIndia('Maharashtra'))).toBe('CGST_SGST');
  });

  it('applies no Indian head at all to a customer abroad', () => {
    expect(taxSplitFor('Karnataka', { state: null, country: 'Lesotho' })).toBe('NONE');
    // The contradiction the customer schema now refuses, asserted here too:
    // even if such a pair reached this function, it must not become CGST.
    expect(taxSplitFor('Haryana', { state: 'Haryana', country: 'Lesotho' })).toBe('NONE');
  });

  it('reads a customer with no country recorded as domestic, not as an export', () => {
    // Every customer predating the country field has none. Reading those as
    // foreign would strip the tax off orders that have always carried it.
    expect(taxSplitFor('Karnataka', { state: 'Karnataka', country: null })).toBe('CGST_SGST');
    expect(taxSplitFor('Karnataka', { state: 'Maharashtra', country: null })).toBe('IGST');
  });

  it('matches the country case-insensitively, as it does the state', () => {
    expect(taxSplitFor('Karnataka', { state: 'Karnataka', country: 'india' })).toBe('CGST_SGST');
  });

  it('posts nothing to any head when the split is NONE', () => {
    const totals = computeSalesTotals({
      split: 'NONE',
      items: [{ quantity: 2, price: '100.00', gstRate: 'NONE', gstMode: 'EXCLUSIVE' }],
    });

    expect(totals.taxTotal).toBe('0.00');
    expect(totals.cgstTotal).toBe('0.00');
    expect(totals.sgstTotal).toBe('0.00');
    expect(totals.igstTotal).toBe('0.00');
    // The goods are still owed for — only the tax is absent.
    expect(totals.payable).toBe('200.00');
  });
});

// ===========================================================================
//  H — charges, order level, with mixed modes underneath
// ===========================================================================

describe('charges and adjustments', () => {
  it('adds every kind except a discount, which subtracts', () => {
    const t = totals(
      [line(2, '100.00', '18', 'EXCLUSIVE')],
      [
        { type: 'SHIPPING', amount: '250.00' },
        { type: 'PACKING', amount: '25.00' },
        { type: 'DISCOUNT', amount: '30.00' },
      ],
    );

    expect(t.chargesTotal).toBe('275.00');
    expect(t.discountTotal).toBe('30.00');
    // 200 goods + 36 GST + 275 charges − 30 discount.
    expect(t.payable).toBe('481.00');
  });

  it('applies over a mixed-mode order in the stated order', () => {
    const t = totals(
      [
        line(1, '1000.00', '5', 'EXCLUSIVE'),
        line(1, '1000.00', '18', 'INCLUSIVE'),
        line(2, '50.00', 'NONE', 'EXCLUSIVE'),
      ],
      [
        { type: 'SHIPPING', amount: '200.00' },
        { type: 'DISCOUNT', amount: '75.00' },
      ],
    );

    // goods 1847.46 + 100.00 untaxed = 1947.46, tax 202.54, +200 −75.
    expect(t.taxableSubtotal).toBe('1947.46');
    expect(t.taxTotal).toBe('202.54');
    expect(t.payable).toBe('2275.00');
  });

  it('never taxes a charge', () => {
    const without = totals([line(1, '100.00', '18', 'EXCLUSIVE')]);
    const with_ = totals([line(1, '100.00', '18', 'EXCLUSIVE')], [
      { type: 'SHIPPING', amount: '500.00' },
    ]);

    expect(with_.taxTotal).toBe(without.taxTotal);
    expect(with_.payable).toBe('618.00');
  });

  it('keeps every charge type the UI offers, and they stay order level', () => {
    expect([...SALES_CHARGE_TYPES]).toEqual([
      'DUTY',
      'PACKING',
      'SHIPPING',
      'CUSTOMIZATION',
      'DISCOUNT',
      'OTHER',
    ]);
  });
});

// ===========================================================================
//  I + K — the schema: payable ceiling, and what it refuses
// ===========================================================================

describe('the create schema', () => {
  const base = {
    orderId: 'ZZ-1001',
    customerId: 'clh0000000000000000000000',
    orderDate: '2026-09-24',
    toBeDispatchedBy: '2026-09-25',
    /*
      Every case below pays something, and a payment now has to say how it
      arrived. Stated once here so these tests go on testing the payment
      CEILING, which is what they are for, rather than the new rule beside it —
      that one has its own tests.
    */
    paymentMethod: 'PREPAID',
  };
  const item = (price: string, gstRate: string, gstMode: string) => ({
    productName: 'Brass lamp',
    quantity: 1,
    price,
    gstRate,
    gstMode,
  });

  it('accepts a payment that covers the goods AND their GST', () => {
    const parsed = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('90.00', '5', 'EXCLUSIVE')],
      paidAmount: '94.50',
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('measures the ceiling across mixed modes', () => {
    // 1050.00 + 1000.00 = 2050.00 payable.
    const ok = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('1000.00', '5', 'EXCLUSIVE'), item('1000.00', '18', 'INCLUSIVE')],
      paidAmount: '2050.00',
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);

    const over = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('1000.00', '5', 'EXCLUSIVE'), item('1000.00', '18', 'INCLUSIVE')],
      paidAmount: '2050.01',
    });
    expect(over.success).toBe(false);
  });

  it('counts charges towards what may be paid', () => {
    const parsed = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('90.00', '5', 'EXCLUSIVE')],
      charges: [{ type: 'SHIPPING', amount: '100.00' }],
      paidAmount: '194.50',
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('defaults each line to prices excluding GST', () => {
    const parsed = createSalesOrderSchema.safeParse({
      ...base,
      items: [{ productName: 'Brass lamp', quantity: 1, price: '90.00' }],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]!.gstMode).toBe('EXCLUSIVE');
      expect(parsed.data.charges).toEqual([]);
    }
  });

  it('rejects an invalid GST mode and an invalid slab', () => {
    const badMode = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('90.00', '5', 'SOMETIMES')],
    });
    expect(badMode.success).toBe(false);

    const badRate = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('90.00', '7', 'EXCLUSIVE')],
    });
    expect(badRate.success).toBe(false);
  });

  it('has no order-level GST mode left to send', () => {
    const parsed = createSalesOrderSchema.safeParse({
      ...base,
      items: [item('90.00', '5', 'EXCLUSIVE')],
      gstMode: 'INCLUSIVE',
    });

    expect(parsed.success).toBe(true);
    // Stripped rather than honoured: the order no longer has one.
    if (parsed.success) expect('gstMode' in parsed.data).toBe(false);
  });
});

// ===========================================================================
//  Customer reference data
// ===========================================================================

describe('customer address fields', () => {
  it('carries the Union Territories, not only the States', () => {
    for (const ut of [
      'Delhi',
      'Chandigarh',
      'Puducherry',
      'Jammu and Kashmir',
      'Ladakh',
      'Lakshadweep',
      'Andaman and Nicobar Islands',
      'Dadra and Nagar Haveli and Daman and Diu',
    ]) {
      expect(INDIA_STATES as readonly string[]).toContain(ut);
    }
    expect(INDIA_STATES).toHaveLength(36);
  });

  it('offers a country list that starts on India', () => {
    expect(DEFAULT_COUNTRY).toBe('India');
    expect(COUNTRIES as readonly string[]).toContain('India');
    expect(COUNTRIES.length).toBeGreaterThan(150);
  });
});

// ===========================================================================
//  The form — static reads, in the style of the other UI suites here
// ===========================================================================

describe('the create form puts GST on the line', () => {
  const form = source('../components/sales/create-sales-order-form.tsx');
  const breakdown = source('../components/sales/money-breakdown.tsx');
  const editor = source('../components/sales/charges-editor.tsx');

  it('previews with the shared function, not a local calculation', () => {
    expect(form).toContain('computeSalesTotals({');
    // The guard that matters: no second implementation of the tax arithmetic.
    expect(form).not.toMatch(/\*\s*0?\.0[58]|\/\s*1\.05|percent\s*\//);
  });

  it('has NO order-level GST mode switch', () => {
    // The regression this guards: one switch controlling the whole document.
    expect(form).not.toContain('How prices are entered');
    expect(form).not.toContain('setGstMode(mode)');
    expect(form).not.toContain('aria-pressed={gstMode === mode}');
  });

  it('offers a GST mode on every product line', () => {
    expect(form).toContain('GST mode');
    expect(form).toContain('updateItem(item.key, { gstMode: value as GstMode })');
    expect(form).toContain('GST_MODE_LABELS[mode]');
  });

  it('sends the mode with each item, not with the order', () => {
    expect(form).toContain('gstMode: item.gstMode,');
    expect(form).not.toMatch(/^\s+gstMode,$/m);
  });

  it('feeds each line its own mode into the preview', () => {
    expect(form).toContain('gstMode: i.gstMode,');
  });

  it('names the payable as the payable', () => {
    expect(form).toContain('Total payable');
  });

  it('groups each slab as rate -> taxable -> GST, with the heads stated once', () => {
    /*
      This used to assert `slab.rate / 2`, which printed 'CGST 2.5%' beneath
      every slab and then again as a total — six near-identical lines on a
      two-slab order. The heads are now stated once, at the end.
    */
    expect(breakdown).toContain('{slab.rate}% GST');
    expect(breakdown).toContain("label=\"Taxable\"");
    expect(breakdown).toContain("label=\"Total GST\"");
    expect(breakdown).toContain("label=\"CGST\"");
    expect(breakdown).toContain("label=\"SGST\"");
    expect(breakdown).toContain("label=\"IGST\"");
    expect(breakdown).toContain("taxSplit === 'CGST_SGST'");
    // No per-slab head repetition.
    expect(breakdown).not.toContain('slab.rate / 2');
    // An order-level statement about how prices were entered would be a lie.
    expect(breakdown).not.toContain('Prices entered');
  });

  it('shows charges itemised between GST and the payable', () => {
    expect(breakdown).toContain('SALES_CHARGE_TYPE_LABELS[charge.type]');
    expect(breakdown).toContain('Total payable');
  });

  it('feeds the same component from both surfaces', () => {
    expect(form).toContain('charges={usableCharges(charges)}');
  });

  it('keeps discounts positive in the editor and subtracts by type', () => {
    expect(editor).toContain("charge.type === 'DISCOUNT'");
    expect(editor).toContain("isDiscount ? 'Subtracted' : 'Added'");
  });
});

// ===========================================================================
//  The detail page shows the per-line position
// ===========================================================================

describe('the detail page shows GST per line', () => {
  const items = source('../components/sales/sales-item-list.tsx');
  const detail = source('../app/(app)/sales/[id]/page.tsx');

  it('shows each line its slab, mode, taxable value and GST', () => {
    expect(items).toContain('GST {item.gstRate}%');
    expect(items).toContain('GST_MODE_LABELS[item.gstMode]');
    expect(items).toContain('item.taxableAmount');
    expect(items).toContain('item.gstAmount');
  });

  it('does not claim an order-level GST mode', () => {
    expect(detail).not.toContain('order.money.gstMode');
  });

  it('still aggregates the order summary', () => {
    expect(detail).toContain('<MoneyBreakdown');
    expect(detail).toContain('byRate={order.money.taxByRate}');
  });
});

// ===========================================================================
//  Editing the charges on an order that already exists
// ===========================================================================

describe('the detail page can edit charges', () => {
  const dialog = source('../components/sales/edit-charges-dialog.tsx');
  const detail = source('../app/(app)/sales/[id]/page.tsx');
  const actions = source('../app/(app)/sales/actions.ts');

  it('uses the endpoint that already exists, with no second API', () => {
    expect(actions).toContain('/api/sales/${orderId}/charges');
    expect(actions).toContain("method: 'PUT'");
    expect(dialog).toContain('setSalesChargesAction(orderId, usable)');
  });

  it('reuses the same editor the create form uses', () => {
    expect(dialog).toContain('<ChargesEditor');
    expect(dialog).toContain('usableCharges(drafts)');
  });

  it('is offered only while the order is editable', () => {
    expect(detail).toContain('{canEdit && (');
    expect(detail).toContain('<EditChargesDialog');
  });

  it('warns before saving a set that would fall below what was paid', () => {
    // The transition flag is `pendingSave` since a `pending` prop joined it —
    // a charge change already waiting for approval. The guard is unchanged.
    expect(dialog).toContain('belowPaid');
    expect(dialog).toContain('disabled={pendingSave || belowPaid || pending}');
  });
});

// ===========================================================================
//  Company name follows the customer's identity
// ===========================================================================

describe('company name is identity, not address', () => {
  const repo = source('../../backend/src/modules/product-enquiry/product-enquiry.repository.ts');

  it('is withheld alongside name, phone and email', () => {
    expect(repo).toContain('companyName: canSeeCustomer ? row.companyName : null');
  });

  it('leaves address, state, GST and country visible to everyone', () => {
    for (const field of [
      'address: row.address',
      'state: row.state',
      'gstNumber: row.gstNumber',
      'country: row.country',
    ]) {
      expect(repo).toContain(field);
    }
  });
});
