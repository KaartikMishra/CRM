/**
 * Vendor Invoices — the frontend, as pure logic.
 *
 * Two kinds of assertion live here, and both earn their place:
 *
 *   - the display helpers, called directly. They are exported from
 *     `vendor-format.ts` precisely so this DOM-less suite can reach them.
 *   - a structural audit of the components themselves, read from the working
 *     tree. Those assertions guard rules that no unit test can reach because
 *     they are about what the code *does not* do: never calling DELETE, never
 *     offering an isActive control in the edit form, never picking a product
 *     from the legacy master. Each is a rule the brief states explicitly, and
 *     each would otherwise be enforced only by memory.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EMPTY,
  additionalNumber,
  formatQty,
  historicalRate,
  isShortReceipt,
  mappedProductsLabel,
  mappingRate,
  mappingStatusLabel,
  orDash,
  tradeBillDate,
  tradeLineTotal,
  tradeTime,
  tradesTitle,
  truncateTitle,
  vendorStatusLabel,
  vendorSubtitle,
  whatsappNumber,
} from '@/components/vendor-invoices/vendor-format';
import {
  buildHref,
  decodeStack,
  encodeStack,
} from '@/components/vendor-invoices/pagination-controls';
import {
  MAPPING_PAGE_LIMIT,
  TRADE_PAGE_LIMIT,
  VENDOR_PAGE_LIMIT,
} from '@/lib/vendor-invoice-api';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const components = 'components/vendor-invoices';
const actions = 'app/(app)/vendor-invoices/actions.ts';

// ---------------------------------------------------------------------------
//  Display helpers
// ---------------------------------------------------------------------------

describe('absent values read as a dash, never as blank or "null"', () => {
  it('renders null, undefined and whitespace identically', () => {
    expect(orDash(null)).toBe(EMPTY);
    expect(orDash(undefined)).toBe(EMPTY);
    expect(orDash('')).toBe(EMPTY);
    expect(orDash('   ')).toBe(EMPTY);
  });

  it('keeps a real value, trimmed', () => {
    expect(orDash('  Moradabad  ')).toBe('Moradabad');
  });

  it('applies to both phone numbers', () => {
    expect(whatsappNumber({ phone: null })).toBe(EMPTY);
    expect(additionalNumber({ altPhone: null })).toBe(EMPTY);
    expect(whatsappNumber({ phone: '+91 98765 43210' })).toBe('+91 98765 43210');
    expect(additionalNumber({ altPhone: '+91 98765 43211' })).toBe('+91 98765 43211');
  });
});

describe('vendor status', () => {
  it('says Active or Archived, never Deleted', () => {
    expect(vendorStatusLabel({ isActive: true })).toBe('Active');
    expect(vendorStatusLabel({ isActive: false })).toBe('Archived');
  });
});

describe('the mapped-product count', () => {
  it('reads naturally at zero, one and many', () => {
    expect(mappedProductsLabel(0)).toBe('No products mapped');
    expect(mappedProductsLabel(1)).toBe('1 product mapped');
    expect(mappedProductsLabel(7)).toBe('7 products mapped');
  });
});

describe('the vendor subtitle', () => {
  it('joins company and city when both are present', () => {
    expect(vendorSubtitle({ companyName: 'Devansh Brass Works', city: 'Moradabad' })).toBe(
      'Devansh Brass Works · Moradabad',
    );
  });

  it('shows whichever one exists', () => {
    expect(vendorSubtitle({ companyName: 'Devansh Brass Works', city: null })).toBe(
      'Devansh Brass Works',
    );
    expect(vendorSubtitle({ companyName: null, city: 'Moradabad' })).toBe('Moradabad');
  });

  it('is null when there is nothing to say, so no empty line renders', () => {
    expect(vendorSubtitle({ companyName: null, city: null })).toBeNull();
    expect(vendorSubtitle({ companyName: '  ', city: '' })).toBeNull();
  });
});

describe('the drawer title', () => {
  it('names the vendor, exactly as the brief specifies', () => {
    expect(tradesTitle({ name: 'Devansh Brass' })).toBe('Trades with Devansh Brass');
  });
});

describe('long titles are trimmed visibly', () => {
  it('leaves a short title alone', () => {
    expect(truncateTitle('Brass Urli')).toBe('Brass Urli');
  });

  it('marks a trimmed title with an ellipsis rather than cutting silently', () => {
    const long = 'x'.repeat(200);
    const out = truncateTitle(long, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never returns more characters than asked for', () => {
    for (const length of [0, 1, 5, 69, 70, 71, 300]) {
      expect(truncateTitle('y'.repeat(length)).length).toBeLessThanOrEqual(70);
    }
  });
});

// ---------------------------------------------------------------------------
//  Trade history
// ---------------------------------------------------------------------------

describe('the trade time column', () => {
  /**
   * The brief is explicit: show a dash if the time is unavailable, and never
   * invent one. `recordedAt` is a real timestamp, so the usual path is a real
   * time — these cases cover what happens when it is not.
   */
  it('formats a real timestamp', () => {
    const out = tradeTime({ recordedAt: '2026-09-16T09:30:00.000Z' });
    expect(out).not.toBe(EMPTY);
    expect(out).toMatch(/\d/);
  });

  it('reads as a dash when the timestamp is missing', () => {
    expect(tradeTime({ recordedAt: '' })).toBe(EMPTY);
  });

  it('reads as a dash rather than "Invalid Date" when it is unparseable', () => {
    expect(tradeTime({ recordedAt: 'not-a-date' })).toBe(EMPTY);
  });

  it('renders in Asia/Kolkata, like every other time in the CRM', () => {
    // 09:30 UTC is 15:00 IST. A UTC render would say 09:30.
    expect(tradeTime({ recordedAt: '2026-09-16T09:30:00.000Z' })).toContain('03:00');
  });
});

describe('the bill date', () => {
  it('formats the bill date, not the recorded date', () => {
    // A bill dated the 10th, typed up on the 12th: both facts are true and the
    // table shows them in different columns.
    const trade = { billDate: '2026-09-10T00:00:00.000Z' };
    expect(tradeBillDate(trade)).toContain('2026');
    expect(tradeBillDate(trade)).toContain('Sep');
  });
});

describe('money is formatted, never recomputed', () => {
  it('renders the historical rate exactly as the backend recorded it', () => {
    expect(historicalRate({ rate: '1250.00' })).toBe('₹1,250.00');
  });

  it('renders the backend-derived line total, with Indian digit grouping', () => {
    expect(tradeLineTotal({ lineTotal: '125000.00' })).toBe('₹1,25,000.00');
  });

  it('renders the mapping rate with the same formatter, different source', () => {
    expect(mappingRate({ currentRate: '1400.50' })).toBe('₹1,400.50');
  });

  it('keeps paise rather than rounding them away', () => {
    expect(historicalRate({ rate: '99.99' })).toBe('₹99.99');
    expect(tradeLineTotal({ lineTotal: '0.01' })).toBe('₹0.01');
  });
});

describe('quantities', () => {
  it('shows zero as a real answer rather than a dash', () => {
    expect(formatQty(0)).toBe('0');
  });

  it('groups large quantities', () => {
    expect(formatQty(12345)).toBe('12,345');
  });
});

describe('a short delivery is surfaced', () => {
  it('flags receiving less than was ordered', () => {
    expect(isShortReceipt({ orderedQty: 100, receivedQty: 80 })).toBe(true);
  });

  it('does not flag a complete or over delivery', () => {
    expect(isShortReceipt({ orderedQty: 100, receivedQty: 100 })).toBe(false);
    expect(isShortReceipt({ orderedQty: 100, receivedQty: 120 })).toBe(false);
  });
});

describe('mapping status', () => {
  it('says Active or Archived', () => {
    expect(mappingStatusLabel({ isActive: true })).toBe('Active');
    expect(mappingStatusLabel({ isActive: false })).toBe('Archived');
  });
});

// ---------------------------------------------------------------------------
//  Pagination
// ---------------------------------------------------------------------------

describe('page sizes', () => {
  it('never exceeds what the backend accepts', () => {
    for (const limit of [VENDOR_PAGE_LIMIT, TRADE_PAGE_LIMIT, MAPPING_PAGE_LIMIT]) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(100);
    }
  });
});

describe('the cursor stack', () => {
  it('round-trips through the URL', () => {
    const stack = ['clx0000000000000000000001', 'clx0000000000000000000002'];
    expect(decodeStack(encodeStack(stack))).toEqual(stack);
  });

  it('treats an absent value as the first page', () => {
    expect(decodeStack(undefined)).toEqual([]);
    expect(decodeStack('')).toEqual([]);
  });

  it('ignores empty segments rather than producing blank cursors', () => {
    expect(decodeStack('a,,b,')).toEqual(['a', 'b']);
  });

  it('counts pages from the stack depth, and invents no total', () => {
    expect(decodeStack(undefined).length + 1).toBe(1);
    expect(decodeStack('a,b,c').length + 1).toBe(4);
  });
});

describe('pagination links', () => {
  const filters = { q: 'brass', isActive: 'true' };

  it('carries the filters forward, so a filtered view stays filtered', () => {
    const href = buildHref('/vendor-invoices', filters, ['c1'], 'cursor', 'pages');
    expect(href).toContain('q=brass');
    expect(href).toContain('isActive=true');
  });

  it('writes both the cursor and the stack', () => {
    const href = buildHref('/vendor-invoices', filters, ['c1', 'c2'], 'cursor', 'pages');
    expect(href).toContain('cursor=c2');
    expect(href).toContain('pages=c1%2Cc2');
  });

  it('omits cursor state entirely on the first page', () => {
    const href = buildHref('/vendor-invoices', filters, [], 'cursor', 'pages');
    expect(href).not.toContain('cursor=');
    expect(href).not.toContain('pages=');
  });

  it('drops empty filters so the address bar stays readable', () => {
    const href = buildHref('/vendor-invoices', { q: '', isActive: undefined }, [], 'c', 'p');
    expect(href).toBe('/vendor-invoices');
  });

  it('uses separate keys per list, so three lists page independently', () => {
    // The drawer paginates trades and mappings on the same route as the vendor
    // list. Sharing one `cursor` key would make paging one list reset another.
    const trades = buildHref('/vendor-invoices', {}, ['t1'], 'tradeCursor', 'tradePages');
    const maps = buildHref('/vendor-invoices', {}, ['m1'], 'mapCursor', 'mapPages');
    expect(trades).toContain('tradeCursor=t1');
    expect(maps).toContain('mapCursor=m1');
    expect(trades).not.toContain('mapCursor');
    expect(maps).not.toContain('tradeCursor');
  });

  it('pops the stack to go back, rather than asking for a prevCursor', () => {
    const stack = ['c1', 'c2', 'c3'];
    const previous = buildHref('/vendor-invoices', {}, stack.slice(0, -1), 'cursor', 'pages');
    expect(previous).toContain('cursor=c2');
    expect(previous).toContain('pages=c1%2Cc2');
  });

  it('returns to page one when the stack empties', () => {
    const previous = buildHref('/vendor-invoices', {}, [], 'cursor', 'pages');
    expect(previous).toBe('/vendor-invoices');
  });
});

// ---------------------------------------------------------------------------
//  Structural rules
// ---------------------------------------------------------------------------

describe('archiving never deletes', () => {
  it('posts to /archive and declares no DELETE anywhere in the module', () => {
    const source = read(actions);
    expect(source).toContain('/archive');
    expect(source).not.toContain("method: 'DELETE'");
    expect(source).not.toContain('method: "DELETE"');
  });

  it('calls archiving "Archive", never "Delete", in the confirmations', () => {
    for (const file of ['vendor-actions.tsx', 'mapping-actions.tsx']) {
      const source = read(`${components}/${file}`);
      expect(source, file).toContain('Archive');
      expect(source, file).not.toMatch(/Delete (vendor|mapping)/);
    }
  });

  it('explains what archiving preserves rather than asking "are you sure?"', () => {
    const source = read(`${components}/vendor-actions.tsx`);
    expect(source).toContain('not deleted');
    expect(source).toContain('preserved');
    expect(source).not.toContain('Are you sure');
  });
});

describe('the edit form cannot archive', () => {
  /**
   * The brief is explicit that `isActive` must not appear in the normal edit
   * form: archiving sits behind DELETE, and a checkbox in an EDIT form would
   * let one permission do the other's job. The backend strips the field, so a
   * control for it would also be a lie.
   */
  it('offers no isActive control', () => {
    const source = read(`${components}/vendor-form-dialog.tsx`);
    expect(source).not.toMatch(/isActive:\s*(true|false)/);
    expect(source).not.toContain('Checkbox');
  });

  it('types the update action so isActive cannot be passed', () => {
    const source = read(actions);
    expect(source).toContain("Omit<UpdateVendorInput, 'isActive'>");
  });
});

describe('clearing a field never sends a value the schema rejects', () => {
  /**
   * `phone`, `altPhone` and `email` validate their format, so an empty string
   * fails with "Enter a valid phone number" — a confusing error on a box
   * somebody deliberately emptied. The form omits them from the clearing path
   * and says so, rather than showing that error.
   */
  const form = read(`${components}/vendor-form-dialog.tsx`);

  it('clears only the fields whose schema accepts an empty string', () => {
    const clearable = form.match(/const CLEARABLE = \[(.*?)\]/s)?.[1] ?? '';
    for (const field of ['companyName', 'address', 'city', 'contactPerson']) {
      expect(clearable, field).toContain(field);
    }
    for (const field of ['phone', 'altPhone', 'email']) {
      expect(clearable, field).not.toContain(field);
    }
  });

  it('tells the user what an emptied number or address will do', () => {
    expect(form).toContain('left unchanged');
  });
});

describe('the product picker uses RsProduct, never the legacy master', () => {
  const picker = read(`${components}/rs-product-picker.tsx`);

  it('searches the RS Products endpoint', () => {
    expect(picker).toContain('/api/proxy/rs-products');
  });

  it('never calls the legacy product or vendor-product endpoints', () => {
    expect(picker).not.toContain('/api/proxy/products');
    expect(picker).not.toContain('/api/proxy/procurement/products');
  });

  it('sends the id as rsProductId when the mapping is created', () => {
    const dialogs = read(`${components}/mapping-dialogs.tsx`);
    expect(dialogs).toContain('rsProductId');
    expect(dialogs).not.toMatch(/\bproductId:/);
  });

  it('is a searchable combobox, not a list of every product', () => {
    expect(picker).toContain('role="combobox"');
    expect(picker).toContain('CommandInput');
  });

  it('asks the server for a bounded page rather than the whole catalogue', () => {
    expect(picker).toContain('PICKER_LIMIT');
    expect(picker).toMatch(/PICKER_LIMIT\s*=\s*20/);
  });

  it('debounces, so typing does not fire a request per keystroke', () => {
    expect(picker).toContain('DEBOUNCE_MS');
    expect(picker).toContain('setTimeout');
    expect(picker).toContain('clearTimeout');
    expect(picker).toContain('AbortController');
  });
});

describe('the two rates stay distinct', () => {
  it('labels the mapping rate as current wherever it appears', () => {
    expect(read(`${components}/mapping-table.tsx`)).toContain('Current rate');
    expect(read(`${components}/mapping-dialogs.tsx`)).toContain('Current rate');
  });

  it('labels the historical rate as billed, so the columns cannot be confused', () => {
    expect(read(`${components}/trade-table.tsx`)).toContain('Rate (billed)');
  });

  it('offers no way to write a historical rate', () => {
    // Trade history is Procurement's records, read live. There is no action for
    // it, and no schema field that would accept one.
    const source = read(actions);
    expect(source).not.toContain('PurchaseBillItem');
    expect(source).not.toMatch(/updateTrade|editTrade|updateBillItem/);
  });

  it('uses the backend-provided lineTotal instead of multiplying in the UI', () => {
    const table = read(`${components}/trade-table.tsx`);
    expect(table).toContain('tradeLineTotal');
    // No arithmetic on a rate anywhere in the table.
    expect(table).not.toMatch(/rate\s*\*/);
    expect(table).not.toMatch(/Number\(.*rate/);
  });
});

describe('search is debounced', () => {
  it('waits for a pause rather than firing per keystroke', () => {
    const filters = read(`${components}/vendor-filters.tsx`);
    expect(filters).toContain('DEBOUNCE_MS');
    expect(filters).toContain('setTimeout');
    expect(filters).toContain('clearTimeout');
  });

  it('drops every cursor when a filter changes', () => {
    const filters = read(`${components}/vendor-filters.tsx`);
    for (const key of ['cursor', 'pages', 'tradeCursor', 'tradePages', 'mapCursor', 'mapPages']) {
      expect(filters, key).toContain(`'${key}'`);
    }
  });
});

describe('every mutation disables its submit while pending', () => {
  it('guards each form and confirmation', () => {
    for (const file of [
      'vendor-form-dialog.tsx',
      'mapping-dialogs.tsx',
      'vendor-actions.tsx',
      'mapping-actions.tsx',
    ]) {
      const source = read(`${components}/${file}`);
      expect(source, file).toContain('disabled={pending}');
      expect(source, file).toContain('useTransition');
    }
  });
});

describe('no business data is hardcoded', () => {
  it('ships no mock vendors, products or rates', () => {
    for (const file of [
      'vendor-table.tsx',
      'trade-table.tsx',
      'mapping-table.tsx',
      'vendor-drawer.tsx',
    ]) {
      const source = read(`${components}/${file}`);
      // A literal array of rows would mean the table renders something the API
      // never returned.
      expect(source, file).not.toMatch(/const\s+(MOCK|SAMPLE|DUMMY|FAKE)/i);
      expect(source, file).not.toMatch(/placeholderData|sampleVendors|mockTrades/);
    }
  });
});

describe('images are reused, never uploaded', () => {
  it('renders existing image references and offers no upload', () => {
    for (const file of ['trade-table.tsx', 'mapping-table.tsx', 'rs-product-picker.tsx']) {
      const source = read(`${components}/${file}`);
      expect(source, file).not.toContain('cloudinary');
      expect(source, file).not.toContain('/api/proxy/uploads');
      expect(source, file).not.toContain('<input type="file"');
    }
  });

  it('falls back to a placeholder rather than a broken image', () => {
    for (const file of ['trade-table.tsx', 'mapping-table.tsx']) {
      expect(read(`${components}/${file}`), file).toContain('ImageOff');
    }
  });
});

describe('tables may scroll sideways, the page may not', () => {
  it('wraps each table in its own overflow container', () => {
    for (const file of ['vendor-table.tsx', 'trade-table.tsx', 'mapping-table.tsx']) {
      expect(read(`${components}/${file}`), file).toContain('overflow-x-auto');
    }
  });
});

describe('RBAC gating uses the existing utilities', () => {
  const page = read('app/(app)/vendor-invoices/page.tsx');

  it('checks the module with requireModule and renders a verdict, never a redirect', () => {
    expect(page).toContain("requireModule('VENDOR_INVOICE')");
    expect(page).toContain('NoModuleAccess');
    expect(page).not.toContain('redirect(');
  });

  it('gates each action on its own permission', () => {
    expect(page).toContain("can(access.user, 'VENDOR_INVOICE', 'CREATE')");
    expect(page).toContain("can(access.user, 'VENDOR_INVOICE', 'EDIT')");
    expect(page).toContain("can(access.user, 'VENDOR_INVOICE', 'DELETE')");
  });

  it('introduces no second permission module', () => {
    expect(page).not.toContain('VENDOR_INVOICES');
    expect(page).not.toMatch(/role\s*===\s*'ADMIN'/);
  });
});

describe('the session token never reaches the browser', () => {
  it('mutates through server actions, never a direct backend call', () => {
    const source = read(actions);
    expect(source.startsWith("'use server';")).toBe(true);
    expect(source).toContain('apiFetch');
    expect(source).not.toContain('Authorization');
  });

  it('reads through the server-only API client', () => {
    const client = read('lib/vendor-invoice-api.ts');
    expect(client).toContain("from './api-server'");
    expect(client).not.toContain('Authorization');
  });

  it('routes the one client-side read through the proxy', () => {
    const picker = read(`${components}/rs-product-picker.tsx`);
    expect(picker).toContain('/api/proxy/');
    expect(picker).not.toContain('BACKEND_URL');
    expect(picker).not.toContain('Authorization');
  });
});

describe('loading, error and empty states exist everywhere', () => {
  it('gives the vendor list all three', () => {
    const page = read('app/(app)/vendor-invoices/page.tsx');
    expect(page).toContain('ErrorMessage');
    expect(page).toContain('EmptyState');
    expect(page).toContain('Suspense');
    expect(page).toContain('Skeleton');
  });

  it('gives both drawer sections their own error and empty states', () => {
    const drawer = read(`${components}/vendor-drawer.tsx`);
    expect(drawer.match(/ErrorMessage/g)?.length).toBeGreaterThanOrEqual(3);
    expect(drawer.match(/EmptyState/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('tells the picker apart from an empty catalogue when access is refused', () => {
    const picker = read(`${components}/rs-product-picker.tsx`);
    expect(picker).toContain('denied');
    expect(picker).toContain('403');
  });
});
