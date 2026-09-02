'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from './logo';
import type { NavItem } from './nav-items';
import { navIcon } from './nav-icons';

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

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[68px]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center border-b border-line', collapsed ? 'justify-center px-3' : 'px-5')}>
        <Link href="/dashboard" aria-label="RoyalStuffs CRM home">
          <Logo collapsed={collapsed} />
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
                    title={`${item.label} — coming in a later phase`}
                    className={cn(
                      'flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-faint',
                      collapsed && 'justify-center px-0',
                    )}
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
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    collapsed && 'justify-center px-0',
                    active
                      ? 'bg-brass-soft font-medium text-accent'
                      : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line p-3">
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
