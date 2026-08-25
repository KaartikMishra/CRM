'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Search } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NAV_ITEMS } from './nav-items';
import { LogoMark } from './logo';
import { MobileNav } from './mobile-nav';

type Props = {
  name: string;
  employeeId: string;
  role: 'ADMIN' | 'USER';
  initials: string;
  onSignOut: () => void;
};

/** Derived from the path, so it never disagrees with where you actually are. */
function useCrumbs(): { label: string; href?: string }[] {
  const pathname = usePathname();
  const nav = NAV_ITEMS.find(
    (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
  );
  if (!nav) return [];

  const rest = pathname.slice(nav.href.length).split('/').filter(Boolean);
  if (rest.length === 0) return [{ label: nav.label }];

  const leaf = rest[0] === 'new' ? 'New Enquiry' : 'Details';
  return [{ label: nav.label, href: nav.href }, { label: leaf }];
}

export function Topbar({ name, employeeId, role, initials, onSignOut }: Props) {
  const crumbs = useCrumbs();

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-4 border-b border-line bg-surface/95 px-4 backdrop-blur sm:px-6">
      <div className="flex items-center gap-1 lg:hidden">
        <MobileNav />
        <Link href="/dashboard" aria-label="RoyalStuffs CRM home">
          <LogoMark size={30} />
        </Link>
      </div>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 sm:block">
        <ol className="flex items-center gap-2 text-sm">
          {crumbs.map((crumb, index) => (
            <li key={crumb.label} className="flex items-center gap-2">
              {index > 0 && <span className="text-faint">/</span>}
              {crumb.href ? (
                <Link href={crumb.href} className="text-muted transition-colors hover:text-ink">
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-ink">{crumb.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        {/* Global search is not wired to an endpoint yet, so it is not offered
            as a working control. The enquiry list has its own live search. */}
        <Button variant="ghost" size="sm" asChild className="hidden md:inline-flex">
          <Link href="/product-enquiry">
            <Search className="size-4" />
            Find an enquiry
          </Link>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-surface-2"
              aria-label="Account menu"
            >
              <Avatar>
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-sm font-medium text-ink">{name}</span>
                <span className="block text-xs text-muted tabular">{employeeId}</span>
              </span>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <span className="block text-sm font-medium text-ink">{name}</span>
              <span className="mt-0.5 block text-xs text-muted tabular">{employeeId}</span>
              <Badge variant={role === 'ADMIN' ? 'accent' : 'neutral'} className="mt-2">
                {role}
              </Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>
    </header>
  );
}
