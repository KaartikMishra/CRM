import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Search as SearchIcon } from 'lucide-react';
import {
  POST_SALES_CASE_STATUSES,
  POST_SALES_CASE_STATUS_LABELS,
  POST_SALES_CASE_TYPES,
  POST_SALES_CASE_TYPE_LABELS,
  POST_SALES_COMMUNICATION_CHANNELS,
  POST_SALES_COMMUNICATION_CHANNEL_LABELS,
  POST_SALES_ISSUE_CATEGORIES,
  POST_SALES_ISSUE_CATEGORY_LABELS,
  POST_SALES_PRIORITIES,
  POST_SALES_PRIORITY_LABELS,
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
import { CaseTable } from '@/components/post-sales/case-table';
import { fetchPostSalesCases } from '@/lib/post-sales-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Post Sales Cases' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function PostSalesCasesPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;

  const access = await requireModule('POST_SALES');
  if (!access.allowed) return <NoModuleAccess module="POST_SALES" />;

  const canCreate = can(access.user, 'POST_SALES', 'CREATE');

  const filters = {
    q: first(params.q),
    status: first(params.status),
    priority: first(params.priority),
    caseType: first(params.caseType),
    issueCategory: first(params.issueCategory),
    channel: first(params.channel),
    from: first(params.from),
    to: first(params.to),
    /*
      `mine` carries no id. The server resolves it against the authenticated user,
      so the My Cases link cannot be edited into somebody else's queue.
    */
    mine: first(params.mine),
  };

  const result = await fetchPostSalesCases({
    ...filters,
    cursor: first(params.cursor),
    limit: '25',
  });

  const filtered = Object.values(filters).some((v) => v !== undefined && v !== '');
  const mine = filters.mine === 'true';

  return (
    <ContentPage>
      <ContentPageHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            eyebrow="Post Sales & Grievance"
            title={mine ? 'My Cases' : 'All Cases'}
            description={
              mine
                ? 'Every open case assigned to you.'
                : 'Every complaint, question and request raised after a sale.'
            }
          />

          {canCreate && (
            <Button asChild size="sm">
              <Link href="/post-sales/cases/new">
                <Plus className="size-4" />
                New case
              </Link>
            </Button>
          )}
        </div>

        {/*
          A GET form submits only its own named inputs, so `cursor` is dropped on
          every search — which is right: a cursor from one result set is meaningless
          in another, so filtering returns to the first page by construction.
          `mine` rides along as a hidden input so My Cases keeps its scope.
        */}
        <form className="flex flex-wrap items-end gap-2" action="/post-sales/cases">
          {mine && <input type="hidden" name="mine" value="true" />}

          <label className="relative min-w-[240px] flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder="Search case id, customer, phone, order or product"
              className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>

          <Select name="status" label="Status" value={filters.status}>
            {POST_SALES_CASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {POST_SALES_CASE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>

          <Select name="priority" label="Priority" value={filters.priority}>
            {POST_SALES_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {POST_SALES_PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>

          <Select name="caseType" label="Case type" value={filters.caseType}>
            {POST_SALES_CASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {POST_SALES_CASE_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>

          <Select name="issueCategory" label="Issue" value={filters.issueCategory}>
            {POST_SALES_ISSUE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {POST_SALES_ISSUE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>

          <Select name="channel" label="Channel" value={filters.channel}>
            {POST_SALES_COMMUNICATION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {POST_SALES_COMMUNICATION_CHANNEL_LABELS[c]}
              </option>
            ))}
          </Select>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">From</span>
            <input
              type="date"
              name="from"
              defaultValue={filters.from ?? ''}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">To</span>
            <input
              type="date"
              name="to"
              defaultValue={filters.to ?? ''}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>

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
            <CaseTable cases={result.data.cases} filtered={filtered} />

            {result.data.nextCursor && (
              <div className="flex justify-end pt-3">
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

/** Carries every active filter onto the next page, so paging keeps its scope. */
function nextHref(filters: Record<string, string | undefined>, cursor: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  query.set('cursor', cursor);
  return `/post-sales/cases?${query}`;
}

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
