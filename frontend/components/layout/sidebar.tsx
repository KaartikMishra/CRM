'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import type { NavItem } from './nav-items';
import { navIcon } from './nav-icons';

/*
  The row styling, named once.

  A submodule row must be the same row as a module row — same height, same
  radius, same hover, same active treatment — and the only way to guarantee that
  is for both to read these strings rather than each repeating them. They are the
  classes the sidebar already used, moved and not changed.
*/
const ROW = 'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors';
const ROW_ACTIVE = 'bg-brass-soft font-medium text-accent';
const ROW_IDLE = 'text-ink-2 hover:bg-surface-2 hover:text-ink';
const ROW_DISABLED = 'flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-faint';

/**
 * Navigation for the whole CRM.
 *
 * The items are decided on the server from the signed-in person's resolved
 * permissions and passed in — a module they cannot reach never reaches the
 * browser at all (§11). Among the items they *can* reach, an unbuilt module
 * stays inert and says "Soon", because a link that looks live and does nothing
 * is worse than an honest label (§54).
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  /*
    Which groups the reader has opened or closed by hand, keyed by parent href.

    Absent means "no opinion", and the group then follows the route — it is open
    while you are inside it. Deriving the default this way rather than storing it
    in state keeps SSR and hydration in agreement: `usePathname` returns the same
    value on both sides, so the first render matches.
  */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const matches = (href: string): boolean =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside
      className={cn(
        'hidden h-full min-h-0 shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[68px]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 shrink-0 items-center border-b border-line', collapsed ? 'justify-center px-3' : 'px-5')}>
        <Link href="/dashboard" aria-label="RoyalStuffs CRM home">
          <Logo collapsed={collapsed} />
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Main">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const Icon = navIcon(item.icon);
            const children = item.children ?? [];
            /*
              A submodule is only ever reachable through its parent, so with the
              rail collapsed to icons there is nowhere to put one. The parent's
              own page stays one click away either way.
            */
            const showChildren = children.length > 0 && !collapsed;
            const childActive = children.some((child) => matches(child.href));
            /*
              The parent claims the highlight for its own pages only. Inside a
              submodule the child carries it, so exactly one row is ever marked
              current and the reader can see which level they are on.
            */
            const active = matches(item.href) && !childActive;
            const open = toggled[item.href] ?? (matches(item.href) || childActive);

            if (!item.available) {
              return (
                <li key={item.href}>
                  <span
                    aria-disabled="true"
                    title={`${item.label} — coming in a later phase`}
                    className={cn(ROW_DISABLED, collapsed && 'justify-center px-0')}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && (
                      <>
                        <span className="truncate">{item.label}</span>
                        <span className="ml-auto text-[10px] uppercase tracking-wider">Soon</span>
                      </>
                    )}
                  </span>
                </li>
              );
            }

            return (
              <li key={item.href}>
                {/*
                  The link and the disclosure are two controls, not one. Making
                  the whole row toggle would cost the parent its own page, and
                  making it navigate-only would leave no way to close a group you
                  are standing in.
                */}
                <div className="flex items-center gap-0.5">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      ROW,
                      'min-w-0 flex-1',
                      collapsed && 'justify-center px-0',
                      active ? ROW_ACTIVE : ROW_IDLE,
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>

                  {showChildren && (
                    <button
                      type="button"
                      onClick={() => setToggled((prev) => ({ ...prev, [item.href]: !open }))}
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'Show'} ${item.label} submodules`}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <ChevronRight
                        className={cn('size-4 transition-transform', open && 'rotate-90')}
                      />
                    </button>
                  )}
                </div>

                {showChildren && open && (
                  <ul className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-3">
                    {children.map((child) => {
                      const ChildIcon = navIcon(child.icon);
                      const childIsActive = matches(child.href);

                      if (!child.available) {
                        return (
                          <li key={child.href}>
                            <span
                              aria-disabled="true"
                              title={`${child.label} — coming in a later phase`}
                              className={ROW_DISABLED}
                            >
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

      <div className="shrink-0 border-t border-line p-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
