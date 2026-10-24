import {
  BookUser,
  Boxes,
  Sparkles,
  ClipboardList,
  CircleDashed,
  Clock,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Receipt,
  ShoppingCart,
  Tags,
  CalendarCheck,
  CalendarDays,
  UserPlus,
  UserCheck,
  Search,
  GraduationCap,
  Gauge,
  Wallet,
  UserRound,
  Users,
  TriangleAlert,
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
  'procurement-clock': Clock,
  'rs-products': Tags,
  'inventory-alerts': TriangleAlert,
  dispatch: Package,
  'lead-deal': Sparkles,
  billing: Receipt,
  'vendor-invoices': FileText,
  'post-sales': LifeBuoy,
  /*
    A directory of people, distinct from `users` (Users) which is the staff
    admin screen and from `hr` (UserRound). Each nav key must map to its own
    glyph — the icon registry test asserts it — so these three stay apart.
  */
  customers: BookUser,
  hr: UserRound,
  attendance: CalendarCheck,
  leave: CalendarDays,
  /*
    Phase 3. A magnifier for recruitment (searching for people), a plus for
    onboarding (adding one), a tick for probation (confirming one) — three
    distinguishable glyphs, because all three sit in the same expanded HR row and
    three variations of a person outline would be indistinguishable at 16px.
  */
  recruitment: Search,
  onboarding: UserPlus,
  probation: UserCheck,
  /* Phase 4. A mortarboard — unmistakably learning, and distinct from the three
     person-outline glyphs already in the expanded HR row. */
  training: GraduationCap,
  /* Phase 5. A gauge — measurement rather than learning, so it reads as distinct
     from the mortarboard beside it. */
  performance: Gauge,
  /* Phase 6. A wallet — money, which nothing else in the sidebar represents, and
     deliberately not a banknote or currency glyph: this module computes pay, it
     does not move it. */
  payroll: Wallet,
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
