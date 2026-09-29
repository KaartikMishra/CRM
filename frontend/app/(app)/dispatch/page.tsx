import type { Metadata } from 'next';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import {
  ContentPage,
  ContentPageHeader,
  ContentRegion,
} from '@/components/common/content-page';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { DispatchBoard } from '@/components/dispatch/dispatch-board';
import { fetchDispatchBoard } from '@/lib/dispatch-api';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Packing & Dispatch' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function DispatchPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;

  const access = await requireModule('PACKING_DISPATCH');
  if (!access.allowed) return <NoModuleAccess module="PACKING_DISPATCH" />;

  const query = first(params.q);

  /*
    Only the filters the API actually accepts. `q` matches the order number, the
    customer's name or an AWB, which the backend implements in one query —
    inventing a readiness filter here would mean paginating a list the server
    never filtered, and the page counts would lie.
  */
  const { result } = await fetchDispatchBoard({
    q: query,
    cursor: first(params.cursor),
    limit: '25',
  });

  return (
    <ContentPage>
      <ContentPageHeader>
        <PageHeader
          eyebrow="Operations"
          title="Packing & Dispatch"
          description="What is ready to leave, what is still short, and where every parcel is."
        />

        {/* A GET form submits only its own named inputs, so `cursor` is dropped
            on every search — which is right: a cursor from one result set is
            meaningless in another, so searching returns to page 1 by
            construction rather than by a reset written somewhere. */}
        <form className="flex flex-wrap items-center gap-2" action="/dispatch">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              name="q"
              defaultValue={query ?? ''}
              placeholder="Search by order number, customer or AWB"
              className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </ContentPageHeader>

      <ContentRegion>
        {!result.success ? (
          <ErrorMessage message={result.message} code={result.code} />
        ) : (
          <DispatchBoard orders={result.data.orders} />
        )}
      </ContentRegion>
    </ContentPage>
  );
}
