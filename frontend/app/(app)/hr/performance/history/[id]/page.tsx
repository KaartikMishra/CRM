import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPerformanceHistory } from '@/lib/performance-api';
import { HistoryTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'Performance History' };

/**
 * One person's appraisal history.
 *
 * Finalized reviews only, oldest first — a history including drafts and
 * cancellations would make a trend line out of noise. And because a finalized review
 * cannot be edited, this list cannot change retroactively.
 *
 * Scoped server-side: an employee reads their own, a manager their reports', HR
 * everybody's. A 404 means out of scope rather than absent — telling somebody "you
 * may not read employee X's history" would confirm X exists.
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_PERFORMANCE');

  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const { id } = await params;
  const query = await searchParams;
  const single = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const result = await fetchPerformanceHistory(id, {
    from: single('from'),
    to: single('to'),
  });

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Performance" title="Performance history" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/performance/reviews">Back to reviews</Link>
          </Button>
        </div>
      </div>
    );
  }

  const history = result.data.history;
  const isSelf = history.employee.employeeId === access.user.employeeId;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title={isSelf ? 'Your appraisal history' : `${history.employee.displayName}'s history`}
        description="Finalised reviews only, oldest first."
      />

      <HistoryTable entries={history.entries} averageRating={history.averageRating} />
    </div>
  );
}
