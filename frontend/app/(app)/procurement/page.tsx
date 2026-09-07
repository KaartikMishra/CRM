import type { Metadata } from 'next';
import Link from 'next/link';
import { Boxes, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { PurchaseBillTable } from '@/components/procurement/purchase-bill-table';
import { SalesBoard } from '@/components/procurement/sales-board';
import { ShortageBoard } from '@/components/procurement/shortage-board';
import { fetchPurchaseBills, fetchSalesRequirements, fetchShortages } from '@/lib/procurement-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'Purchase & Procurement' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function ProcurementPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const access = await requireModule('PROCUREMENT');
  if (!access.allowed) return <NoModuleAccess module="PROCUREMENT" />;
  const canCreate = can(access.user, 'PROCUREMENT', 'CREATE');

  // Independent of each other, and the API is a long way from here.
  const [{ result }, salesRequirements, shortages] = await Promise.all([
    fetchPurchaseBills({
      q: first(params.q),
      status: first(params.status),
      vendorId: first(params.vendorId),
      limit: '25',
    }),
    fetchSalesRequirements(),
    fetchShortages(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Purchase & Procurement"
        description="What still has to be bought, the bills that cover it, and where the stock is going."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/procurement/new">
                <Plus className="size-4" />
                Add Purchase Bill
              </Link>
            </Button>
          )
        }
      />

      {/* Customer demand first: it is what creates the shortage below. */}
      <SalesBoard rows={salesRequirements} canEdit={can(access.user, 'PROCUREMENT', 'EDIT')} />

      <ShortageBoard rows={shortages} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Purchase bills
        </h2>

        {!result.success ? (
          <ErrorMessage message={result.message} code={result.code} />
        ) : result.data.bills.length === 0 ? (
          <Card>
            <EmptyState
              icon={Boxes}
              title="No purchase bills yet"
              description="When you buy stock to cover a shortage, record the vendor's bill here and allocate it to the orders waiting on it."
              action={
                canCreate && (
                  <Button asChild>
                    <Link href="/procurement/new">
                      <Plus className="size-4" />
                      Add the first bill
                    </Link>
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <PurchaseBillTable bills={result.data.bills} />
          </Card>
        )}
      </section>
    </div>
  );
}
