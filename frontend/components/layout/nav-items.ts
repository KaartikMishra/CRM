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
  | 'dispatch'
  | 'billing'
  | 'vendor-invoices'
  | 'post-sales'
  | 'lead-deal'
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

  return NAV_ITEMS.filter(allowed).map((item) => {
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
