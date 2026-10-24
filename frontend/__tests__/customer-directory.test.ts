/**
 * The directory's pagination reading, and the nav entry that reaches it.
 *
 * Pure: no DOM, no network, matching the frontend suite's convention.
 *
 * The pagination logic is the part worth pinning. The API answers in one of two
 * modes — keyset when the sort is a column, offset when it is a derived
 * aggregate — and a page that assumed the wrong one would render a "next" link
 * that skips rows, or page numbers for a response that carries no total. Both
 * failures look like working navigation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NAV_ITEMS, visibleNavItems } from '@/components/layout/nav-items';
import { navIcon } from '@/components/layout/nav-icons';
import { readPagination } from '@/lib/customer-api';

describe('reading the pagination descriptor', () => {
  it('reads a keyset page and its cursor', () => {
    expect(readPagination({ pagination: { mode: 'keyset', nextCursor: 'abc' } })).toEqual({
      mode: 'keyset',
      nextCursor: 'abc',
    });
  });

  it('reads a keyset page with no further page', () => {
    expect(readPagination({ pagination: { mode: 'keyset', nextCursor: null } })).toEqual({
      mode: 'keyset',
      nextCursor: null,
    });
  });

  it('reads an offset page with its total', () => {
    expect(
      readPagination({ pagination: { mode: 'offset', page: 2, total: 60, totalPages: 3 } }),
    ).toEqual({ mode: 'offset', page: 2, total: 60, totalPages: 3 });
  });

  it('falls back to a single page when meta is absent', () => {
    /*
      The safe reading: offer no navigation rather than broken navigation. An
      invented cursor would silently skip rows.
    */
    expect(readPagination(undefined)).toEqual({ mode: 'keyset', nextCursor: null });
    expect(readPagination({})).toEqual({ mode: 'keyset', nextCursor: null });
  });

  it('falls back when the mode is unrecognised', () => {
    // A future mode this build does not know must not be guessed at.
    expect(readPagination({ pagination: { mode: 'something-new' } })).toEqual({
      mode: 'keyset',
      nextCursor: null,
    });
  });

  it('does not treat a non-string cursor as a cursor', () => {
    expect(readPagination({ pagination: { mode: 'keyset', nextCursor: 42 } })).toEqual({
      mode: 'keyset',
      nextCursor: null,
    });
  });

  it('defaults missing offset numbers rather than rendering NaN', () => {
    const result = readPagination({ pagination: { mode: 'offset' } });
    expect(result).toEqual({ mode: 'offset', page: 1, total: 0, totalPages: 0 });
  });
});

describe('the All Customers nav entry', () => {
  const entry = NAV_ITEMS.find((item) => item.href === '/customers');

  it('exists as a top-level destination', () => {
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('All Customers');
  });

  it('gates on its own module rather than borrowing another', () => {
    // Reading a customer's purchase history is a different grant from filing an
    // enquiry, which is what gates customer creation.
    expect(entry?.module).toBe('CUSTOMERS');
  });

  it('resolves to an icon of its own', () => {
    expect(entry?.icon).toBe('customers');
    expect(navIcon('customers')).toBeDefined();
  });

  it('is hidden from somebody without the module', () => {
    const hrefs = visibleNavItems(['SALES'], false).map((item) => item.href);
    expect(hrefs).not.toContain('/customers');
  });

  it('is shown to somebody with it', () => {
    const hrefs = visibleNavItems(['CUSTOMERS'], false).map((item) => item.href);
    expect(hrefs).toContain('/customers');
  });

  it('carries no children, so it cannot hide a submodule', () => {
    expect(entry?.children).toBeUndefined();
  });
});

describe('the directory page honours the API contract', () => {
  /*
    Source assertions. The page is a Server Component that awaits data, so it
    cannot be rendered in this DOM-less suite — but the mistakes worth guarding
    against are visible in the source: inventing a query parameter the API would
    reject with a 422, or losing a filter when somebody sorts.
  */
  const page = (): string =>
    readFileSync(new URL('../app/(app)/customers/page.tsx', import.meta.url), 'utf8');

  it('passes through only parameters the API schema accepts', () => {
    const src = page();
    /*
      Every name here appears in customerDirectoryQuerySchema. A parameter the
      schema does not know would be rejected for the whole request, so the
      allowlist is the contract.
    */
    for (const param of [
      'q',
      'type',
      'state',
      'country',
      'source',
      'sourceTouch',
      'hasOrders',
      'isRepeat',
      'duplicatesOnly',
      'minPurchaseValue',
      'maxPurchaseValue',
      'purchasedFrom',
      'purchasedTo',
      'sort',
      'direction',
      'cursor',
      'page',
      'limit',
    ]) {
      expect(src, `${param} missing from the passthrough list`).toContain(`'${param}'`);
    }
  });

  it('gates on CUSTOMERS VIEW before fetching anything', () => {
    const src = page();
    const gate = src.indexOf("can(access.user, 'CUSTOMERS', 'VIEW')");
    const fetchCall = src.indexOf('fetchCustomerDirectory(');
    expect(gate).toBeGreaterThan(-1);
    expect(fetchCall).toBeGreaterThan(gate);
  });

  it('renders a permission-denied state rather than an empty table', () => {
    expect(page()).toContain('<NoModuleAccess module="CUSTOMERS" />');
  });

  it('distinguishes "no customers" from "no matches"', () => {
    // Telling somebody the directory is empty when they have filtered it to
    // nothing sends them looking for a bug that is not there.
    const table = readFileSync(
      new URL('../components/customers/customer-directory-table.tsx', import.meta.url),
      'utf8',
    );
    expect(table).toContain('No customers match these filters');
    expect(table).toContain('No customers yet');
  });

  it('drops the position marker when the sort changes', () => {
    /*
      A cursor from a previous ordering points into a sequence that no longer
      exists, so re-sorting must start from the beginning.
    */
    const table = readFileSync(
      new URL('../components/customers/customer-directory-table.tsx', import.meta.url),
      'utf8',
    );
    expect(table).toContain("query.delete('cursor')");
    expect(table).toContain("query.delete('page')");
  });

  it('renders page numbers only for an offset response', () => {
    const table = readFileSync(
      new URL('../components/customers/customer-directory-table.tsx', import.meta.url),
      'utf8',
    );
    // Keyset carries no total, so a page count would be invented.
    expect(table).toContain("pagination.mode === 'keyset'");
  });
});
