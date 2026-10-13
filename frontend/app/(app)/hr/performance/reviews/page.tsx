import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPerformanceReviews } from '@/lib/performance-api';
import { ReviewTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'Reviews' };

/**
 * The review board.
 *
 * Scoped server-side: an employee sees their own, a manager sees their reports' plus
 * anything they are the named reviewer of, HR sees everything. The third clause
 * matters — a manager who changed teams mid-cycle still owes the reviews they were
 * assigned, and a filter on the hierarchy alone would hide work they are
 * accountable for.
 *
 * The filter is applied inside the query, so post-filtering never truncates a page
 * and editing the URL cannot widen anybody's view.
 */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_PERFORMANCE');

  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const status = single('status');
  const overdueOnly = single('overdueOnly');
  const mineToWrite = single('mineToWrite');

  const result = await fetchPerformanceReviews({
    cycleId: single('cycleId'),
    employeeId: single('employeeId'),
    reviewerId: single('reviewerId'),
    departmentId: single('departmentId'),
    status,
    overdueOnly,
    mineToWrite,
    search: single('search'),
    cursor: single('cursor'),
  });

  const filters: { label: string; href: string; active: boolean }[] = [
    {
      label: 'All',
      href: '/hr/performance/reviews',
      active: !status && !overdueOnly && !mineToWrite,
    },
    {
      label: 'Waiting on me',
      href: '/hr/performance/reviews?mineToWrite=true',
      active: mineToWrite === 'true',
    },
    {
      label: 'Not started',
      href: '/hr/performance/reviews?status=NOT_STARTED',
      active: status === 'NOT_STARTED',
    },
    {
      label: 'Awaiting manager',
      href: '/hr/performance/reviews?status=PENDING_MANAGER',
      active: status === 'PENDING_MANAGER',
    },
    {
      label: 'Awaiting approval',
      href: '/hr/performance/reviews?status=PENDING_APPROVAL',
      active: status === 'PENDING_APPROVAL',
    },
    {
      label: 'Finalised',
      href: '/hr/performance/reviews?status=FINALIZED',
      active: status === 'FINALIZED',
    },
    {
      label: 'Overdue',
      href: '/hr/performance/reviews?overdueOnly=true',
      active: overdueOnly === 'true',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="Reviews"
        description="Where each appraisal stands, and which ones are waiting on you."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/performance/my-review">My review</Link>
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <Button
            key={filter.label}
            asChild
            size="sm"
            variant={filter.active ? 'default' : 'outline'}
          >
            <Link href={filter.href}>{filter.label}</Link>
          </Button>
        ))}
      </div>

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <>
          <ReviewTable reviews={result.data.items} />

          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/performance/reviews?${new URLSearchParams({
                    ...(status ? { status } : {}),
                    ...(overdueOnly ? { overdueOnly } : {}),
                    ...(mineToWrite ? { mineToWrite } : {}),
                    cursor: result.data.nextCursor,
                  }).toString()}`}
                >
                  Next
                </Link>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
