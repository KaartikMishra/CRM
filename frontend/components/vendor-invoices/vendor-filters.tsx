'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ANY = '__any__';

/** How long typing must pause before a request goes out. */
const DEBOUNCE_MS = 350;

/**
 * §46 — filters are URL state, not component state.
 *
 * Every change rewrites the query string and lets the server re-query, so the
 * whole vendor list is never pulled to the client to be filtered locally. It
 * also means a filtered view is a shareable link and survives a refresh.
 *
 * Search is debounced, so typing "Devansh" costs one request rather than seven.
 *
 * Any filter change drops every cursor and stack on the page, including the
 * drawer's: a cursor only means something within one result set, so carrying
 * one into a different set would page through the wrong rows.
 */
export function VendorFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(params.get('q') ?? '');

  const apply = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '' || value === ANY) next.delete(key);
      else next.set(key, value);
    }

    // Any filter change invalidates every page position on this route.
    for (const key of ['cursor', 'pages', 'tradeCursor', 'tradePages', 'mapCursor', 'mapPages']) {
      next.delete(key);
    }

    startTransition(() => router.push(`/vendor-invoices?${next}`));
  };

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const id = setTimeout(() => apply({ q: search || null }), DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Keeps the box in step when the URL changes from elsewhere — Clear, the
  // browser's Back button, or a shared link.
  useEffect(() => {
    setSearch(params.get('q') ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('q')]);

  const hasFilters = Boolean(params.get('q') || params.get('isActive'));

  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending || undefined}>
      <div className="relative min-w-56 flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, company, phone or email"
          aria-label="Search vendors"
          className="pl-9"
        />
      </div>

      <Select
        value={params.get('isActive') ?? ANY}
        onValueChange={(value) => apply({ isActive: value })}
      >
        <SelectTrigger className="w-auto min-w-36" aria-label="Filter by status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All vendors</SelectItem>
          <SelectItem value="true">Active only</SelectItem>
          <SelectItem value="false">Archived only</SelectItem>
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearch('');
            startTransition(() => router.push('/vendor-invoices'));
          }}
        >
          <X className="size-4" />
          Clear
        </Button>
      )}
    </div>
  );
}
