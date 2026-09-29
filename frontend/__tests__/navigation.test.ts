/**
 * Navigation, module visibility, and the Server → Client boundary.
 *
 * The bug these guard against: nav items are built in a Server Component and
 * handed to the Client sidebar, so every field on them must be serializable by
 * React. Holding a Lucide component on `icon` made the whole layout fail at
 * runtime with "Only plain objects can be passed to Client Components".
 *
 * The first block is the regression test for exactly that, asserted
 * structurally rather than by rendering: if anyone puts a function back on a
 * nav item, this fails.
 */

import { describe, expect, it } from 'vitest';
import { APP_MODULES, type AppModule } from '@rs/shared';
import { NAV_ITEMS, visibleNavItems, type NavIconKey } from '@/components/layout/nav-items';
import { navIcon } from '@/components/layout/nav-icons';

/** Mirrors what React will accept across the boundary. */
function isSerializable(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'function' || type === 'symbol') return false;
  if (type !== 'object') return true;
  if (value instanceof Date || value instanceof Map || value instanceof Set) return false;
  if (Array.isArray(value)) return value.every(isSerializable);
  return Object.values(value as Record<string, unknown>).every(isSerializable);
}

describe('nav items are serializable across the Server → Client boundary', () => {
  it('holds no functions, components or class instances', () => {
    for (const item of NAV_ITEMS) {
      expect(isSerializable(item), `${item.label} is not serializable`).toBe(true);
    }
  });

  it('survives a JSON round trip unchanged, which is the real test', () => {
    expect(JSON.parse(JSON.stringify(NAV_ITEMS))).toEqual(NAV_ITEMS);
  });

  it('names its icon with a string rather than carrying a component', () => {
    for (const item of NAV_ITEMS) {
      expect(typeof item.icon).toBe('string');
    }
  });

  it('keeps every filtered result serializable too', () => {
    const items = visibleNavItems([...APP_MODULES], true);
    expect(JSON.parse(JSON.stringify(items))).toEqual(items);
  });
});

describe('the icon registry', () => {
  /**
   * A Lucide icon is a forwardRef object — `{ $$typeof, render }` — not a bare
   * function. That is precisely why it cannot cross the boundary, and why the
   * items carry a key instead. Renderable here means "defined, and either a
   * function or a React element type".
   */
  const isRenderable = (icon: unknown): boolean =>
    icon !== undefined && icon !== null && ['function', 'object'].includes(typeof icon);

  it('resolves every key a nav item uses', () => {
    for (const item of NAV_ITEMS) {
      expect(isRenderable(navIcon(item.icon)), `no icon for ${item.icon}`).toBe(true);
    }
  });

  it('returns a usable fallback for an unknown key instead of crashing', () => {
    // A missing icon should cost one glyph, not the whole layout.
    const icon = navIcon('not-a-real-key' as NavIconKey);
    expect(icon).toBeDefined();
    expect(isRenderable(icon)).toBe(true);
  });

  it('maps each key to a distinct icon', () => {
    const icons = NAV_ITEMS.map((item) => navIcon(item.icon));
    expect(new Set(icons).size).toBe(NAV_ITEMS.length);
  });
});

describe('the navigation table itself is unchanged', () => {
  it('still lists all ten destinations in order', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/dashboard',
      '/product-enquiry',
      '/sales',
      '/procurement',
      '/rs-products',
      '/dispatch',
      '/billing',
      '/vendor-invoices',
      '/post-sales',
      '/users',
    ]);
  });

  it('keeps the existing labels', () => {
    const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i.label]));
    expect(byHref.get('/dashboard')).toBe('Dashboard');
    expect(byHref.get('/product-enquiry')).toBe('Product Enquiry');
    expect(byHref.get('/sales')).toBe('Sales');
    expect(byHref.get('/users')).toBe('User Management');
  });

  it('keeps the six live modules available and the two future ones not', () => {
    // Packing & Dispatch joined Product Enquiry, Sales, Procurement, RS
    // Products and Vendor Invoices as a built module; the remaining two are
    // still placeholders and must keep saying so.
    const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
    expect(byHref.get('/product-enquiry')?.available).toBe(true);
    expect(byHref.get('/sales')?.available).toBe(true);
    expect(byHref.get('/procurement')?.available).toBe(true);
    expect(byHref.get('/rs-products')?.available).toBe(true);
    expect(byHref.get('/vendor-invoices')?.available).toBe(true);
    expect(byHref.get('/dispatch')?.available).toBe(true);

    for (const href of ['/billing', '/post-sales']) {
      expect(byHref.get(href)?.available, href).toBe(false);
    }
  });

  it('gates every CRM item on a module, and Dashboard on none', () => {
    const dashboard = NAV_ITEMS.find((i) => i.href === '/dashboard');
    expect(dashboard?.module).toBeUndefined();

    const gated = NAV_ITEMS.filter((i) => i.module).map((i) => i.module);
    expect(gated.sort()).toEqual([...APP_MODULES].sort());
  });
});

describe('module visibility is unchanged by the fix', () => {
  const only = (...modules: AppModule[]) => visibleNavItems(modules, false).map((i) => i.href);

  it('shows an administrator everything, including User Management', () => {
    const hrefs = visibleNavItems([...APP_MODULES], true).map((i) => i.href);
    expect(hrefs).toHaveLength(10);
    expect(hrefs).toContain('/users');
  });

  it('shows a USER only their assigned modules, plus Dashboard', () => {
    expect(only('PRODUCT_ENQUIRY', 'SALES')).toEqual([
      '/dashboard',
      '/product-enquiry',
      '/sales',
    ]);
  });

  it('never shows User Management to a USER, whatever modules they hold', () => {
    expect(only(...APP_MODULES)).not.toContain('/users');
    // Even with every module, adminOnly is decided by role alone.
    expect(visibleNavItems([...APP_MODULES], false).map((i) => i.href)).not.toContain('/users');
  });

  it('leaves a USER with no modules just the Dashboard', () => {
    expect(only()).toEqual(['/dashboard']);
  });

  it('shows a single granted module and nothing else', () => {
    expect(only('SALES')).toEqual(['/dashboard', '/sales']);
    expect(only('PRODUCT_ENQUIRY')).toEqual(['/dashboard', '/product-enquiry']);
  });

  it('shows a future module once it is granted, still marked unavailable', () => {
    const items = visibleNavItems(['POST_SALES'], false);
    expect(items.map((i) => i.href)).toEqual(['/dashboard', '/post-sales']);
    expect(items.find((i) => i.href === '/post-sales')?.available).toBe(false);
  });

  it('an administrator with no granted modules still sees everything', () => {
    // ADMIN access comes from the role, never from stored permission rows.
    expect(visibleNavItems([], true).map((i) => i.href)).toEqual(['/dashboard', '/users']);
  });
});

describe('rendering determinism', () => {
  it('produces the same list for the same input, so SSR and hydration agree', () => {
    const a = visibleNavItems(['PRODUCT_ENQUIRY', 'SALES'], false);
    const b = visibleNavItems(['PRODUCT_ENQUIRY', 'SALES'], false);
    expect(a).toEqual(b);
  });

  it('gives every item a unique href, so React keys cannot collide', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('ignores the order modules arrive in', () => {
    expect(visibleNavItems(['SALES', 'PRODUCT_ENQUIRY'], false)).toEqual(
      visibleNavItems(['PRODUCT_ENQUIRY', 'SALES'], false),
    );
  });
});

describe('Purchase & Procurement is a parent, and Procurement Clock sits under it', () => {
  const procurement = NAV_ITEMS.find((i) => i.href === '/procurement');
  const clock = procurement?.children?.find((c) => c.href === '/procurement/clock');

  it('does not expose Procurement Clock as a top-level module', () => {
    // The whole point of the nesting. If this ever fails, the submodule has
    // been promoted to a sidebar module of its own.
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain('/procurement/clock');
    expect(NAV_ITEMS).toHaveLength(10);
  });

  it('carries it as a child of Purchase & Procurement', () => {
    expect(procurement?.children?.map((c) => c.href)).toEqual(['/procurement/clock']);
    expect(clock?.label).toBe('Procurement Clock');
    expect(clock?.available).toBe(true);
  });

  it('leaves the parent route and its availability untouched', () => {
    // Expanding a module must not cost it the page it already had.
    expect(procurement?.href).toBe('/procurement');
    expect(procurement?.label).toBe('Purchase & Procurement');
    expect(procurement?.available).toBe(true);
    expect(procurement?.module).toBe('PROCUREMENT');
  });

  it('gates the submodule on the parent module, inventing no new one', () => {
    // A submodule inherits its parent's access. A new AppModule value would
    // mean a schema change and a migration to show one sidebar row.
    expect(clock?.module).toBe('PROCUREMENT');
    expect(APP_MODULES).not.toContain('PROCUREMENT_CLOCK' as AppModule);
  });

  it('nests the child route under the parent route, so active state resolves', () => {
    // The sidebar marks a row current with pathname.startsWith(href + '/'); a
    // child outside the parent path would never light up its parent.
    expect(clock?.href.startsWith('/procurement/')).toBe(true);
  });

  it('resolves the child icon, and not to the same one as the parent', () => {
    expect(navIcon(clock!.icon)).toBeDefined();
    expect(navIcon(clock!.icon)).not.toBe(navIcon(procurement!.icon));
  });

  it('gives no other module children, so nothing else changed shape', () => {
    const withChildren = NAV_ITEMS.filter((i) => i.children?.length).map((i) => i.href);
    expect(withChildren).toEqual(['/procurement']);
  });

  it('keeps the nested items serializable across the Server -> Client boundary', () => {
    // Children cross the same boundary the parents do.
    expect(isSerializable(procurement)).toBe(true);
    expect(JSON.parse(JSON.stringify(NAV_ITEMS))).toEqual(NAV_ITEMS);
  });
});

describe('submodule visibility follows the parent', () => {
  it('shows the submodule to somebody who holds PROCUREMENT', () => {
    const items = visibleNavItems(['PROCUREMENT'], false);
    expect(items.map((i) => i.href)).toEqual(['/dashboard', '/procurement']);

    const parent = items.find((i) => i.href === '/procurement');
    expect(parent?.children?.map((c) => c.href)).toEqual(['/procurement/clock']);
  });

  it('hides parent and submodule together without PROCUREMENT', () => {
    const hrefs = visibleNavItems(['SALES'], false).map((i) => i.href);
    expect(hrefs).not.toContain('/procurement');
    // And it cannot leak in as a top-level row either.
    expect(hrefs).not.toContain('/procurement/clock');
  });

  it('never mutates the shared table while filtering', () => {
    // NAV_ITEMS is module-level state; filtering it in place would leak one
    // person's access into the next request.
    const before = JSON.stringify(NAV_ITEMS);
    visibleNavItems(['PROCUREMENT'], false);
    visibleNavItems([], false);
    visibleNavItems([...APP_MODULES], true);
    expect(JSON.stringify(NAV_ITEMS)).toBe(before);
  });
});
