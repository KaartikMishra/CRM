/**
 * The Sales product picker, as pure logic and structure.
 *
 * The rule this suite exists to protect is a single line that is easy to break
 * and expensive to get wrong: an RsProduct id must never be written to
 * `SalesOrderItem.productId`. That column is a foreign key to the *legacy*
 * Product master, and the two are different entities — a catalogue id there
 * would either violate the constraint or silently mean the wrong product.
 *
 * There is no DOM in this suite, so component behaviour is asserted
 * structurally, by reading the working tree. That is the right tool for rules
 * about what the code must *not* do.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSalesOrderSchema, lineTotal, sumItemTotals } from '@rs/shared';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const picker = read('components/products/rs-product-picker.tsx');
const form = read('components/sales/create-sales-order-form.tsx');
const page = read('app/(app)/sales/new/page.tsx');

const CUID = 'clx0000000000000000000000';

// ---------------------------------------------------------------------------
//  The rule that matters most
// ---------------------------------------------------------------------------

describe('an RsProduct id never becomes a SalesOrderItem.productId', () => {
  it('never assigns the picked product id to productId', () => {
    expect(form).not.toMatch(/productId:\s*(product|item\.rsProduct)\??\.id/);
    expect(form).not.toMatch(/productId:\s*selected\??\.id/);
  });

  it('copies only the title onto the line when a product is picked', () => {
    expect(form).toContain('productName: product?.title');
  });

  it('keeps the catalogue selection in a frontend-only field', () => {
    // `rsProduct` is draft state. If it ever appeared in the submitted payload
    // the API would reject it, or worse, a later edit would start sending it.
    expect(form).toContain('rsProduct: PickedProduct | null');
  });

  it('builds the payload by naming fields, so draft state cannot leak', () => {
    const build = form.slice(form.indexOf('function buildInput'));
    const items = build.slice(build.indexOf('items:'), build.indexOf('paidAmount:'));
    // Comments are stripped first: the prose there explains why rsProduct is
    // excluded, and matching that would make this assertion pass on the
    // explanation rather than on the code.
    const code = items
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(code).toContain('productName:');
    expect(code).not.toContain('rsProduct');
    // productId is still forwarded only when the draft already holds one.
    expect(code).toContain('item.productId ? { productId: item.productId }');
  });

  it('a line built from a catalogue pick validates with no productId', () => {
    // What the form actually submits after picking: a name, no id.
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-1001',
      customerId: CUID,
      items: [{ productName: 'Brass Dinner Set', quantity: 2, price: '1250.00' }],
      paidAmount: '0',
      orderDate: '2026-09-17',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items[0]!.productId).toBeUndefined();
  });

  it('rejects a non-cuid in productId, so a stray value cannot slip through', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-1002',
      customerId: CUID,
      items: [{ productName: 'X', productId: 'not-a-cuid', quantity: 1, price: '10.00' }],
      paidAmount: '0',
      orderDate: '2026-09-17',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(false);
  });

  it('populates no Product ↔ RsProduct bridge', () => {
    for (const source of [form, page, picker]) {
      expect(source).not.toContain('rsProduct.productId');
      expect(source).not.toMatch(/bridge/i);
    }
  });
});

// ---------------------------------------------------------------------------
//  Free text still works
// ---------------------------------------------------------------------------

describe('an off-catalogue product can still be entered', () => {
  it('keeps a free-text input beside the picker', () => {
    expect(form).toContain('Or type a product name for line');
  });

  it('clears the catalogue selection when the name is typed over', () => {
    // Otherwise the label and the selected product could disagree, and the line
    // would show a catalogue image for something else entirely.
    expect(form).toContain('productName: e.target.value, rsProduct: null');
  });

  it('accepts a typed name with no catalogue link at all', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-1003',
      customerId: CUID,
      items: [{ productName: 'Hand-beaten copper jug', quantity: 1, price: '900.00' }],
      paidAmount: '0',
      orderDate: '2026-09-17',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(true);
  });

  it('still requires a product name', () => {
    const parsed = createSalesOrderSchema.safeParse({
      orderId: 'SO-1004',
      customerId: CUID,
      items: [{ productName: '   ', quantity: 1, price: '10.00' }],
      paidAmount: '0',
      orderDate: '2026-09-17',
      toBeDispatchedBy: '2026-09-20',
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Search behaviour
// ---------------------------------------------------------------------------

describe('the picker searches the server, not the browser', () => {
  it('queries the RS Products endpoint through the proxy', () => {
    expect(picker).toContain('/api/proxy/rs-products');
  });

  it('sends the typed text as q, which the backend matches on title or SKU', () => {
    expect(picker).toContain("params.set('q', query)");
  });

  it('never calls the legacy product endpoint', () => {
    expect(picker).not.toContain('/api/proxy/products');
    expect(picker).not.toContain('procurement/products');
  });

  it('asks for a bounded page rather than the whole catalogue', () => {
    expect(picker).toMatch(/PICKER_LIMIT\s*=\s*20/);
    expect(picker).toContain("limit: String(PICKER_LIMIT)");
  });

  it('debounces and cancels, so typing does not fire a request per keystroke', () => {
    expect(picker).toMatch(/DEBOUNCE_MS\s*=\s*250/);
    expect(picker).toContain('setTimeout');
    expect(picker).toContain('clearTimeout');
    expect(picker).toContain('AbortController');
    expect(picker).toContain('controller.abort()');
  });

  it('does not re-filter on the client, which would hide real matches', () => {
    expect(picker).toContain('shouldFilter={false}');
  });
});

describe('the Sales page no longer preloads a catalogue', () => {
  it('has dropped the legacy product fetch', () => {
    expect(page).not.toContain('fetchProducts');
    expect(page).not.toContain('procurement-api');
  });

  it('passes no product list to the form', () => {
    expect(page).toContain('<CreateSalesOrderForm />');
  });

  it('uses no datalist anywhere in the form', () => {
    expect(form).not.toContain('<datalist');
    expect(form).not.toContain('list={');
  });
});

// ---------------------------------------------------------------------------
//  Result rows
// ---------------------------------------------------------------------------

describe('a result row shows image, name and SKU', () => {
  it('always states the SKU, even when there is not one', () => {
    expect(picker).toContain("SKU: {product.sku ?? 'Not available'}");
  });

  it('shows a thumbnail, with a placeholder when the product has no image', () => {
    expect(picker).toContain('ProductThumb');
    expect(picker).toContain('ImageOff');
  });

  it('shows no internal identifiers to the reader', () => {
    const rows = picker.slice(picker.indexOf('<CommandGroup>'), picker.indexOf('</CommandGroup>'));
    expect(rows).not.toContain('{product.id}</');
  });
});

describe('duplicate SKUs stay safe', () => {
  it('keys and selects rows by RsProduct id, never by SKU', () => {
    const rows = picker.slice(picker.indexOf('<CommandGroup>'), picker.indexOf('</CommandGroup>'));
    expect(rows).toContain('key={product.id}');
    expect(rows).toContain('value={product.id}');
    expect(rows).not.toContain('key={product.sku}');
    expect(rows).not.toContain('value={product.sku}');
  });

  it('marks the chosen row by id, so identical SKUs do not both tick', () => {
    expect(picker).toContain('value?.id === product.id');
  });
});

// ---------------------------------------------------------------------------
//  States
// ---------------------------------------------------------------------------

describe('every outcome has a state', () => {
  it('says "No products found" when a search matches nothing', () => {
    expect(picker).toContain('No products found');
  });

  it('has a loading state', () => {
    expect(picker).toContain('Loader2');
    expect(picker).toContain('Searching');
  });

  it('separates a permission refusal from an empty catalogue', () => {
    expect(picker).toContain('403');
    expect(picker).toContain('denied');
  });

  it('reports a failed search without breaking the rest of the form', () => {
    expect(picker).toContain('failed');
    expect(picker).toContain('could not be reached');
  });
});

// ---------------------------------------------------------------------------
//  Nothing else about Sales changed
// ---------------------------------------------------------------------------

describe('existing Sales arithmetic is untouched', () => {
  it('still derives a line total from price and quantity', () => {
    expect(lineTotal('1250.00', 2)).toBe('2500.00');
  });

  it('still sums line totals exactly', () => {
    expect(
      sumItemTotals([
        { quantity: 2, price: '1250.00' },
        { quantity: 3, price: '99.99' },
      ]),
    ).toBe('2799.97');
  });

  it('keeps using the shared helpers rather than arithmetic of its own', () => {
    expect(form).toContain('lineTotal(');
    expect(form).toContain('sumItemTotals(');
    expect(form).not.toMatch(/price\s*\*\s*quantity/);
  });

  it('still validates with the same schema the API uses', () => {
    expect(form).toContain('createSalesOrderSchema.safeParse');
  });

  it('does not copy a catalogue price onto the line', () => {
    // Price is a Sales decision. Nothing here reads a catalogue price.
    expect(form).not.toMatch(/price:\s*product\??\.(price|priceMin|priceMax)/);
  });
});

describe('the shared picker serves both modules from one implementation', () => {
  it('lives outside either module', () => {
    expect(() => read('components/products/rs-product-picker.tsx')).not.toThrow();
  });

  it('is gone from the Vendor Invoices folder, so there is no second copy', () => {
    expect(() => read('components/vendor-invoices/rs-product-picker.tsx')).toThrow();
  });

  it('is imported from the shared path by Vendor Invoices', () => {
    expect(read('components/vendor-invoices/mapping-dialogs.tsx')).toContain(
      "@/components/products/rs-product-picker",
    );
  });

  it('is imported from the shared path by Sales', () => {
    expect(form).toContain("@/components/products/rs-product-picker");
  });
});

describe('Vendor Invoices still stores the RsProduct id, which Sales does not', () => {
  it('sends rsProductId when creating a mapping', () => {
    const dialogs = read('components/vendor-invoices/mapping-dialogs.tsx');
    expect(dialogs).toContain('rsProductId: product!.id');
  });
});

describe('the change-request flow was left alone', () => {
  it('still uses a plain input and no picker', () => {
    const dialogs = read('components/sales/change-request-dialogs.tsx');
    expect(dialogs).not.toContain('RsProductPicker');
    expect(dialogs).not.toContain('rs-product-picker');
  });
});
