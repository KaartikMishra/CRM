import type { Metadata } from 'next';
import Link from 'next/link';
import { Boxes, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
  ContentScrollArea,
  contentCard,
} from '@/components/common/content-page';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { ProductChangeQueue } from '@/components/procurement/product-change-queue';
import { PurchaseBillTable } from '@/components/procurement/purchase-bill-table';
import { ShortageBoard } from '@/components/procurement/shortage-board';
import {
  fetchPendingProductChanges,
  fetchPurchaseBills,
  fetchShortages,
} from '@/lib/procurement-api';
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
  /*
    Deciding a re-mapping request is ASSIGN, the same capability Sales reviews
    its change requests under — never `role === 'ADMIN'`, so a per-user grant or
    revocation applies here as it does everywhere else. This only decides whether
    the queue is rendered; the API refuses the decision itself without it.
  */
  const canReview = can(access.user, 'PROCUREMENT', 'ASSIGN');

  // Independent of each other, and the API is a long way from here.
  const [{ result }, shortages, productChanges] = await Promise.all([
    fetchPurchaseBills({
      q: first(params.q),
      status: first(params.status),
      vendorId: first(params.vendorId),
      limit: '25',
    }),
    fetchShortages(),
    canReview ? fetchPendingProductChanges() : Promise.resolve([]),
  ]);

  return (
    <ContentPage>
      <ContentPageHeader>
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
      </ContentPageHeader>

      {/*
        The Sales section is gone from this page.

        It listed every outstanding customer order line here, which made the
        Procurement page a second view of Sales — and the Sales module already
        owns that. Procurement's own question is narrower: what has to be bought,
        and which bills cover it. Requirement vs stock below still aggregates the
        same customer demand, which is the part procurement acts on.

        The Sales module itself is untouched and unchanged: its pages, routes,
        sidebar entry and API are exactly as they were. Only this page's copy of
        that information was removed.
      */}

      {/*
        Each section below is its own scroll region, deliberately.

        Requirement vs stock and the purchase bills are read against each other —
        what still has to be bought, and what has been bought to cover it. One
        shared scrollbar would carry the second off the screen while somebody
        reads to the end of the first, which is the one thing this page must not
        do. They share the height instead, and each scrolls on its own.
      */}
      {canReview && <ProductChangeQueue changes={productChanges} />}

      <ShortageBoard rows={shortages} />

      <ContentRegion fill={result.success && result.data.bills.length > 0}>
        <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wider text-muted">
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
          <Card className={contentCard}>
            <ContentScrollArea>
              <PurchaseBillTable bills={result.data.bills} />
            </ContentScrollArea>
          </Card>
        )}
      </ContentRegion>
    </ContentPage>
  );
}
