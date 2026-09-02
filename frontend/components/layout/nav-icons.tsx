import {
  Boxes,
  ClipboardList,
  CircleDashed,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Receipt,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { NavIconKey } from './nav-items';

/**
 * Where a nav item's icon key becomes a real component.
 *
 * The icons cannot live on the item objects themselves: those are built in a
 * Server Component and passed to the Client sidebar, and React can only
 * serialize plain values across that boundary — a component is a function.
 * Keeping the lookup here means the components are imported by the client
 * bundle that renders them, which is where they were always going to be needed.
 *
 * The same icons as before, unchanged.
 */
const ICONS: Record<NavIconKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  'product-enquiry': ClipboardList,
  sales: ShoppingCart,
  procurement: Boxes,
  dispatch: Package,
  billing: Receipt,
  'vendor-invoices': FileText,
  'post-sales': LifeBuoy,
  users: Users,
};

/**
 * Resolves an icon key, falling back to a neutral placeholder.
 *
 * A key with no entry is a bug, but it is not worth destroying the whole
 * layout over: a missing icon should cost the person one glyph, not their
 * navigation. The fallback is deliberately plain so the gap is visible.
 */
export function navIcon(key: NavIconKey): LucideIcon {
  return ICONS[key] ?? CircleDashed;
}
