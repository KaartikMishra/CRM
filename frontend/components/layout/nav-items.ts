import type { AppModule } from '@rs/shared';

/**
 * The navigation table — plain data only.
 *
 * This file deliberately imports no React and no icon components. The filtered
 * item list is built on the server and handed to the Sidebar and MobileNav,
 * which are Client Components, and React can only serialize plain values across
 * that boundary. A `LucideIcon` is a function, so holding one here would make
 * every item unserializable and the layout would fail at runtime.
 *
 * Each item therefore names its icon with a string key, and the client resolves
 * that key to a real component through the registry in `nav-icons.tsx`.
 */

/** Icon keys, kept in step with the registry in nav-icons.tsx. */
export type NavIconKey =
  | 'dashboard'
  | 'product-enquiry'
  | 'sales'
  | 'procurement'
  | 'procurement-clock'
  | 'rs-products'
  | 'inventory-alerts'
  | 'dispatch'
  | 'billing'
  | 'vendor-invoices'
  | 'post-sales'
  | 'lead-deal'
  | 'customers'
  | 'hr'
  | 'attendance'
  | 'leave'
  | 'recruitment'
  | 'onboarding'
  | 'probation'
  | 'training'
  | 'performance'
  | 'payroll'
  | 'users';

export type NavItem = {
  label: string;
  href: string;
  /** Resolved to a component on the client; see nav-icons.tsx. */
  icon: NavIconKey;
  /** Future CRM modules: visible for orientation, never pretending to work. */
  available: boolean;
  /**
   * The module this item gates on. Absent means "not module-scoped" —
   * Dashboard, which everyone signed in can reach.
   */
  module?: AppModule;
  /** Administrator-only items, which sit outside the seven CRM modules. */
  adminOnly?: boolean;
  /**
   * Submodules revealed when the parent is expanded.
   *
   * Nested rather than flattened with a `parent` pointer, and that is the whole
   * point: a submodule is unreachable from the top level because it is not *in*
   * the top level. `NAV_ITEMS.map(i => i.href)` still lists exactly the ten CRM
   * destinations, so nothing can accidentally promote a submodule to a sidebar
   * module of its own — the shape refuses it rather than a convention asking
   * nicely.
   *
   * A child is an ordinary NavItem: same icon registry, same `available` flag,
   * same module gating. It carries no separate AppModule of its own — a
   * submodule inherits its parent's access, so Procurement Clock is reachable
   * by exactly the people who can reach Purchase & Procurement, and granting or
   * revoking PROCUREMENT moves both together.
   */
  children?: NavItem[];
};

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: 'dashboard', available: true },
  {
    label: 'Create Lead / Deal',
    href: '/create-lead',
    icon: 'lead-deal',
    available: true,
    module: 'LEAD_DEAL',
    /*
      The analytics board sits under the capture form, sharing its module: one
      LEAD_DEAL grant reaches both, exactly as Procurement Clock sits under
      Purchase & Procurement.
    */
    children: [
      {
        label: 'Lead / Deal Analytics',
        href: '/leads',
        icon: 'lead-deal',
        available: true,
        module: 'LEAD_DEAL',
      },
    ],
  },
  {
    label: 'Product Enquiry',
    href: '/product-enquiry',
    icon: 'product-enquiry',
    available: true,
    module: 'PRODUCT_ENQUIRY',
  },
  { label: 'Sales', href: '/sales', icon: 'sales', available: true, module: 'SALES' },
  /*
    All Customers sits beside Sales rather than under it: a customer is a master
    record that enquiries, leads and orders all point at, not a section of any
    one of them. Its own module, so reading a customer's purchase history and
    contact details is a separate grant from filing an enquiry — which is what
    gates customer creation today.
  */
  { label: 'All Customers', href: '/customers', icon: 'customers', available: true, module: 'CUSTOMERS' },
  {
    label: 'Purchase & Procurement',
    href: '/procurement',
    icon: 'procurement',
    available: true,
    module: 'PROCUREMENT',
    /*
      The parent keeps its own route. Expanding it reveals what sits under it;
      it does not replace the page that is already there, so every existing
      Purchase & Procurement link, bookmark and redirect still lands where it
      always did.
    */
    children: [
      {
        label: 'Procurement Clock',
        href: '/procurement/clock',
        icon: 'procurement-clock',
        available: true,
        module: 'PROCUREMENT',
      },
    ],
  },
  {
    label: 'RS Products',
    href: '/rs-products',
    icon: 'rs-products',
    available: true,
    module: 'RS_PRODUCTS',
    children: [
      /*
        Inventory Alerts sits under RS Products rather than beside it: it
        watches RS Products stock and reuses the same module permission, so a
        separate top-level entry would imply a separate area of the CRM.

        Same `module`, so visibility follows the same resolved permission —
        somebody without RS_PRODUCTS sees neither.
      */
      {
        label: 'Inventory Alerts',
        href: '/rs-products/alerts',
        icon: 'inventory-alerts',
        available: true,
        module: 'RS_PRODUCTS',
      },
    ],
  },
  {
    label: 'Packing & Dispatch',
    href: '/dispatch',
    icon: 'dispatch',
    available: true,
    module: 'PACKING_DISPATCH',
  },
  {
    label: 'Customer Billing',
    href: '/billing',
    icon: 'billing',
    available: false,
    module: 'CUSTOMER_BILLING',
  },
  {
    label: 'Vendor Invoices',
    href: '/vendor-invoices',
    icon: 'vendor-invoices',
    available: true,
    module: 'VENDOR_INVOICE',
  },
  {
    label: 'Post Sales & Grievance',
    href: '/post-sales',
    icon: 'post-sales',
    available: true,
    module: 'POST_SALES',
    /*
      Overview, the board and one person's queue. All three share the module, so
      one POST_SALES grant reaches every row — exactly as Procurement Clock sits
      under Purchase & Procurement and the analytics board under Create Lead.

      Deliberately only these: Returns, Replacements, Refunds, Exchanges,
      Warranty, CSAT, Reports and Settings are later phases, and a nav entry for
      an unbuilt page is a promise the module cannot keep.
    */
    children: [
      {
        label: 'All Cases',
        href: '/post-sales/cases',
        icon: 'post-sales',
        available: true,
        module: 'POST_SALES',
      },
      {
        label: 'My Cases',
        href: '/post-sales/cases?mine=true',
        icon: 'post-sales',
        available: true,
        module: 'POST_SALES',
      },
      {
        label: 'New Case',
        href: '/post-sales/cases/new',
        icon: 'post-sales',
        available: true,
        module: 'POST_SALES',
      },
    ],
  },
  {
    label: 'HR & Workforce',
    href: '/hr',
    icon: 'hr',
    available: true,
    module: 'HR_EMPLOYEE',
    /*
      The directory and the create form, both on HR_EMPLOYEE — which is what the
      "every child shares its parent's module" invariant requires, and is correct
      here rather than merely convenient: one HR_EMPLOYEE grant should reach every
      row under this parent.

      Departments and Designations are deliberately NOT children. They are governed
      by HR_ADMIN, a different grant for a different job: an HR coordinator who
      maintains employee records has no reason to restructure the company. Putting
      them here would either break that invariant or quietly imply one grant covers
      both. They are reached from the HR overview instead, which shows them only to
      somebody who actually holds HR_ADMIN.

      Payroll and Performance are later phases and have no entry: a nav row for an
      unbuilt page is a promise the module cannot keep. Attendance and Leave arrived
      in Phase 2; Recruitment, Onboarding and Probation in Phase 3 — see the notes
      beside each.
    */
    children: [
      {
        label: 'Employee Directory',
        href: '/hr/employees',
        icon: 'hr',
        available: true,
        module: 'HR_EMPLOYEE',
      },
      {
        label: 'Add Employee',
        href: '/hr/employees/new',
        icon: 'hr',
        available: true,
        module: 'HR_EMPLOYEE',
      },
      /*
        Phase 2. These are the first children that do NOT share their parent's
        module, and that is deliberate rather than an oversight.

        HR is seven permission namespaces, not one: the brief requires Attendance
        gated on HR_ATTENDANCE and Leave on HR_LEAVE, so that an administrator can
        grant somebody attendance access without also handing them the employee
        directory. Forcing them onto HR_EMPLOYEE to satisfy a "children share the
        parent's module" rule would make one grant open all three — exactly the
        conflation the seven namespaces exist to prevent.

        `visibleNavItems` filters children by their own module, so somebody holding
        only HR_ATTENDANCE sees Attendance and neither employee row. It also keeps
        the parent row whenever any child survives — see the note on that function.
        Without that, a grant for HR_ATTENDANCE alone would leave the page
        reachable only by typing the URL, because the sidebar renders children
        inside their parent.
      */
      {
        label: 'Attendance',
        href: '/hr/attendance',
        icon: 'attendance',
        available: true,
        module: 'HR_ATTENDANCE',
      },
      {
        label: 'Leave',
        href: '/hr/leave',
        icon: 'leave',
        available: true,
        module: 'HR_LEAVE',
      },
      /*
        Phase 3. Recruitment and Onboarding on HR_RECRUITMENT; Probation on
        HR_EMPLOYEE.

        The split is the point. Recruitment and onboarding are the hiring team's
        work — a recruiter needs both and needs neither the directory nor
        attendance. Probation is different in kind: it is a fact about somebody's
        *employment*, reviewed by their reporting manager, and a recruiter has no
        business in a confirmed employee's probation. So it sits with the employee
        records rather than with hiring, which also means the manager who reviews it
        reaches it with the HR_EMPLOYEE grant they already need to see their team.

        No new AppModule. HR_RECRUITMENT has existed since Phase 0.5 precisely so
        this phase could be built against a permission model that was already real,
        and it leaves MODULES_WITHOUT_NAVIGATION here.
      */
      {
        label: 'Recruitment',
        href: '/hr/recruitment',
        icon: 'recruitment',
        available: true,
        module: 'HR_RECRUITMENT',
      },
      {
        label: 'Onboarding',
        href: '/hr/onboarding',
        icon: 'onboarding',
        available: true,
        module: 'HR_RECRUITMENT',
      },
      {
        label: 'Probation',
        href: '/hr/probation',
        icon: 'probation',
        available: true,
        module: 'HR_EMPLOYEE',
      },
      /*
        Phase 4. Training sits on HR_TRAINING — its own namespace, not
        HR_PERFORMANCE — because a trainer who builds a course and signs off a
        practical has no business reading appraisals, and an appraiser has no reason
        to edit the catalogue.

        The row is gated on HR_TRAINING:VIEW, which means a learner with no training
        grant will not see it. That is correct and not a gap: their own assigned
        work lives under My Learning, reachable from the HR overview, and the
        training *catalogue* is what this row leads to.
      */
      {
        label: 'Training',
        href: '/hr/training',
        icon: 'training',
        available: true,
        module: 'HR_TRAINING',
      },
      /*
        Phase 5. Performance sits on HR_PERFORMANCE, the namespace registered in
        Phase 0.5 and left unbuilt until now.

        The row is gated on HR_PERFORMANCE:VIEW, so an employee with no performance
        grant will not see it. That is correct and not a gap — the same reasoning as
        the Training row above: their own appraisal lives under My Review, reachable
        from the HR overview and from the performance dashboard, and what this row
        leads to is the administrative surface (every cycle, every review, the
        reports).

        Everybody is appraised, so the *pages* run on an employee floor —
        HR_PERFORMANCE:VIEW or HR_EMPLOYEE:VIEW, mirroring the backend's own route
        guard. Gating the sidebar row that widely would put an administrative
        heading in front of every employee in the company.
      */
      {
        label: 'Performance',
        href: '/hr/performance',
        icon: 'performance',
        available: true,
        module: 'HR_PERFORMANCE',
      },
      /*
        Phase 6. Payroll sits on HR_PAYROLL, the namespace registered in Phase 0.5
        alongside the others and left unbuilt until now.

        The row is gated on HR_PAYROLL:VIEW, which is deliberately narrower than the
        pages behind it. Everybody is paid, so three self-service surfaces — the
        dashboard, My Payslips and one payslip — run on an employee floor of
        HR_PAYROLL:VIEW or HR_EMPLOYEE:VIEW, mirroring the backend's own route
        guard. Gating the sidebar row that widely would put an administrative
        Payroll heading in front of every employee in the company; their own
        payslips are reachable from the HR overview and from My Payslips instead.

        This is the sharpest case of that pattern in the system, because what the
        row leads to is every salary in the business.
      */
      {
        label: 'Payroll',
        href: '/hr/payroll',
        icon: 'payroll',
        available: true,
        module: 'HR_PAYROLL',
      },
    ],
  },
  { label: 'User Management', href: '/users', icon: 'users', available: true, adminOnly: true },
];

/**
 * §11 — the items one person may see.
 *
 * A module the person cannot reach is not rendered at all, rather than rendered
 * disabled: "Soon" means the module is unbuilt, and using it for "you are not
 * allowed" would tell two different stories with one word.
 */
export function visibleNavItems(
  modules: readonly AppModule[],
  isAdmin: boolean,
): NavItem[] {
  const granted = new Set(modules);

  const allowed = (item: NavItem): boolean => {
    if (item.adminOnly) return isAdmin;
    if (!item.module) return true;
    return granted.has(item.module);
  };

  /*
    A parent is kept when it is itself granted OR any of its children are.

    The second half matters from HR Phase 2 onwards, and its absence was a real
    bug: HR's children sit on their own modules (HR_ATTENDANCE, HR_LEAVE), the
    sidebar renders children only *inside* their parent row, and the parent is
    gated on HR_EMPLOYEE. So a USER granted HR_ATTENDANCE alone saw nothing at all
    — the page worked by typing the URL and was unreachable by navigation.

    Keeping the parent exposes no page the person may not open: its own link is
    `/hr`, which `requireModule('HR_EMPLOYEE')` refuses with the standard
    no-access panel, and every child shown is one they hold. A visible branch they
    can partly use beats an invisible one they cannot find.
  */
  const visible = (item: NavItem): boolean =>
    allowed(item) || (item.children ?? []).some(allowed);

  return NAV_ITEMS.filter(visible).map((item) => {
    if (!item.children) return item;

    /*
      Children are filtered by the same rule, not waved through because the
      parent passed. Today every submodule shares its parent's module so the
      result is the same either way — but the day one does not, the sidebar must
      not offer a link the API will refuse.

      A new object rather than a mutation: NAV_ITEMS is module-level state and
      filtering it in place would leak one person's access into the next
      request's list.
    */
    return { ...item, children: item.children.filter(allowed) };
  });
}
