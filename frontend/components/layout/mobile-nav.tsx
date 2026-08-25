'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-items';

/**
 * On small screens the sidebar is replaced by a bottom bar carrying only the
 * modules that actually work — a tablet or phone should not scroll past six
 * disabled links to reach the one live screen.
 */
export function MobileNav() {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => i.available);

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-30 flex shrink-0 border-t border-line bg-surface lg:hidden"
    >
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center gap-1 px-2 py-2.5 text-[11px] transition-colors',
              active ? 'text-accent' : 'text-muted',
            )}
          >
            <Icon className="size-4" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
