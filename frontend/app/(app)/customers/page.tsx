import type { Metadata } from 'next';
import { CopyCheck, Download, Search } from 'lucide-react';
import { CUSTOMER_TYPES } from '@rs/shared';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  CustomerDirectoryPagination,
  CustomerDirectoryTable,
} from '@/components/customers/customer-directory-table';
import {
  fetchCustomerAnalytics,
  fetchCustomerDirectory,
  readPagination,
} from '@/lib/customer-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'All Customers' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Only the parameters the API actually accepts.
 *
 * Built from `customerDirectoryQuerySchema`, so a stray search parameter never
 * reaches the backend to be rejected with a 422, and every filter survives
 * sorting and paging because the links carry this same set forward.
 */
const PASSTHROUGH = [
  'q',
  'type',
  'state',
  'country',
  'source',
  'sourceTouch',
  'hasOrders',
  'isRepeat',
  'duplicatesOnly',
  'minPurchaseValue',
  'maxPurchaseValue',
  'purchasedFrom',
  'purchasedTo',
  'sort',
  'direction',
  'cursor',
  'page',
  'limit',
] as const;

/**
 * All Customers — the directory.
 *
 * Gated on CUSTOMERS VIEW. The API enforces the same on its own authority; this
 * only decides what is worth rendering, because a hidden link has never been
 * what keeps anyone out.
 *
 * ### Why the money figures are not computed here
 *
 * Every purchase value and order count arrives already derived by the backend
 * through Sales' own `toMoney`. The page renders them and nothing else — a
 * figure recomputed in the browser could disagree with the invoice the customer
 * was sent, which is the one thing these numbers must never do.
 */
export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const access = await requireModule('CUSTOMERS');
  if (!access.allowed) return <NoModuleAccess module="CUSTOMERS" />;
  if (!can(access.user, 'CUSTOMERS', 'VIEW')) return <NoModuleAccess module="CUSTOMERS" />;

  const raw = await searchParams;

  // Only known keys, and only non-empty values: an empty `q=` would otherwise
  // travel to the API as a filter that matches everything.
  const params: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = first(raw[key]);
    if (value !== undefined && value !== '') params[key] = value;
  }

  const sort = params.sort ?? 'name';
  const direction = params.direction ?? 'asc';

  /*
    EXPORT is a separate grant from VIEW on this module: reading a customer on
    screen and obtaining a file of every matching customer's contact details
    are different acts. The endpoint enforces it; this only decides whether to
    offer the button.
  */
  const canExport = can(access.user, 'CUSTOMERS', 'EXPORT');

  // The current filters, minus the position markers — the export covers the
  // whole filtered set, so a cursor or page number would be meaningless.
  const exportParams: Record<string, string> = { ...params };
  delete exportParams.cursor;
  delete exportParams.page;
  delete exportParams.limit;
  const exportQuery = new URLSearchParams(exportParams).toString();

  const [directory, analytics] = await Promise.all([
    fetchCustomerDirectory(params),
    fetchCustomerAnalytics(params),
  ]);

  /*
    Filters that change the empty-state copy. `sort` and `direction` are not
    filters — they are always present — so narrowing on them would make an
    unfiltered directory claim somebody had searched.
  */
  const hasFilters = Object.keys(params).some(
    (key) => !['sort', 'direction', 'cursor', 'page', 'limit'].includes(key),
  );

  // Carried into every sort and page link, minus the position markers.
  const linkParams: Record<string, string> = { ...params };
  delete linkParams.cursor;
  delete linkParams.page;

  const summary = analytics.success ? analytics.data.analytics : null;

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="Customers"
          title="All Customers"
          description="Every customer the CRM holds, with the enquiries, leads and orders recorded against them."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/customers/duplicates">
                  <CopyCheck className="size-4" />
                  Duplicate review
                </Link>
              </Button>
              {/*
                Shown only to somebody holding EXPORT — but the button being
                visible is not what authorizes the download. The endpoint
                requires CUSTOMERS:EXPORT on its own authority, so hiding this
                is a courtesy and removing the check would change nothing about
                who can actually obtain the file.

                A plain anchor rather than a fetch: the response is a file with
                Content-Disposition: attachment, and letting the browser handle
                it is what makes the download work.
              */}
              {canExport && (
                <Button asChild variant="outline">
                  <a href={`/customers/export${exportQuery ? `?${exportQuery}` : ''}`}>
                    <Download className="size-4" />
                    Export CSV
                  </a>
                </Button>
              )}
            </div>
          }
        />
      </ContentPageHeader>

      <ContentRegion>
        <ContentScrollArea>
          <div className="flex flex-col gap-6 pb-2">
            {/*
              The summary card is rendered whether or not its request
              succeeded, with an explicit unavailable state. An absent card and
              a failed one look identical otherwise, and that is how a broken
              endpoint reads as a feature that was never built.
            */}
            <Card className="p-4">
              {!analytics.success ? (
                <ErrorMessage message={analytics.message} code={analytics.code} />
              ) : (
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Customers" value={String(summary?.totalCustomers ?? 0)} />
                  <Stat label="With orders" value={String(summary?.customersWithOrders ?? 0)} />
                  <Stat label="Repeat" value={String(summary?.repeatCustomers ?? 0)} />
                  <Stat
                    label="Awaiting duplicate review"
                    value={String(summary?.openDuplicateCandidates ?? 0)}
                  />
                </dl>
              )}
            </Card>

            {/* A plain GET form, so a filtered view is a shareable URL. */}
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-ink">Find a customer</h2>
              <form className="mt-3 flex flex-wrap items-end gap-3" action="/customers">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">Search</span>
                  <Input
                    name="q"
                    defaultValue={params.q ?? ''}
                    placeholder="Name, company, phone, email or GSTIN"
                    className="w-72"
                    aria-label="Search customers"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">Type</span>
                  <select
                    name="type"
                    defaultValue={params.type ?? ''}
                    aria-label="Customer type"
                    className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                  >
                    <option value="">Any</option>
                    {CUSTOMER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">Orders</span>
                  <select
                    name="hasOrders"
                    defaultValue={params.hasOrders ?? ''}
                    aria-label="Has orders"
                    className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                  >
                    <option value="">Any</option>
                    <option value="true">Has valid orders</option>
                    <option value="false">No valid orders</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">Repeat</span>
                  <select
                    name="isRepeat"
                    defaultValue={params.isRepeat ?? ''}
                    aria-label="Repeat customer"
                    className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                  >
                    <option value="">Any</option>
                    <option value="true">Repeat only</option>
                    <option value="false">First-time only</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 pb-2">
                  <input
                    type="checkbox"
                    name="duplicatesOnly"
                    value="true"
                    defaultChecked={params.duplicatesOnly === 'true'}
                    className="size-4"
                  />
                  <span className="text-xs text-ink">Possible duplicates only</span>
                </label>

                {/*
                  The current ordering rides along as hidden fields, so
                  submitting the form keeps the sort somebody chose instead of
                  silently resetting it to name-ascending.
                */}
                <input type="hidden" name="sort" value={sort} />
                <input type="hidden" name="direction" value={direction} />

                <Button type="submit" variant="outline" size="sm">
                  <Search className="size-4" />
                  Search
                </Button>
                {hasFilters && (
                  <Button asChild variant="ghost" size="sm">
                    <a href="/customers">Clear</a>
                  </Button>
                )}
              </form>
            </Card>

            <Card className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">Directory</h2>
                <p className="text-xs text-muted">
                  Values exclude cancelled orders and completed refunds. INR.
                </p>
              </div>

              <div className="mt-4 flex flex-col gap-4">
                {!directory.success ? (
                  <ErrorMessage message={directory.message} code={directory.code} />
                ) : (
                  <>
                    <CustomerDirectoryTable
                      rows={directory.data.customers}
                      sort={sort}
                      direction={direction}
                      params={linkParams}
                      hasFilters={hasFilters}
                    />
                    <CustomerDirectoryPagination
                      pagination={readPagination(directory.meta)}
                      params={linkParams}
                    />
                  </>
                )}
              </div>
            </Card>
          </div>
        </ContentScrollArea>
      </ContentRegion>
    </ContentPage>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}
