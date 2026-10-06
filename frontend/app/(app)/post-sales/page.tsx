import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { fetchPostSalesOverview } from '@/lib/post-sales-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'Post Sales & Grievance' };

/**
 * The Post Sales overview.
 *
 * Eight figures, every one of them answerable from the core case system. There is
 * deliberately no return rate, refund rate, SLA breach rate, CSAT, financial impact
 * or employee ranking: Phase 1 holds none of that data, and a tile reading 0%
 * would be a confident lie rather than an honest absence.
 */
export default async function PostSalesOverviewPage() {
  const access = await requireModule('POST_SALES');
  if (!access.allowed) return <NoModuleAccess module="POST_SALES" />;

  const canCreate = can(access.user, 'POST_SALES', 'CREATE');
  const result = await fetchPostSalesOverview();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          eyebrow="Post Sales & Grievance"
          title="Overview"
          description="What is open, what is urgent, and what is waiting on you."
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

      {!result.success ? (
        <ErrorMessage message={result.message} code={result.code} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Open cases" value={result.data.overview.open} href="?openOnly=true" />
          <Tile label="Assigned to me" value={result.data.overview.assignedToMe} href="?mine=true" />
          <Tile label="Critical" value={result.data.overview.critical} href="?priority=CRITICAL" />
          <Tile label="Unassigned" value={result.data.overview.unassigned} />
          <Tile label="New today" value={result.data.overview.newToday} />
          <Tile label="Resolved today" value={result.data.overview.resolvedToday} />
          <Tile label="Reopened" value={result.data.overview.reopened} href="?status=REOPENED" />
          <Tile label="Total cases" value={result.data.overview.total} />
        </div>
      )}
    </div>
  );
}

/**
 * One count.
 *
 * A link where the board can actually answer the same question with a filter —
 * clicking "Critical" should land on the critical cases. Tiles with no equivalent
 * filter are plain text rather than a link to nowhere.
 */
function Tile({ label, value, href }: { label: string; value: number; href?: string }) {
  const body = (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-semibold tabular text-ink">{value}</span>
    </Card>
  );

  if (!href) return body;

  return (
    <Link href={`/post-sales/cases${href}`} className="transition-opacity hover:opacity-80">
      {body}
    </Link>
  );
}
