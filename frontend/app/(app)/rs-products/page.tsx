import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Search, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import { RsProductTable } from '@/components/rs-products/product-table';
import { PaginationControls, decodeStack } from '@/components/rs-products/pagination-controls';
import { fetchRsProducts } from '@/lib/rs-product-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { NoModuleAccess } from '@/components/common/no-module-access';

export const metadata: Metadata = { title: 'RS Products' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * The RS Products catalogue.
 *
 * Shopify is the primary source and CRM-only products sit alongside it, which
 * is why every row carries a source badge: the two are governed by different
 * rules, and a sync overwrites one and never the other.
 *
 * requireModule returns a verdict and never redirects — see require-module.ts.
 */
export default async function RsProductsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const access = await requireModule('RS_PRODUCTS');
  if (!access.allowed) return <NoModuleAccess module="RS_PRODUCTS" />;

  const canCreate = can(access.user, 'RS_PRODUCTS', 'CREATE');
  const canEdit = can(access.user, 'RS_PRODUCTS', 'EDIT');
  const canArchive = can(access.user, 'RS_PRODUCTS', 'DELETE');
  const query = first(params.q);

  // Everything except cursor state. Carried through pagination so a filtered
  // view stays filtered when moving between pages.
  const filters = {
    q: query,
    status: first(params.status),
    source: first(params.source),
    productType: first(params.productType),
    sort: first(params.sort),
  };

  // The pages already visited. A cursor only means something within one result
  // set, so changing a filter drops the stack and returns to the first page —
  // which happens naturally, because the filter form posts without `pages`.
  const stack = decodeStack(first(params.pages));

  const { result, meta } = await fetchRsProducts({ ...filters, cursor: first(params.cursor) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Catalogue"
        title="RS Products"
        description="The central product catalogue. Shopify is its primary source, with CRM-only products alongside."
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/rs-products/new">
                <Plus className="size-4" />
                Add Product
              </Link>
            </Button>
          )
        }
      />

      {/* A GET form submits only its own named inputs, so `cursor` and `pages`
          are dropped on every search — which is exactly right: a cursor from
          one result set is meaningless in another, so searching returns to
          page 1 by construction rather than by a reset written somewhere. */}
      <form className="flex flex-wrap items-center gap-2" action="/rs-products">
        <label className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            name="q"
            defaultValue={query ?? ''}
            placeholder="Search by product name or SKU"
            className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : result.data.products.length === 0 ? (
        <Card>
          <EmptyState
            icon={Tags}
            title={query ? 'No products match that search' : 'No products yet'}
            description={
              query
                ? 'Try a different product name or SKU.'
                : 'Run a Shopify sync, or add a CRM-only product.'
            }
          />
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <RsProductTable
              products={result.data.products}
              canEdit={canEdit}
              canArchive={canArchive}
            />
            <PaginationControls
              stack={stack}
              nextCursor={meta.nextCursor ?? null}
              filters={filters}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
