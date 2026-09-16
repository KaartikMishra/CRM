import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { AddVendorButton } from '@/components/vendor-invoices/add-vendor-button';
import { VendorFilters } from '@/components/vendor-invoices/vendor-filters';
import { VendorTable } from '@/components/vendor-invoices/vendor-table';
import { VendorDrawer } from '@/components/vendor-invoices/vendor-drawer';
import {
  PaginationControls,
  decodeStack,
} from '@/components/vendor-invoices/pagination-controls';
import { fetchVendors } from '@/lib/vendor-invoice-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Vendor Invoices' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Vendor Invoices.
 *
 * The module answers three questions about a supplier — who they are, what the
 * CRM has actually bought from them, and what they charge today — and the last
 * two are deliberately different things. Trade history is read live from
 * Procurement's purchase records and can never be written here; the mapping
 * rate is a standing agreement that changes whenever a price is renegotiated.
 * They appear in separate sections of the drawer for that reason.
 *
 * requireModule returns a verdict and never redirects — see require-module.ts.
 */
export default async function VendorInvoicesPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const access = await requireModule('VENDOR_INVOICE');
  if (!access.allowed) return <NoModuleAccess module="VENDOR_INVOICE" />;

  const canCreate = can(access.user, 'VENDOR_INVOICE', 'CREATE');
  const canEdit = can(access.user, 'VENDOR_INVOICE', 'EDIT');
  const canArchive = can(access.user, 'VENDOR_INVOICE', 'DELETE');

  const query = first(params.q);

  // Everything except cursor state. Carried through pagination so a filtered
  // view stays filtered when moving between pages.
  const filters = {
    q: query,
    isActive: first(params.isActive),
  };

  // The pages already visited. A cursor only means something within one result
  // set, so changing a filter drops the stack and returns to the first page —
  // which VendorFilters does explicitly when it rewrites the query string.
  const stack = decodeStack(first(params.pages));
  const vendorId = first(params.vendorId);

  const { result, meta } = await fetchVendors({ ...filters, cursor: first(params.cursor) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Suppliers"
        title="Vendor Invoices"
        description="Vendors, what the CRM has bought from them, and the rates they charge today."
        actions={canCreate && <AddVendorButton />}
      />

      <VendorFilters />

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : result.data.vendors.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={query ? 'No vendors match that search' : 'No vendors yet'}
            description={
              query
                ? 'Try a different name, company, phone number or email.'
                : canCreate
                  ? 'Add a vendor to start recording what they supply and what they charge.'
                  : 'Vendors added by your team will appear here.'
            }
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <VendorTable
              vendors={result.data.vendors}
              canEdit={canEdit}
              canArchive={canArchive}
            />
            <PaginationControls
              stack={stack}
              nextCursor={meta.nextCursor ?? null}
              filters={filters}
              cursorKey="cursor"
              stackKey="pages"
              basePath="/vendor-invoices"
              label="Vendor pages"
            />
          </CardContent>
        </Card>
      )}

      {/*
        The drawer's three reads are streamed rather than awaited here, so
        opening a vendor never delays the list behind them. `key` forces a fresh
        fetch when a different vendor is opened; without it React would reuse
        the previous vendor's suspended boundary.
      */}
      {vendorId && (
        <Suspense key={vendorId} fallback={<DrawerSkeleton />}>
          <VendorDrawer
            vendorId={vendorId}
            filters={{ ...filters, cursor: first(params.cursor), pages: first(params.pages) }}
            tradeCursor={first(params.tradeCursor)}
            tradeStack={first(params.tradePages)}
            mapCursor={first(params.mapCursor)}
            mapStack={first(params.mapPages)}
            canEdit={canEdit}
            canArchive={canArchive}
            canCreate={canCreate}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * What the drawer looks like while its three reads are in flight.
 *
 * A panel in the drawer's own shape rather than a spinner, so the layout does
 * not jump when the data lands. Not the interactive shell: this renders before
 * the vendor's name is known, and a drawer titled "Trades with …" nothing would
 * be worse than one that is plainly still loading.
 */
function DrawerSkeleton() {
  return (
    <div
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-4xl flex-col border-l border-line bg-surface p-5 shadow-overlay"
      role="status"
      aria-label="Loading vendor details"
    >
      <Skeleton className="h-6 w-64" />
      <Skeleton className="mt-2 h-4 w-40" />
      <Skeleton className="mt-6 h-32 w-full" />
      <Skeleton className="mt-6 h-48 w-full" />
      <Skeleton className="mt-6 h-40 w-full" />
    </div>
  );
}
