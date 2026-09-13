/**
 * RS Products — the module as the frontend sees it.
 *
 * Phase 1 ships no catalogue, so there is no arithmetic to assert here. What
 * matters instead is that the module is wired into the three places a new
 * module has to reach — the shared enum, the label table and the navigation —
 * and that it stays hidden from anyone who has not been granted it.
 *
 * The label assertion is the one worth keeping: APP_MODULE_LABELS is typed as
 * `satisfies Record<string, string>` rather than `Record<AppModule, string>`,
 * so a missing entry is not a compile error. It surfaces as `undefined` in the
 * sidebar and the permission grid at runtime.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_MODULES, APP_MODULE_LABELS } from '@rs/shared';
import { NAV_ITEMS, visibleNavItems } from '@/components/layout/nav-items';
import { navIcon } from '@/components/layout/nav-icons';
import { accessibleModules, hasModule, moduleLabel } from '@/lib/module-access';
import type { CurrentUser } from '@/lib/current-user';

/** A signed-in person holding exactly the listed capabilities. */
function userWith(
  role: 'ADMIN' | 'USER',
  permissions: { module: string; action: string; allowed: boolean }[],
): CurrentUser {
  return {
    id: 'clx0000000000000000000000',
    name: 'Test Person',
    email: 'test@test.invalid',
    employeeId: 'ZZ000001',
    role,
    permissions,
  } as unknown as CurrentUser;
}

const view = (module: string, allowed = true) => ({ module, action: 'VIEW', allowed });

describe('RS_PRODUCTS is part of the module vocabulary', () => {
  it('appears in the shared enum', () => {
    expect(APP_MODULES).toContain('RS_PRODUCTS');
  });

  it('has a display label, which the type does not enforce', () => {
    expect(APP_MODULE_LABELS.RS_PRODUCTS).toBe('RS Products');
    expect(moduleLabel('RS_PRODUCTS')).toBe('RS Products');
  });

  it('leaves every other module labelled, so nothing was displaced', () => {
    for (const module of APP_MODULES) {
      expect(APP_MODULE_LABELS[module], module).toBeTruthy();
    }
  });

  it('is declared in the Prisma enum too, or the database would reject it', () => {
    // The three files have to move together. A value in the TypeScript enum
    // that Postgres does not know is a runtime failure on the first write.
    const schema = readFileSync(
      new URL('../../database/prisma/schema.prisma', import.meta.url),
      'utf8',
    );
    const appModule = schema.slice(
      schema.indexOf('enum AppModule {'),
      schema.indexOf('enum PermissionAction {'),
    );
    expect(appModule).toContain('RS_PRODUCTS');
  });
});

describe('RS Products is a live, permission-gated nav item', () => {
  it('appears in the navigation as available', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/rs-products');
    expect(item).toBeDefined();
    expect(item?.available).toBe(true);
    expect(item?.module).toBe('RS_PRODUCTS');
    expect(item?.label).toBe('RS Products');
  });

  it('has a resolvable icon', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/rs-products')!;
    expect(navIcon(item.icon)).toBeDefined();
  });

  it('is not an admin-only item — it is granted per module', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/rs-products')!;
    expect(item.adminOnly).toBeUndefined();
  });

  it('is hidden from a USER without the module', () => {
    const hrefs = visibleNavItems(['PRODUCT_ENQUIRY', 'SALES'], false).map((i) => i.href);
    expect(hrefs).not.toContain('/rs-products');
  });

  it('is shown once the module is granted', () => {
    const hrefs = visibleNavItems(['RS_PRODUCTS'], false).map((i) => i.href);
    expect(hrefs).toEqual(['/dashboard', '/rs-products']);
  });

  it('does not drag the other modules in with it', () => {
    const hrefs = visibleNavItems(['RS_PRODUCTS'], false).map((i) => i.href);
    expect(hrefs).not.toContain('/procurement');
    expect(hrefs).not.toContain('/sales');
  });
});

describe('module access resolves from the matrix, not the role', () => {
  it('grants an administrator whose matrix says so', () => {
    const admin = userWith('ADMIN', [view('RS_PRODUCTS')]);
    expect(hasModule(admin, 'RS_PRODUCTS')).toBe(true);
    expect(accessibleModules(admin)).toContain('RS_PRODUCTS');
  });

  it('denies a USER with no RS Products row', () => {
    const employee = userWith('USER', [view('SALES')]);
    expect(hasModule(employee, 'RS_PRODUCTS')).toBe(false);
    expect(accessibleModules(employee)).not.toContain('RS_PRODUCTS');
  });

  it('denies anyone whose override sets allowed false, whatever their role', () => {
    // An override row is authoritative even when it says false — that is how a
    // module is revoked from one person without changing their role.
    const revoked = userWith('ADMIN', [view('RS_PRODUCTS', false)]);
    expect(hasModule(revoked, 'RS_PRODUCTS')).toBe(false);
  });

  it('denies a signed-out visitor', () => {
    expect(hasModule(null, 'RS_PRODUCTS')).toBe(false);
    expect(accessibleModules(null)).toEqual([]);
  });
});
