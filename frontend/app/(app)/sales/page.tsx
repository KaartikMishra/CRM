import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { SalesFilters } from '@/components/sales/sales-filters';
import { SalesOrderTable } from '@/components/sales/sales-order-table';
import { fetchSalesCustomers, fetchSalesOrders } from '@/lib/sales-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Sales' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function SalesListPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const access = await requireModule('SALES');
  if (!access.allowed) return <NoModuleAccess module="SALES" />;
  const user = access.user;
  const canCreate = can(user, 'SALES', 'CREATE');

  // Filters travel to the backend; nothing is filtered client-side.
  //
  // These two calls do not depend on each other, and the API sits a long way
  // from here. Run sequentially they cost the sum; in parallel, the slower one.
  const [{ result, meta }, customers] = await Promise.all([
    fetchSalesOrders({
      q: first(params.q),
      status: first(params.status),
      customerId: first(params.customerId),
      efficiency: first(params.efficiency),
      cursor: first(params.cursor),
      limit: '25',
    }),
    fetchSalesCustomers(),
  ]);

  const isFiltered = Boolean(
    params.q || params.status || params.customerId || params.efficiency,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Sales"
        description="Customer orders, their payments and their dispatch commitments."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/sales/new">
                <Plus className="size-4" />
                New Order
              </Link>
            </Button>
          )
        }
      />

      <SalesFilters customers={customers} />

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : result.data.orders.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShoppingCart}
            title={isFiltered ? 'No orders match these filters' : 'No sales orders yet'}
            description={
              isFiltered
                ? 'Try widening the search, or clear the filters to see everything.'
                : 'Record an order here — whether it came from Shopify or was taken by hand — and track its payment and dispatch.'
            }
            action={
              !isFiltered &&
              canCreate && (
                <Button asChild>
                  <Link href="/sales/new">
                    <Plus className="size-4" />
                    Create the first order
                  </Link>
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <SalesOrderTable orders={result.data.orders} />

          {meta.nextCursor && (
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <span className="text-xs text-muted">
                Showing {result.data.orders.length} orders
              </span>
              <Button variant="outline" size="sm" asChild>
                <Link href={{ pathname: '/sales', query: { ...params, cursor: meta.nextCursor } }}>
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
