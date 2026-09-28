'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import type { NavItem } from './nav-items';
import { navIcon } from './nav-icons';

/*
  The drawer's own row metrics — taller than the desktop rail's, as they already
  were, because a thumb needs more than a cursor. Named once so a submodule row
  cannot drift from a module row.
*/
const ROW = 'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors';
const ROW_ACTIVE = 'bg-brass-soft font-medium text-accent';
const ROW_IDLE = 'text-ink-2 hover:bg-surface-2 hover:text-ink';
const ROW_DISABLED =
  'flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2.5 text-sm text-faint';

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
  /* Groups opened or closed by hand; absent means "follow the route". */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  // Navigating should dismiss the drawer.
  useEffect(() => setOpen(false), [pathname]);

  const matches = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>

      <SheetContent side="left">
        <SheetTitle>Navigation</SheetTitle>

        <div className="flex h-16 shrink-0 items-center border-b border-line px-5">
          <Link href="/dashboard" aria-label="RoyalStuffs CRM home">
            <Logo size={30} />
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Main">
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const Icon = navIcon(item.icon);
              const children = item.children ?? [];
              const hasChildren = children.length > 0;
              const childActive = children.some((child) => matches(child.href));
              // The parent keeps the highlight for its own pages; inside a
              // submodule the child carries it.
              const active = matches(item.href) && !childActive;
              const expanded = toggled[item.href] ?? (matches(item.href) || childActive);

              if (!item.available) {
                return (
                  <li key={item.href}>
                    <span aria-disabled="true" className={ROW_DISABLED}>
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wider">Soon</span>
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <div className="flex items-center gap-0.5">
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(ROW, 'min-w-0 flex-1', active ? ROW_ACTIVE : ROW_IDLE)}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>

                    {hasChildren && (
                      <button
                        type="button"
                        onClick={() =>
                          setToggled((prev) => ({ ...prev, [item.href]: !expanded }))
                        }
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Hide' : 'Show'} ${item.label} submodules`}
                        className="grid size-9 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        <ChevronRight
                          className={cn('size-4 transition-transform', expanded && 'rotate-90')}
                        />
                      </button>
                    )}
                  </div>

                  {hasChildren && expanded && (
                    <ul className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-3">
                      {children.map((child) => {
                        const ChildIcon = navIcon(child.icon);
                        const childIsActive = matches(child.href);

                        if (!child.available) {
                          return (
                            <li key={child.href}>
                              <span aria-disabled="true" className={ROW_DISABLED}>
                                <ChildIcon className="size-4 shrink-0" />
                                <span className="truncate">{child.label}</span>
                                <span className="ml-auto text-[10px] uppercase tracking-wider">
                                  Soon
                                </span>
                              </span>
                            </li>
                          );
                        }

                        return (
                          <li key={child.href}>
                            <Link
                              href={child.href}
                              aria-current={childIsActive ? 'page' : undefined}
                              className={cn(ROW, childIsActive ? ROW_ACTIVE : ROW_IDLE)}
                            >
                              <ChildIcon className="size-4 shrink-0" />
                              <span className="truncate">{child.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
