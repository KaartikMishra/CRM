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
  | 'dispatch'
  | 'billing'
  | 'vendor-invoices'
  | 'post-sales'
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
};

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: 'dashboard', available: true },
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
    available: false,
    module: 'PROCUREMENT',
  },
  {
    label: 'Packing & Dispatch',
    href: '/dispatch',
    icon: 'dispatch',
    available: false,
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
    available: false,
    module: 'VENDOR_INVOICE',
  },
  {
    label: 'Post Sales & Grievance',
    href: '/post-sales',
    icon: 'post-sales',
    available: false,
    module: 'POST_SALES',
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

  return NAV_ITEMS.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (!item.module) return true;
    return granted.has(item.module);
  });
}
