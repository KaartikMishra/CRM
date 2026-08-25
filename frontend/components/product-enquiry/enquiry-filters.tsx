'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Search, X } from 'lucide-react';
import { ENQUIRY_EFFICIENCIES, ENQUIRY_STATUSES } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { label } from '@/lib/format';

type Assignee = { id: string; name: string };

const ANY = '__any__';

/**
 * §46 — filters are URL state, not component state.
 *
 * Every change rewrites the query string and lets the server re-query, so the
 * whole dataset is never pulled to the client to be filtered locally. It also
 * means a filtered view is a shareable link and survives a refresh.
 */
export function EnquiryFilters({ assignees }: { assignees: Assignee[] }) {
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
    // Any filter change invalidates the current page position.
    next.delete('cursor');
    startTransition(() => router.push(`/product-enquiry?${next}`));
  };

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (search === current) return;
    const id = setTimeout(() => apply({ q: search || null }), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const active =
    params.get('status') ?? params.get('assignedToId') ?? params.get('efficiency') ?? params.get('q');

  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending || undefined}>
      <div className="relative min-w-56 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search enquiry no, customer, product"
          aria-label="Search enquiries"
          className="pl-9"
        />
      </div>

      <Select
        value={params.get('status') ?? ANY}
        onValueChange={(v) => apply({ status: v })}
      >
        <SelectTrigger className="w-auto min-w-36" aria-label="Filter by status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All statuses</SelectItem>
          {ENQUIRY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {label(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={params.get('assignedToId') ?? ANY}
        onValueChange={(v) => apply({ assignedToId: v })}
      >
        <SelectTrigger className="w-auto min-w-36" aria-label="Filter by assignee">
          <SelectValue placeholder="Towards" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Anyone</SelectItem>
          {assignees.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={params.get('efficiency') ?? ANY}
        onValueChange={(v) => apply({ efficiency: v })}
      >
        <SelectTrigger className="w-auto min-w-36" aria-label="Filter by efficiency">
          <SelectValue placeholder="Efficiency" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any outcome</SelectItem>
          {ENQUIRY_EFFICIENCIES.map((e) => (
            <SelectItem key={e} value={e}>
              {label(e)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearch('');
            startTransition(() => router.push('/product-enquiry'));
          }}
        >
          <X className="size-4" />
          Clear
        </Button>
      )}
    </div>
  );
}
