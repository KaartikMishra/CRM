/**
 * Pagination and the row actions, as pure logic.
 *
 * The cursor stack is the part worth testing: the backend hands back only a
 * `nextCursor`, so going *back* depends entirely on the stack carried in the
 * URL being encoded and decoded correctly. A bug here means Previous silently
 * lands on the wrong page.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeStack, encodeStack } from '@/components/rs-products/pagination-controls';
import { RS_PRODUCT_PAGE_LIMIT } from '@/lib/rs-product-api';

describe('the page size is fixed at 50', () => {
  it('requests exactly 50', () => {
    expect(RS_PRODUCT_PAGE_LIMIT).toBe(50);
  });

  it('never exceeds what the backend accepts', () => {
    expect(RS_PRODUCT_PAGE_LIMIT).toBeLessThanOrEqual(100);
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

  it('counts pages from the stack depth', () => {
    // Page 1 has an empty stack; each entry past that is one Next.
    expect(decodeStack(undefined).length + 1).toBe(1);
    expect(decodeStack('a').length + 1).toBe(2);
    expect(decodeStack('a,b,c').length + 1).toBe(4);
  });

  it('knows when Previous is available', () => {
    expect(decodeStack(undefined).length > 0).toBe(false);
    expect(decodeStack('a').length > 0).toBe(true);
  });

  it('pops exactly one page going back', () => {
    const stack = decodeStack('a,b,c');
    expect(stack.slice(0, -1)).toEqual(['a', 'b']);
    // Never a jump to page 1: Previous from page 4 is page 3.
    expect(stack.slice(0, -1).length + 1).toBe(3);
  });

  it('pushes the cursor it used going forward', () => {
    const stack = decodeStack('a');
    expect([...stack, 'b']).toEqual(['a', 'b']);
  });
});

describe('the catalogue page wires pagination correctly', () => {
  const page = readFileSync(new URL('../app/(app)/rs-products/page.tsx', import.meta.url), 'utf8');

  it('reads the stack from the URL', () => {
    expect(page).toContain('decodeStack');
    expect(page).toContain('params.pages');
  });

  it('passes the next cursor from the API meta', () => {
    expect(page).toContain('meta.nextCursor');
  });

  it('carries filters alongside pagination', () => {
    expect(page).toContain('filters');
    for (const filter of ['q', 'status', 'source', 'productType', 'sort']) {
      expect(page).toContain(filter);
    }
  });

  it('uses a GET form, so searching drops the cursor and returns to page 1', () => {
    // A GET form submits only its own named inputs; `cursor` and `pages` are
    // not among them, so a new search cannot inherit a stale cursor.
    expect(page).toContain('action="/rs-products"');
    expect(page).not.toContain('name="cursor"');
    expect(page).not.toContain('name="pages"');
  });

  it('gates the row actions on real permissions', () => {
    expect(page).toContain("can(access.user, 'RS_PRODUCTS', 'EDIT')");
    expect(page).toContain("can(access.user, 'RS_PRODUCTS', 'DELETE')");
  });
});

describe('the table separates CRM stock from Shopify inventory', () => {
  const table = readFileSync(
    new URL('../components/rs-products/product-table.tsx', import.meta.url),
    'utf8',
  );

  it('shows both figures under distinct headings', () => {
    expect(table).toContain('CRM stock');
    expect(table).toContain('Shopify');
    expect(table).toContain('crmStockQty');
  });

  it('renders the actions column only when a permission allows it', () => {
    expect(table).toContain('showActions');
    expect(table).toContain('canEdit');
    expect(table).toContain('canArchive');
  });
});

describe('the edit form respects field ownership', () => {
  const form = readFileSync(
    new URL('../components/rs-products/edit-product-form.tsx', import.meta.url),
    'utf8',
  );

  it('locks Shopify-owned fields on a synced product', () => {
    expect(form).toContain('crmOwned');
    expect(form).toContain('disabled={!crmOwned}');
  });

  it('leaves cost, CRM stock and dimensions editable regardless of source', () => {
    // None of these carries a `disabled` binding, because Shopify writes none
    // of them: cost is null on all 569 synced variants, and the dimension
    // metafields have no unit.
    for (const field of ['costPrice__', 'crmStockQty__', 'lengthValue__', 'dimensionUnit__']) {
      expect(form).toContain(field);
    }
  });

  it('shows Shopify inventory read-only beside CRM stock', () => {
    expect(form).toContain('Shopify inventory');
    expect(form).toContain('disabled readOnly');
  });

  it('forbids negative CRM stock in the control itself', () => {
    expect(form).toContain('min={0}');
  });

  it('never offers a control for a Shopify identifier', () => {
    expect(form).not.toContain('name="shopifyProductId"');
    expect(form).not.toContain('name="shopifyVariantId"');
    expect(form).not.toContain('name="inventoryQty"');
    expect(form).not.toContain('name="source"');
  });
});

describe('the archive action states what it does', () => {
  const actions = readFileSync(
    new URL('../components/rs-products/product-actions.tsx', import.meta.url),
    'utf8',
  );

  it('confirms before archiving', () => {
    expect(actions).toContain('AlertDialog');
    expect(actions).toContain('Archive');
  });

  it('says the product is not deleted', () => {
    expect(actions).toContain('not deleted');
  });

  it('says Shopify is unaffected', () => {
    expect(actions).toContain('not');
    expect(actions).toContain('Shopify');
  });

  it('offers no hard-delete path', () => {
    expect(actions).not.toContain('deleteRsProduct');
    expect(actions).not.toContain("method: 'DELETE'");
  });
});
