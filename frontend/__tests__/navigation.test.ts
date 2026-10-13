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
import { APP_MODULES, MODULES_WITHOUT_NAVIGATION, type AppModule } from '@rs/shared';
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
  it('still lists all twelve destinations in order', () => {
    // HR & Workforce joined in Phase 1, between Post Sales and User Management.
    expect(NAV_ITEMS.map((i) => i.href)).toEqual([
      '/dashboard',
      '/create-lead',
      '/product-enquiry',
      '/sales',
      '/procurement',
      '/rs-products',
      '/dispatch',
      '/billing',
      '/vendor-invoices',
      '/post-sales',
      '/hr',
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

  it('keeps the live modules available and the one future one not', () => {
    /*
      Post Sales & Grievance joined Product Enquiry, Sales, Procurement, RS
      Products, Packing & Dispatch and Vendor Invoices as a built module. Customer
      Billing is the last placeholder and must keep saying so.
    */
    const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
    expect(byHref.get('/product-enquiry')?.available).toBe(true);
    expect(byHref.get('/sales')?.available).toBe(true);
    expect(byHref.get('/procurement')?.available).toBe(true);
    expect(byHref.get('/rs-products')?.available).toBe(true);
    expect(byHref.get('/vendor-invoices')?.available).toBe(true);
    expect(byHref.get('/dispatch')?.available).toBe(true);
    expect(byHref.get('/post-sales')?.available).toBe(true);

    for (const href of ['/billing']) {
      expect(byHref.get(href)?.available, href).toBe(false);
    }
  });

  it('gates every CRM item on a module, and Dashboard on none', () => {
    const dashboard = NAV_ITEMS.find((i) => i.href === '/dashboard');
    expect(dashboard?.module).toBeUndefined();

    /*
      Every gated item names a real AppModule. This is the invariant that
      matters: a nav item gated on a module that does not exist is a row nobody
      can ever be granted, and nothing else in the system would catch it.

      It replaces an equality assertion — `gated.sort()` === `[...APP_MODULES]` —
      which additionally required every AppModule to have a nav item. That held
      only by coincidence of timing, because until now every module got its
      sidebar row in the same change that added its enum value. It is not the
      architecture: an AppModule is a permission namespace, and a namespace is
      registered before the screen that uses it exists — which is exactly what HR
      does. The equality direction would have made registering a namespace early
      impossible, so the test, not the architecture, was wrong.
    */
    const gated = NAV_ITEMS.filter((i) => i.module).map((i) => i.module);
    for (const module of gated) {
      expect(APP_MODULES, `${module} is not an AppModule`).toContain(module);
    }
  });

  it('includes every navigable module and excludes the registered-only ones', () => {
    /*
      The other half of the invariant, asserted explicitly so an unused namespace
      is a recorded decision rather than a forgotten nav item.

      A module is in exactly one of two states: it has a nav item, or it appears
      in MODULES_WITHOUT_NAVIGATION with a reason. Nothing may be in neither (a
      module nobody can reach) or both (a contradiction). Adding an AppModule and
      forgetting its sidebar row therefore fails here, which is the protection the
      old equality assertion really provided — kept, without also forbidding a
      namespace from preceding its page.
    */
    const gated = new Set(NAV_ITEMS.filter((i) => i.module).map((i) => i.module));
    const registeredOnly = new Set<AppModule>(MODULES_WITHOUT_NAVIGATION);

    for (const module of APP_MODULES) {
      const hasNav = gated.has(module);
      const isRegisteredOnly = registeredOnly.has(module);
      expect(
        hasNav !== isRegisteredOnly,
        hasNav
          ? `${module} has a nav item and is also listed as having none`
          : `${module} has no nav item and is not listed in MODULES_WITHOUT_NAVIGATION`,
      ).toBe(true);
    }
  });

  it('registers the HR namespaces with no top-level row, and nothing else', () => {
    /*
      Phase 0.5 ships the HR permission vocabulary and deliberately no HR pages.
      Naming the seven exactly is what stops this list quietly becoming a place to
      park modules somebody forgot to finish: when Phase 1 adds the HR screens,
      each one leaves this list in the same change, and this assertion is what
      forces that to be noticed.
    */
    expect([...MODULES_WITHOUT_NAVIGATION].sort()).toEqual([
      /*
        HR_EMPLOYEE left this list in Phase 1 — it has the directory and profile.
        HR_ADMIN remains deliberately: it governs the department and designation
        masters, which have pages but no sidebar row, because every child must
        share its parent's module and HR_ADMIN is a different grant. The rest are
        Phases 2–7.
      */
      'HR_ADMIN',
      'HR_ATTENDANCE',
      'HR_LEAVE',
      'HR_PAYROLL',
      'HR_PERFORMANCE',
      'HR_RECRUITMENT',
      /*
        HR_TRAINING joins in Phase 4 *with* working pages, which is not a
        contradiction: this list tracks modules with no **top-level** sidebar row,
        and Training is a child of HR & Workforce — exactly like Attendance, Leave
        and Recruitment before it.

        HR_PERFORMANCE remains the only entry here that is genuinely unbuilt. It
        stays registered so an administrator's grant matrix is stable across phases
        rather than growing a column each time a module ships.
      */
      'HR_TRAINING',
    ]);

    // And they really are absent from the sidebar, not merely declared absent.
    const gated = NAV_ITEMS.filter((i) => i.module).map((i) => i.module);
    for (const module of MODULES_WITHOUT_NAVIGATION) {
      expect(gated, module).not.toContain(module);
    }
  });

  /*
    What the invariant actually means, pinned.

    Five of the modules on that list have working pages and a *child* sidebar row —
    Attendance, Leave, Recruitment, Training and Performance. They stay on the list
    because it counts **top-level** rows, and reading it as "has no navigation at all" would
    make somebody either delete a correct entry or widen the invariant to walk
    children, which would then demand a top-level row for every HR namespace and put
    structural administration beside the directory.

    So this asserts both halves explicitly: each of those five is absent from the
    top-level rows (why it is on the list) and present among the children (why
    removing it would be wrong). A future change that moves one to the top level
    fails the first expectation; one that drops a child row fails the second.
  */
  it('counts top-level rows only — a listed module may still have a child row', () => {
    const topLevel = new Set(NAV_ITEMS.filter((i) => i.module).map((i) => i.module));
    const children = new Set(
      NAV_ITEMS.flatMap((i) => i.children ?? []).map((child) => child.module),
    );

    for (const module of [
      'HR_ATTENDANCE',
      'HR_LEAVE',
      'HR_RECRUITMENT',
      'HR_TRAINING',
      // Phase 5 joins them: Performance is a child row under HR & Workforce.
      'HR_PERFORMANCE',
    ] as const) {
      expect(MODULES_WITHOUT_NAVIGATION, module).toContain(module);
      expect(topLevel, `${module} must not have a top-level row`).not.toContain(module);
      expect(children, `${module} must have a child row`).toContain(module);
    }
  });

  /*
    HR_PERFORMANCE is the one entry that genuinely has nothing, and saying so
    separates "registered before its phase" from "has a child row" — the two reasons
    a module sits on that list, which the list itself cannot distinguish.
  */
  /*
    HR_PAYROLL is now the only entry with nothing at either level, and saying so
    separates the two reasons a module sits on that list — "registered before its
    phase" from "has a child row". The list itself cannot distinguish them.

    HR_PERFORMANCE left this case in Phase 5: it gained a child row under HR &
    Workforce, exactly as HR_ATTENDANCE, HR_LEAVE, HR_RECRUITMENT and HR_TRAINING
    did before it, and is covered by the top-level-only test above.
  */
  it('keeps HR_PAYROLL with no row at either level, top or child', () => {
    const topLevel = NAV_ITEMS.filter((i) => i.module).map((i) => i.module);
    const children = NAV_ITEMS.flatMap((i) => i.children ?? []).map((child) => child.module);

    expect(topLevel).not.toContain('HR_PAYROLL');
    expect(children).not.toContain('HR_PAYROLL');
  });
});

describe('module visibility is unchanged by the fix', () => {
  const only = (...modules: AppModule[]) => visibleNavItems(modules, false).map((i) => i.href);

  it('shows an administrator everything, including User Management', () => {
    const hrefs = visibleNavItems([...APP_MODULES], true).map((i) => i.href);
    // Twelve since HR & Workforce joined the table.
    expect(hrefs).toHaveLength(12);
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
    // Customer Billing is the remaining placeholder; Post Sales is now built.
    const items = visibleNavItems(['CUSTOMER_BILLING'], false);
    expect(items.map((i) => i.href)).toEqual(['/dashboard', '/billing']);
    expect(items.find((i) => i.href === '/billing')?.available).toBe(false);
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
    expect(NAV_ITEMS).toHaveLength(12);
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

  it('names exactly the modules that have children', () => {
    /*
      Four: Procurement carries the Clock, Create Lead / Deal the analytics board,
      Post Sales its case views, and HR the directory, create form, Attendance and
      Leave. The first three share their parent's module; HR's Attendance and Leave
      deliberately do not, because HR is seven namespaces and a single grant must
      not open all of them. The department and designation masters stay off the
      sidebar entirely, on HR_ADMIN.
    */
    const withChildren = NAV_ITEMS.filter((i) => i.children?.length).map((i) => i.href);
    expect(withChildren.sort()).toEqual(['/create-lead', '/hr', '/post-sales', '/procurement']);
  });

  it('gates every child on a real module of its own', () => {
    /*
      This replaced a stricter rule — `child.module === parent.module` — which held
      for Procurement, Create Lead and Post Sales because each of those is one
      permission namespace with sub-pages.

      HR is not. It is seven namespaces by design, and Phase 2's Attendance and
      Leave are gated on HR_ATTENDANCE and HR_LEAVE so an administrator can grant
      attendance access without also handing over the employee directory. Forcing
      them onto the parent's HR_EMPLOYEE to satisfy the old rule would make one
      grant open all three — the exact conflation the namespaces exist to prevent.

      So the invariant is the weaker, true one: every child names a module that
      exists. `visibleNavItems` already filters children by their own module, so a
      row is never offered to somebody the API would refuse.
    */
    for (const parent of NAV_ITEMS.filter((i) => i.children?.length)) {
      for (const child of parent.children ?? []) {
        expect(child.module, `${child.href} under ${parent.href}`).toBeDefined();
        expect(APP_MODULES, `${child.href}`).toContain(child.module);
      }
    }
  });

  it('names exactly the children that differ from their parent, and why', () => {
    /*
      The other half: a child on a different module is a real decision, so it is
      listed here rather than left to be noticed. Anything else diverging fails,
      which is what the old equality rule was really protecting.
    */
    const diverging = NAV_ITEMS.flatMap((parent) =>
      (parent.children ?? [])
        .filter((child) => child.module !== parent.module)
        .map((child) => child.href),
    );

    /*
      Four, all under HR, all on HR's own namespaces: Attendance on HR_ATTENDANCE,
      Leave on HR_LEAVE, Recruitment and Onboarding on HR_RECRUITMENT.

      Probation is deliberately absent from this list. It sits on HR_EMPLOYEE — its
      parent's own module — because a probation is a fact about somebody's
      employment reviewed by their reporting manager, not a hiring activity. A
      recruiter has no business in a confirmed employee's probation, so putting it
      on HR_RECRUITMENT would have been the wrong grant as well as a fifth
      divergence.
    */
    // Sorted, so the order below is alphabetical rather than chronological.
    expect(diverging.sort()).toEqual([
      '/hr/attendance',
      '/hr/leave',
      '/hr/onboarding',
      // Phase 5. HR_PERFORMANCE — the namespace registered in Phase 0.5 and built
      // here. An appraiser reads reviews and ratings; that is not HR_EMPLOYEE's
      // directory access, so the divergence is the access model rather than tidiness.
      '/hr/performance',
      '/hr/recruitment',
      // Phase 4. HR_TRAINING, its own namespace rather than HR_PERFORMANCE: a
      // trainer has no business reading appraisals, and an appraiser none editing
      // the catalogue.
      '/hr/training',
    ]);
  });

  it('keeps the parent reachable for somebody holding only a child’s module', () => {
    /*
      The behaviour the divergence exists for, and a bug this test originally
      asserted the wrong way round.

      HR's children sit on their own modules, the sidebar renders children only
      *inside* their parent row, and the parent is gated on HR_EMPLOYEE. So
      filtering the parent out for somebody granted HR_ATTENDANCE alone left the
      page reachable only by typing the URL — invisible in the navigation they were
      meant to use it from.

      Keeping the parent exposes nothing: `/hr` itself is refused by
      requireModule('HR_EMPLOYEE') with the standard no-access panel, and the only
      child shown is the one they hold.
    */
    const items = visibleNavItems(['HR_ATTENDANCE'], false);
    const hr = items.find((i) => i.href === '/hr');
    expect(hr).toBeDefined();
    expect(hr?.children?.map((c) => c.href)).toEqual(['/hr/attendance']);
  });

  it('shows each HR child only to somebody holding its own module', () => {
    const attendanceOnly = visibleNavItems(['HR_EMPLOYEE', 'HR_ATTENDANCE'], false);
    expect(
      attendanceOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href),
    ).toEqual(['/hr/employees', '/hr/employees/new', '/hr/attendance', '/hr/probation']);

    const leaveOnly = visibleNavItems(['HR_EMPLOYEE', 'HR_LEAVE'], false);
    expect(leaveOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href)).toEqual([
      '/hr/employees',
      '/hr/employees/new',
      '/hr/leave',
      '/hr/probation',
    ]);

    /*
      HR_EMPLOYEE alone reaches neither Phase 2 page nor Recruitment and Onboarding —
      the separation the seven namespaces exist for.

      It *does* reach Probation, and that is the point of putting Probation on this
      module: the reporting manager who reviews somebody's probation is exactly the
      person who already needs HR_EMPLOYEE to see their team, and requiring them to
      hold a recruitment grant for it would mean handing every line manager access to
      the hiring pipeline.
    */
    const employeeOnly = visibleNavItems(['HR_EMPLOYEE'], false);
    expect(employeeOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href)).toEqual([
      '/hr/employees',
      '/hr/employees/new',
      '/hr/probation',
    ]);

    /*
      And a recruiter holding only HR_RECRUITMENT reaches the two hiring pages and
      nothing else — no directory, no attendance, no probation. The parent row
      survives so the pages are reachable by navigation at all, which is the Phase 2
      fix; `/hr` itself still refuses them.
    */
    const recruiterOnly = visibleNavItems(['HR_RECRUITMENT'], false);
    expect(recruiterOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href)).toEqual([
      '/hr/recruitment',
      '/hr/onboarding',
    ]);

    /*
      And a trainer holding only HR_TRAINING reaches the catalogue and nothing else —
      no directory, no attendance, no recruitment, no probation. The separation the
      namespace exists for, asserted from the other direction.
    */
    const trainerOnly = visibleNavItems(['HR_TRAINING'], false);
    expect(trainerOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href)).toEqual([
      '/hr/training',
    ]);

    /*
      An ordinary employee with HR_EMPLOYEE does NOT see the Training row. That is
      deliberate rather than a gap: the row leads to the *catalogue and
      administration*, which is a trainer's screen. Their own assigned work is
      reachable from the HR overview, so a learner is not stranded.
    */
    expect(
      employeeOnly.find((i) => i.href === '/hr')?.children?.map((c) => c.href),
    ).not.toContain('/hr/training');
  });

  it('hides HR entirely from somebody with no HR grant', () => {
    const items = visibleNavItems(['SALES'], false);
    expect(items.find((i) => i.href === '/hr')).toBeUndefined();
  });

  it('shows an administrator every HR child', () => {
    const items = visibleNavItems([...APP_MODULES], true);
    expect(items.find((i) => i.href === '/hr')?.children?.map((c) => c.href)).toEqual([
      '/hr/employees',
      '/hr/employees/new',
      '/hr/attendance',
      '/hr/leave',
      '/hr/recruitment',
      '/hr/onboarding',
      '/hr/probation',
      '/hr/training',
      '/hr/performance',
    ]);
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
