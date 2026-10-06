import type { Metadata } from 'next';
import { Search } from 'lucide-react';
import {
  DEAL_STATUSES,
  DEAL_STATUS_LABELS,
  LEAD_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_PROMPTNESS_LABELS,
  LEAD_PROMPTNESS_RATINGS,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { LeadTable } from '@/components/leads/lead-table';
import { fetchLeadAnalytics } from '@/lib/lead-api';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Lead / Deal Analytics' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const ALLOCATIONS = [
  { value: 'SELF', label: 'Self' },
  { value: 'OTHER_USER', label: 'Other user' },
  { value: 'UNASSIGNED', label: 'Unassigned' },
] as const;

export default async function LeadsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;

  const access = await requireModule('LEAD_DEAL');
  if (!access.allowed) return <NoModuleAccess module="LEAD_DEAL" />;

  const filters = {
    q: first(params.q),
    dealStatus: first(params.dealStatus),
    channel: first(params.channel),
    promptness: first(params.promptness),
    allocation: first(params.allocation),
  };

  const result = await fetchLeadAnalytics({
    ...filters,
    cursor: first(params.cursor),
    limit: '25',
  });

  // Whether anything is narrowing the list, so "no results" can say which.
  const filtered = Object.values(filters).some((v) => v !== undefined && v !== '');

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="Sales"
          title="Lead / Deal Analytics"
          description="Every lead, who owns it, how promptly it is being worked, and what it is worth."
        />

        {/* A GET form submits only its own named inputs, so `cursor` is dropped
            on every search — which is right: a cursor from one result set is
            meaningless in another, so filtering returns to the first page by
            construction rather than by a reset written somewhere. */}
        <form className="flex flex-wrap items-end gap-2" action="/leads">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder="Search customer, phone, email or source note"
              className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>

          <Select name="dealStatus" label="Deal status" value={filters.dealStatus}>
            {DEAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {DEAL_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>

          <Select name="channel" label="Channel" value={filters.channel}>
            {LEAD_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {LEAD_CHANNEL_LABELS[c]}
              </option>
            ))}
          </Select>

          <Select name="promptness" label="Promptness" value={filters.promptness}>
            {LEAD_PROMPTNESS_RATINGS.map((r) => (
              <option key={r} value={r}>
                {LEAD_PROMPTNESS_LABELS[r]}
              </option>
            ))}
          </Select>

          <Select name="allocation" label="Allocation" value={filters.allocation}>
            {ALLOCATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>

          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>
      </ContentPageHeader>

      <ContentRegion>
        {!result.success ? (
          <ErrorMessage message={result.message} code={result.code} />
        ) : (
          <>
            <LeadTable leads={result.data.leads} filtered={filtered} />

            {result.data.nextCursor && (
              <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
                <span className="text-xs text-muted">
                  {result.data.narrowedByDerivedFilter
                    ? /*
                        Promptness, allocation and follow-up are computed rather
                        than stored, so a filtered page is assembled from a
                        bounded scan and can hold fewer rows than its limit
                        without the list having ended. Said plainly, rather than
                        letting a short page imply there is nothing more.
                      */
                      'Filtered on a calculated field — more may follow.'
                    : 'More leads follow.'}
                </span>
                <Button asChild variant="outline" size="sm">
                  <a href={nextHref(filters, result.data.nextCursor)}>Next page</a>
                </Button>
              </div>
            )}
          </>
        )}
      </ContentRegion>
    </ContentPage>
  );
}

/** Carries the active filters onto the next page, so paging keeps them. */
function nextHref(filters: Record<string, string | undefined>, cursor: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  query.set('cursor', cursor);
  return `/leads?${query}`;
}

/**
 * One filter dropdown, with an "All" option that clears it.
 *
 * A plain select rather than the shadcn component: this lives inside a GET form
 * and submits its own value, which is what keeps the whole toolbar working with
 * no client-side state at all.
 */
function Select({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ''}
        className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
      >
        <option value="">All</option>
        {children}
      </select>
    </label>
  );
}
