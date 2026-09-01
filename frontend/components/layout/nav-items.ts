import {
  Boxes,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Receipt,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Future CRM modules: visible for orientation, never pretending to work. */
  available: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, available: true },
  { label: 'Product Enquiry', href: '/product-enquiry', icon: ClipboardList, available: true },
  { label: 'Sales', href: '/sales', icon: ShoppingCart, available: true },
  { label: 'Purchase & Procurement', href: '/procurement', icon: Boxes, available: false },
  { label: 'Packing & Dispatch', href: '/dispatch', icon: Package, available: false },
  { label: 'Customer Billing', href: '/billing', icon: Receipt, available: false },
  { label: 'Vendor Invoices', href: '/vendor-invoices', icon: FileText, available: false },
  { label: 'Post Sales & Grievance', href: '/post-sales', icon: LifeBuoy, available: false },
];
