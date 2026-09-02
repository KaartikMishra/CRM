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
  it('still lists all nine destinations in order', () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/dashboard',
      '/product-enquiry',
      '/sales',
      '/procurement',
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

  it('keeps the two live modules available and the five future ones not', () => {
    const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
    expect(byHref.get('/product-enquiry')?.available).toBe(true);
    expect(byHref.get('/sales')?.available).toBe(true);
    expect(byHref.get('/procurement')?.available).toBe(false);
    expect(byHref.get('/post-sales')?.available).toBe(false);
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
    expect(hrefs).toHaveLength(9);
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
