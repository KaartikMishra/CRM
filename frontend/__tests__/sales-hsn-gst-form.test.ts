/**
 * HSN and GST in the Sales order form.
 *
 * There is no DOM in this suite, so the component is asserted structurally by
 * reading the working tree, alongside real behaviour proved against the shared
 * schema. That split is deliberate: the rules worth protecting here are mostly
 * about what the form must *not* do — never invent a rate, never let GST touch
 * a total, never turn 'NONE' into a zero — and those are claims about the code,
 * not about a rendered pixel.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GST_RATES,
  GST_RATE_LABELS,
  HSN_CODE_MAX_LENGTH,
  createSalesOrderSchema,
  lineTotal,
} from '@rs/shared';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const form = read('components/sales/create-sales-order-form.tsx');
const CUID = 'clx0000000000000000000000';

// ---------------------------------------------------------------------------
//  The fields render
// ---------------------------------------------------------------------------

describe('the HSN field', () => {
  it('renders with a label', () => {
    expect(form).toContain('>HSN Code</Label>');
  });

  it('is bound to the line, not to the form', () => {
    expect(form).toContain('value={item.hsnCode}');
    expect(form).toContain("updateItem(item.key, { hsnCode: e.target.value })");
  });

  it('is a text input — never a number input or a numeric keypad', () => {
    // Windowed on the HSN <Input> itself: the quantity and price inputs
    // further down legitimately use numeric modes, and a wider slice would
    // catch theirs and report a failure that is not about HSN at all.
    const start = form.indexOf('>HSN Code</Label>');
    // Comments are stripped first: the note beside this input names
    // inputMode="numeric" precisely to say it is not used, and matching that
    // would pass or fail on the explanation rather than on the code.
    const block = form
      .slice(start, form.indexOf('</div>', start))
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(block).toContain('value={item.hsnCode}');
    expect(block).not.toContain('type="number"');
    expect(block).not.toContain('inputMode="numeric"');
    expect(block).not.toContain('inputMode="decimal"');
  });

  it('caps length with the shared constant rather than a retyped number', () => {
    expect(form).toContain('maxLength={HSN_CODE_MAX_LENGTH}');
    expect(HSN_CODE_MAX_LENGTH).toBe(20);
  });

  it('says it is optional', () => {
    expect(form).toContain('Optional.');
  });

  it('applies no format validation of its own', () => {
    const start = form.indexOf('>HSN Code</Label>');
    const block = form.slice(start, form.indexOf('</div>', start));
    expect(block).not.toContain('pattern=');
    expect(block).not.toMatch(/\/\^\[0-9\]/);
  });
});

describe('the GST select', () => {
  it('renders with a label', () => {
    expect(form).toContain('>GST</Label>');
  });

  it('is bound to the line', () => {
    expect(form).toContain('value={item.gstRate}');
    expect(form).toContain('gstRate: value as GstRate');
  });

  it('builds its options from the shared constant, not a retyped list', () => {
    expect(form).toContain('GST_RATES.map((rate) =>');
    expect(form).toContain('GST_RATE_LABELS[rate]');
  });

  it('hardcodes no rate of its own', () => {
    const block = form.slice(form.indexOf('>GST</Label>'), form.indexOf('>Quantity</Label>'));
    for (const stray of ['3%', '6%', '9%', '10%', '15%', '20%', '25%', '30%']) {
      expect(block, stray).not.toContain(stray);
    }
    expect(block).not.toMatch(/<SelectItem value="(0|5|12|18|28|NONE)"/);
  });

  it('says the rate is not part of the total', () => {
    expect(form).toContain('Not added to the line total.');
  });
});

// ---------------------------------------------------------------------------
//  Exactly six options
// ---------------------------------------------------------------------------

describe('exactly six GST options are offered', () => {
  it('offers six and no more', () => {
    expect(GST_RATES).toHaveLength(6);
    expect(Object.keys(GST_RATE_LABELS)).toHaveLength(6);
  });

  it('offers each requested option, by label', () => {
    expect(GST_RATE_LABELS.NONE).toBe('None');
    expect(GST_RATE_LABELS['0']).toBe('0% — Exempt items');
    expect(GST_RATE_LABELS['5']).toBe('5% — Low-tax items');
    expect(GST_RATE_LABELS['12']).toBe('12% — Some goods/services');
    expect(GST_RATE_LABELS['18']).toBe('18% — Most goods/services');
    expect(GST_RATE_LABELS['28']).toBe('28% — High-tax/luxury items');
  });

  it('offers no rate outside the six', () => {
    for (const stray of ['3', '6', '9', '10', '15', '20', '25', '30']) {
      expect(GST_RATES as readonly string[]).not.toContain(stray);
    }
  });

  it('would reject a seventh option at the API boundary', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-7001',
      customerId: CUID,
      items: [{ productName: 'X', quantity: 1, price: '10.00', gstRate: '9' }],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Default state
// ---------------------------------------------------------------------------

describe('a new product line starts in the right state', () => {
  it('starts with an empty HSN and GST of NONE', () => {
    const block = form.slice(form.indexOf('const emptyItem'), form.indexOf('/**', form.indexOf('const emptyItem')));
    expect(block).toContain("hsnCode: ''");
    expect(block).toContain("gstRate: 'NONE'");
  });

  it('never defaults to a numeric zero', () => {
    const block = form.slice(form.indexOf('const emptyItem'), form.indexOf('/**', form.indexOf('const emptyItem')));
    expect(block).not.toMatch(/gstRate:\s*0/);
    expect(block).not.toMatch(/gstRate:\s*'0'/);
  });

  it('types the draft field as GstRate, so a stray value cannot be held', () => {
    expect(form).toContain('gstRate: GstRate;');
    expect(form).toContain('hsnCode: string;');
  });
});

describe('NONE is never turned into a zero', () => {
  it('sends NONE as the string NONE', () => {
    expect(form).toContain('gstRate: item.gstRate');
    expect(form).not.toMatch(/gstRate:\s*Number\(/);
    expect(form).not.toMatch(/gstRate:.*===\s*'NONE'\s*\?\s*'0'/);
    expect(form).not.toMatch(/parseInt\(item\.gstRate/);
  });

  it('keeps NONE and "0" distinct through validation', () => {
    const item = (gstRate: string) => ({
      orderId: 'SO-7002',
      customerId: CUID,
      items: [{ productName: 'X', quantity: 1, price: '10.00', gstRate }],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });

    const none = createSalesOrderSchema.safeParse(item('NONE'));
    const zero = createSalesOrderSchema.safeParse(item('0'));
    expect(none.success && none.data.items[0]!.gstRate).toBe('NONE');
    expect(zero.success && zero.data.items[0]!.gstRate).toBe('0');
    expect(none.success && none.data.items[0]!.gstRate).not.toBe('0');
  });
});

// ---------------------------------------------------------------------------
//  Per-line independence
// ---------------------------------------------------------------------------

describe('each product line owns its own HSN and GST', () => {
  it('updates one line by key, through the existing mechanism', () => {
    // updateItem patches the row whose key matches and returns the others
    // untouched, so a second line cannot be affected by editing the first.
    expect(form).toContain('const updateItem = (key: string, patch: Partial<ItemDraft>) =>');
    expect(form).toContain('list.map((i) => (i.key === key ? { ...i, ...patch } : i))');
  });

  it('renders a distinct field id per line', () => {
    expect(form).toContain('`${formId}-hsn-${item.key}`');
    expect(form).toContain('`${formId}-gst-${item.key}`');
  });

  it('gives every new line its own fresh defaults', () => {
    expect(form).toContain('setItems((list) => [...list, emptyItem(`i${nextKey.current++}`)])');
  });

  it('accepts lines carrying different values in one order', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-7003',
      customerId: CUID,
      items: [
        { productName: 'A', quantity: 1, price: '10.00', hsnCode: '7418', gstRate: '18' },
        { productName: 'B', quantity: 1, price: '10.00', hsnCode: '8306', gstRate: '5' },
        { productName: 'C', quantity: 1, price: '10.00', gstRate: 'NONE' },
      ],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.items.map((i) => i.hsnCode)).toEqual(['7418', '8306', undefined]);
    expect(parsed.data.items.map((i) => i.gstRate)).toEqual(['18', '5', 'NONE']);
  });
});

// ---------------------------------------------------------------------------
//  The picker is unchanged
// ---------------------------------------------------------------------------

describe('selecting an RS Product invents neither field', () => {
  it('patches only the catalogue product and the label', () => {
    const onChange = form.slice(form.indexOf('<RsProductPicker'), form.indexOf('aria-label={`Or type'));
    expect(onChange).toContain('rsProduct: product');
    expect(onChange).toContain('productName: product?.title');
    expect(onChange).not.toContain('hsnCode');
    expect(onChange).not.toContain('gstRate');
  });

  it('reads no HSN or GST from the catalogue row anywhere', () => {
    expect(form).not.toMatch(/product\??\.(hsn|hsnCode|gst|gstRate)/i);
    const picker = read('components/products/rs-product-picker.tsx');
    expect(picker).not.toMatch(/\bhsn\b/i);
    expect(picker).not.toMatch(/\bgst\b/i);
  });

  it('leaves the picker component itself untouched by this feature', () => {
    const picker = read('components/products/rs-product-picker.tsx');
    expect(picker).toContain('/api/proxy/rs-products');
    expect(picker).toContain('shouldFilter={false}');
  });
});

describe('the manual free-text fallback still works alongside the new fields', () => {
  it('still offers the free-text box', () => {
    expect(form).toContain('…or type a product not in the catalogue');
  });

  it('clears only the catalogue selection when typing, never HSN or GST', () => {
    expect(form).toContain('productName: e.target.value, rsProduct: null');
    expect(form).not.toContain("productName: e.target.value, rsProduct: null, hsnCode: ''");
  });

  it('validates a typed product carrying HSN and GST', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-7004',
      customerId: CUID,
      items: [
        {
          productName: 'Hand-beaten copper jug',
          quantity: 3,
          price: '900.00',
          hsnCode: '7418AB',
          gstRate: '12',
        },
      ],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  The payload
// ---------------------------------------------------------------------------

describe('the submitted payload', () => {
  const build = form.slice(form.indexOf('function buildInput'));
  const items = build.slice(build.indexOf('items:'), build.indexOf('paidAmount:'));
  const code = items
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('names every field explicitly rather than spreading the draft', () => {
    expect(code).toContain('productName:');
    expect(code).toContain('quantity:');
    expect(code).toContain('price:');
    expect(code).toContain('gstRate: item.gstRate');
    expect(code).not.toContain('...item,');
    // The picker's whole object is draft state and must not reach the API —
    // only its id travels, as rsProductId.
    expect(code).not.toContain('rsProduct:');
    expect(code).toContain('item.rsProduct.id');
  });

  it('omits an untouched HSN rather than sending an empty string', () => {
    expect(code).toContain("item.hsnCode.trim() ? { hsnCode: item.hsnCode.trim() }");
  });

  it('sends the RsProduct id as the line identity, and no legacy key', () => {
    // The chosen product's id is what the line stores. There is no second
    // identity to send it as, and no legacy productId left to confuse it with.
    expect(code).toContain('item.rsProduct ? { rsProductId: item.rsProduct.id }');
    expect(form).not.toMatch(/productId(?!.*rsProductId)/);
  });

  it('produces a payload the shared schema accepts', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-7005',
      customerId: CUID,
      items: [
        { productName: 'Brass Dinner Set', quantity: 12, price: '1250.50', gstRate: 'NONE' },
      ],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Money is untouched
// ---------------------------------------------------------------------------

describe('GST does not enter any calculation', () => {
  it('still previews the line total as quantity × price', () => {
    expect(form).toContain('lineTotal(item.price.trim(), Number(item.quantity))');
  });

  it('computes 12 × 1250.50 as 15006.00, whatever the rate', () => {
    expect(lineTotal('1250.50', 12)).toBe('15006.00');
    // Not 17707.08 — the 18% figure the form must never produce.
    expect(lineTotal('1250.50', 12)).not.toBe('17707.08');
  });

  it('never references a rate in any pricing helper call', () => {
    expect(form).not.toMatch(/lineTotal\([^)]*gst/i);
    expect(form).not.toMatch(/sumItemTotals\([^)]*gst/i);
    expect(form).not.toMatch(/gstRate[^\n]*[*+]/);
  });

  it('keeps the order total summing only quantity and price', () => {
    expect(form).toContain(
      "sumItemTotals(items.map((i) => ({ quantity: Number(i.quantity), price: i.price.trim() })))",
    );
  });

  it('does not make a line priceable on GST', () => {
    const priceable = form.slice(form.indexOf('const priceable'), form.indexOf('const lineTotalOf'));
    expect(priceable).not.toContain('gst');
    expect(priceable).not.toContain('hsn');
  });
});

// ---------------------------------------------------------------------------
//  Nothing else moved
// ---------------------------------------------------------------------------

describe('excluded surfaces were not touched', () => {
  it('leaves the order detail item list alone', () => {
    const detail = read('components/sales/sales-item-list.tsx');
    expect(detail).not.toMatch(/\bhsn/i);
    expect(detail).not.toMatch(/gstRate/);
  });

  it('leaves the change-request dialogs alone', () => {
    const dialogs = read('components/sales/change-request-dialogs.tsx');
    expect(dialogs).not.toMatch(/\bhsn/i);
    expect(dialogs).not.toMatch(/gstRate/);
  });
});
