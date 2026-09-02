'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import type { NavItem } from './nav-items';
import { navIcon } from './nav-icons';

/**
 * Navigation below the desktop breakpoint.
 *
 * A drawer rather than a bottom bar, because the CRM will eventually carry
 * eight modules and a bottom bar stops working past four. It renders the same
 * permission-filtered items the sidebar does, so the two never disagree about
 * what this person can reach.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Navigating should dismiss the drawer.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>

      <SheetContent side="left">
        <SheetTitle>Navigation</SheetTitle>

        <div className="flex h-16 items-center border-b border-line px-5">
          <Link href="/dashboard" aria-label="RoyalStuffs CRM home">
            <Logo size={30} />
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto p-3" aria-label="Main">
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = navIcon(item.icon);

              if (!item.available) {
                return (
                  <li key={item.href}>
                    <span
                      aria-disabled="true"
                      className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2.5 text-sm text-faint"
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wider">Soon</span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                      active
                        ? 'bg-brass-soft font-medium text-accent'
                        : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
