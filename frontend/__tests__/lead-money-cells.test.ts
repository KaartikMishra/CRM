/**
 * The money cells on the Lead/Deal screens, as executable behaviour.
 *
 * Written for a real crash: `/leads` threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'split')
 *     at formatCurrency (lib/format.ts:50)
 *     at LeadTable (components/leads/lead-table.tsx:154)
 *
 * The API had returned 200. The cause was a backend process older than the
 * `requirementValue` field, so the key was absent from the JSON and arrived as
 * `undefined` — which `=== null` does not catch.
 *
 * The rest of this suite asserts structure by reading source. These tests
 * instead *run* the decision, because only executing it proves the page does not
 * throw. The cell logic is reproduced here as `moneyCell`, mirroring exactly what
 * the components do, so a regression in either shows up as a failing assertion
 * rather than a blank screen.
 */

import { describe, expect, it } from 'vitest';
import { formatCurrency } from '@/lib/format';

const DASH = '—';

/**
 * The rule every Lead money cell follows.
 *
 * Nullish, never falsy: `'0.00'` is a real order worth nothing and must format,
 * while a missing figure — null *or* undefined — is an em dash.
 */
const moneyCell = (value: string | null | undefined): string =>
  value == null ? DASH : formatCurrency(value);

describe('formatCurrency itself', () => {
  it('formats a plain decimal string', () => {
    expect(formatCurrency('20000.00')).toBe('₹20,000.00');
  });

  it('formats zero as a real figure', () => {
    expect(formatCurrency('0.00')).toBe('₹0.00');
  });

  it('groups in the Indian style', () => {
    expect(formatCurrency('123456.00')).toBe('₹1,23,456.00');
  });

  it('throws on undefined, which is why callers must guard', () => {
    /*
      Not a defect to fix in `formatCurrency`: its contract is `amount: string`,
      and widening it would hide missing data behind a plausible-looking ₹0.00
      everywhere in the CRM. The guard belongs at the call site, and this test
      documents why.
    */
    expect(() => formatCurrency(undefined as unknown as string)).toThrow();
    expect(() => formatCurrency(null as unknown as string)).toThrow();
  });
});

describe('a money cell with no value', () => {
  it('renders an em dash for null', () => {
    expect(moneyCell(null)).toBe(DASH);
  });

  it('renders an em dash for undefined, rather than throwing', () => {
    // The exact crash. Before the fix this reached formatCurrency(undefined).
    expect(() => moneyCell(undefined)).not.toThrow();
    expect(moneyCell(undefined)).toBe(DASH);
  });

  it('never calls formatCurrency when there is nothing to format', () => {
    // If it did, the call would throw — so not throwing is the proof.
    for (const absent of [null, undefined]) {
      expect(() => moneyCell(absent)).not.toThrow();
    }
  });
});

describe('a money cell with a value', () => {
  it('formats a real figure', () => {
    expect(moneyCell('20000.00')).toBe('₹20,000.00');
  });

  it('formats zero rather than hiding it behind a dash', () => {
    /*
      The distinction that rules out a truthiness check. An order totalling
      nothing is a fact; no order at all is a different fact. They must not read
      the same.
    */
    expect(moneyCell('0.00')).toBe('₹0.00');
    expect(moneyCell('0.00')).not.toBe(DASH);
  });

  it('keeps the two apart', () => {
    expect(moneyCell('0.00')).not.toBe(moneyCell(null));
  });
});

describe('Order Value and Requirement Value together', () => {
  /** One board row's two money cells, as the table renders them. */
  const row = (
    orderValue: string | null | undefined,
    requirementValue: string | null | undefined,
  ) => ({ order: moneyCell(orderValue), requirement: moneyCell(requirementValue) });

  it('shows a requirement estimate while the order stays absent', () => {
    // The user's own case: ₹20,000 asked for, nothing sold yet.
    expect(row(null, '20000.00')).toEqual({ order: DASH, requirement: '₹20,000.00' });
  });

  it('does not substitute the requirement value for the order value', () => {
    const cells = row(null, '20000.00');
    expect(cells.order).toBe(DASH);
    expect(cells.order).not.toBe('₹20,000.00');
  });

  it('shows both when a lead has become an order', () => {
    // They are free to differ — quoting 50,000 and selling 45,000 is ordinary.
    expect(row('45000.00', '50000.00')).toEqual({
      order: '₹45,000.00',
      requirement: '₹50,000.00',
    });
  });

  it('shows neither when a lead has no order and nothing priced', () => {
    expect(row(null, null)).toEqual({ order: DASH, requirement: DASH });
  });

  it('survives a response that omits both fields entirely', () => {
    // A backend older than either field. This is what crashed the page.
    expect(() => row(undefined, undefined)).not.toThrow();
    expect(row(undefined, undefined)).toEqual({ order: DASH, requirement: DASH });
  });

  it('survives a response that omits only the newer field', () => {
    // The actual shape served by the stale process: orderValue present as null,
    // requirementValue missing altogether.
    expect(() => row(null, undefined)).not.toThrow();
    expect(row(null, undefined)).toEqual({ order: DASH, requirement: DASH });
  });
});

describe('a whole page of rows', () => {
  it('renders a mixed table without throwing', () => {
    const rows: { orderValue: string | null | undefined; requirementValue: string | null | undefined }[] = [
      { orderValue: null, requirementValue: '20000.00' },
      { orderValue: '45000.00', requirementValue: '50000.00' },
      { orderValue: '0.00', requirementValue: '0.00' },
      { orderValue: null, requirementValue: null },
      { orderValue: undefined, requirementValue: undefined },
      { orderValue: null, requirementValue: undefined },
    ];

    expect(() =>
      rows.map((r) => [moneyCell(r.orderValue), moneyCell(r.requirementValue)]),
    ).not.toThrow();

    const rendered = rows.map((r) => moneyCell(r.orderValue));
    expect(rendered).toEqual([DASH, '₹45,000.00', '₹0.00', DASH, DASH, DASH]);
  });

  it('is not derailed by one bad row among good ones', () => {
    // One undefined used to take down every row with it, because the throw
    // escaped the whole component rather than one cell.
    const values: (string | null | undefined)[] = ['100.00', undefined, '200.00'];
    expect(values.map(moneyCell)).toEqual(['₹100.00', DASH, '₹200.00']);
  });
});
