import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { EnquiryFilters } from '@/components/product-enquiry/enquiry-filters';
import { EnquiryTable } from '@/components/product-enquiry/enquiry-table';
import { apiFetch } from '@/lib/api-server';
import { fetchEnquiries } from '@/lib/enquiry-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Product Enquiry' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function ProductEnquiryListPage({
  searchParams,
}: {
  searchParams: Search;
}) {
  const params = await searchParams;
  const access = await requireModule('PRODUCT_ENQUIRY');
  if (!access.allowed) return <NoModuleAccess module="PRODUCT_ENQUIRY" />;
  const user = access.user;
  const canCreate = can(user, 'PRODUCT_ENQUIRY', 'CREATE');

  // Filters travel to the backend; nothing is filtered client-side (§46).
  //
  // These two calls do not depend on each other, and the API sits a long way
  // from here — roughly 200ms per round trip to Neon in ap-southeast-1. Run
  // sequentially they cost the sum; in parallel they cost the slower one.
  const [{ result, meta }, assigneesResult] = await Promise.all([
    fetchEnquiries({
      q: first(params.q),
      status: first(params.status),
      assignedToId: first(params.assignedToId),
      efficiency: first(params.efficiency),
      cursor: first(params.cursor),
      limit: '25',
    }),
    apiFetch<{ assignees: { id: string; name: string; employeeId: string }[] }>(
      '/api/product-enquiries/assignees',
    ),
  ]);
  const assignees = assigneesResult.success ? assigneesResult.data.assignees : [];

  const isFiltered = Boolean(
    params.q || params.status || params.assignedToId || params.efficiency,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Product Enquiry"
        description="Customer requests and their vendor responses, against a 15-minute response window."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/product-enquiry/new">
                <Plus className="size-4" />
                New Enquiry
              </Link>
            </Button>
          )
        }
      />

      <EnquiryFilters assignees={assignees} />

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : result.data.enquiries.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={isFiltered ? 'No enquiries match these filters' : 'No product enquiries yet'}
            description={
              isFiltered
                ? 'Try widening the search, or clear the filters to see everything.'
                : 'When a customer asks about products, record it here and the response clock starts.'
            }
            action={
              !isFiltered &&
              canCreate && (
                <Button asChild>
                  <Link href="/product-enquiry/new">
                    <Plus className="size-4" />
                    Create the first enquiry
                  </Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <EnquiryTable
            enquiries={result.data.enquiries}
            serverTime={meta.serverTime ?? new Date().toISOString()}
          />

          {meta.nextCursor && (
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <span className="text-xs text-muted">
                Showing {result.data.enquiries.length} enquiries
              </span>
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={{
                    pathname: '/product-enquiry',
                    query: { ...params, cursor: meta.nextCursor },
                  }}
                >
                  Next page
                </Link>
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
