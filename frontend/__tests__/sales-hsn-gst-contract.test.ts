/**
 * HSN and GST on a sales line — the shared contract.
 *
 * Pure validation, no database and no network. These run against the same
 * schema the API validates with, so a rule proved here is the rule the backend
 * enforces.
 *
 * The rule most worth pinning: `NONE`, `'0'` and an absent value are three
 * different answers. "No GST decision recorded", "no GST applies" and "exempt,
 * at zero percent" are distinct statements about a document, and merging any
 * two of them would misreport a tax position.
 */

import { describe, expect, it } from 'vitest';
import {
  GST_RATES,
  GST_RATE_LABELS,
  HSN_CODE_MAX_LENGTH,
  createSalesOrderSchema,
  lineTotal,
  sumItemTotals,
  type GstRate,
} from '@rs/shared';

const CUID = 'clx0000000000000000000000';

/** A valid order carrying one line, with the line fields under test. */
const order = (line: Record<string, unknown>) => ({
  orderId: 'SO-9001',
  customerId: CUID,
  items: [{ productName: 'Brass Dinner Set', quantity: 2, price: '1250.00', ...line }],
  paidAmount: '0',
  orderDate: '2026-09-18',
  toBeDispatchedBy: '2026-09-20',
});

const parse = (line: Record<string, unknown>) => createSalesOrderSchema.safeParse(order(line));
const firstItem = (line: Record<string, unknown>) => {
  const result = parse(line);
  if (!result.success) throw new Error('expected the payload to validate');
  return result.data.items[0]!;
};

// ---------------------------------------------------------------------------
//  The six GST options
// ---------------------------------------------------------------------------

describe('GST_RATES is exactly the six requested options', () => {
  it('holds precisely these values, in this order', () => {
    expect([...GST_RATES]).toEqual(['NONE', '0', '5', '12', '18', '28']);
  });

  it('has no seventh option', () => {
    expect(GST_RATES).toHaveLength(6);
  });

  it('labels every value, and only those values', () => {
    expect(Object.keys(GST_RATE_LABELS)).toHaveLength(6);
    for (const rate of GST_RATES) {
      expect(GST_RATE_LABELS[rate], rate).toBeTruthy();
    }
  });

  it('uses the exact labels asked for', () => {
    expect(GST_RATE_LABELS.NONE).toBe('None');
    expect(GST_RATE_LABELS['0']).toBe('0% — Exempt items');
    expect(GST_RATE_LABELS['5']).toBe('5% — Low-tax items');
    expect(GST_RATE_LABELS['12']).toBe('12% — Some goods/services');
    expect(GST_RATE_LABELS['18']).toBe('18% — Most goods/services');
    expect(GST_RATE_LABELS['28']).toBe('28% — High-tax/luxury items');
  });

  it('keeps every value a string, so none is ever arithmetic', () => {
    for (const rate of GST_RATES) {
      expect(typeof rate).toBe('string');
    }
  });
});

describe('GST validation', () => {
  it('accepts each of the six', () => {
    for (const rate of GST_RATES) {
      expect(parse({ gstRate: rate }).success, rate).toBe(true);
    }
  });

  it('accepts an omitted rate', () => {
    expect(parse({}).success).toBe(true);
    expect(firstItem({}).gstRate).toBeUndefined();
  });

  it('rejects anything outside the six', () => {
    for (const bad of ['9', '3', '0.5', '18%', 'none', 'None', 'NIL', 'EXEMPT', '', '100', '-5']) {
      expect(parse({ gstRate: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects a numeric rate, so 18 cannot pass for "18"', () => {
    expect(parse({ gstRate: 18 }).success).toBe(false);
    expect(parse({ gstRate: 0 }).success).toBe(false);
  });

  it('rejects null — omit the field to mean "not recorded"', () => {
    expect(parse({ gstRate: null }).success).toBe(false);
  });
});

describe('NONE, "0" and absent are three distinct answers', () => {
  it('passes NONE through as NONE', () => {
    expect(firstItem({ gstRate: 'NONE' }).gstRate).toBe('NONE');
  });

  it('passes "0" through as "0"', () => {
    expect(firstItem({ gstRate: '0' }).gstRate).toBe('0');
  });

  it('never converts NONE into a zero of any kind', () => {
    const value = firstItem({ gstRate: 'NONE' }).gstRate;
    expect(value).not.toBe('0');
    expect(value).not.toBe(0);
    expect(Number(value)).toBeNaN();
  });

  it('distinguishes an omitted rate from both', () => {
    expect(firstItem({}).gstRate).toBeUndefined();
    expect(firstItem({ gstRate: 'NONE' }).gstRate).not.toBeUndefined();
    expect(firstItem({ gstRate: '0' }).gstRate).not.toBeUndefined();
  });

  it('keeps all three separable in one order', () => {
    const result = createSalesOrderSchema.safeParse({
      orderId: 'SO-9002',
      customerId: CUID,
      items: [
        { productName: 'A', quantity: 1, price: '10.00', gstRate: 'NONE' },
        { productName: 'B', quantity: 1, price: '10.00', gstRate: '0' },
        { productName: 'C', quantity: 1, price: '10.00' },
      ],
      paidAmount: '0',
      orderDate: '2026-09-18',
      toBeDispatchedBy: '2026-09-20',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items.map((i) => i.gstRate)).toEqual(['NONE', '0', undefined]);
  });
});

// ---------------------------------------------------------------------------
//  HSN
// ---------------------------------------------------------------------------

describe('HSN code validation', () => {
  it('is optional', () => {
    expect(parse({}).success).toBe(true);
    expect(firstItem({}).hsnCode).toBeUndefined();
  });

  it('accepts a 4-, 6- and 8-digit code as text', () => {
    for (const code of ['7418', '741810', '74181010']) {
      expect(firstItem({ hsnCode: code }).hsnCode).toBe(code);
    }
  });

  it('accepts an alphanumeric code', () => {
    expect(firstItem({ hsnCode: '7418AB' }).hsnCode).toBe('7418AB');
  });

  it('preserves leading zeros — the reason the field is text', () => {
    expect(firstItem({ hsnCode: '00741810' }).hsnCode).toBe('00741810');
  });

  it('never coerces to a number', () => {
    const value = firstItem({ hsnCode: '7418' }).hsnCode;
    expect(typeof value).toBe('string');
    expect(parse({ hsnCode: 7418 }).success).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(firstItem({ hsnCode: '  7418  ' }).hsnCode).toBe('7418');
  });

  it('accepts a code at the limit and rejects one past it', () => {
    expect(HSN_CODE_MAX_LENGTH).toBe(20);
    expect(parse({ hsnCode: '1'.repeat(HSN_CODE_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ hsnCode: '1'.repeat(HSN_CODE_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('imposes no format pattern, so an unusual code is not rejected', () => {
    // Deliberately permissive: no HSN business rule was invented.
    for (const code of ['7418.10', '7418-10', '7418 10', 'HSN7418']) {
      expect(parse({ hsnCode: code }).success, code).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
//  Money is not touched
// ---------------------------------------------------------------------------

describe('neither field enters any calculation', () => {
  it('leaves lineTotal as quantity × price', () => {
    expect(lineTotal('1250.50', 12)).toBe('15006.00');
  });

  it('sums line totals with no tax term', () => {
    expect(
      sumItemTotals([
        { quantity: 2, price: '1250.00' },
        { quantity: 3, price: '99.99' },
      ]),
    ).toBe('2799.97');
  });

  it('takes no GST or HSN argument in either helper', () => {
    // If a tax term were ever added, these signatures would have to change —
    // which is what makes this assertion worth keeping.
    expect(lineTotal.length).toBe(2);
    expect(sumItemTotals.length).toBe(1);
  });

  it('accepts the same order total regardless of the rate chosen', () => {
    const totals = new Set<string>();
    for (const rate of GST_RATES) {
      const item = firstItem({ gstRate: rate });
      totals.add(lineTotal(item.price, item.quantity));
    }
    expect(totals.size).toBe(1);
    expect([...totals][0]).toBe('2500.00');
  });
});

// ---------------------------------------------------------------------------
//  Existing behaviour
// ---------------------------------------------------------------------------

describe('existing Sales rules still hold with the new fields present', () => {
  it('still requires a product name', () => {
    expect(parse({ productName: '   ', gstRate: '18' }).success).toBe(false);
  });

  it('still rejects a non-positive price', () => {
    expect(parse({ price: '0.00', gstRate: '18' }).success).toBe(false);
  });

  it('still rejects a zero quantity', () => {
    expect(parse({ quantity: 0, hsnCode: '7418' }).success).toBe(false);
  });

  it('still leaves productId absent unless supplied', () => {
    expect(firstItem({ hsnCode: '7418', gstRate: '18' }).productId).toBeUndefined();
  });

  it('still rejects a non-cuid productId', () => {
    expect(parse({ productId: 'not-a-cuid', gstRate: '18' }).success).toBe(false);
  });

  it('validates an order that uses none of the new fields, exactly as before', () => {
    expect(parse({}).success).toBe(true);
  });
});

describe('the GstRate type matches the constant', () => {
  it('accepts each member where a GstRate is expected', () => {
    const rates: GstRate[] = ['NONE', '0', '5', '12', '18', '28'];
    expect(rates).toEqual([...GST_RATES]);
  });
});
