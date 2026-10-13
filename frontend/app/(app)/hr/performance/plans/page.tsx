import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDevelopmentPlans } from '@/lib/performance-api';
import { PlanTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'Development Plans' };

/**
 * Improvement and growth plans.
 *
 * Scoped server-side to the same population as a review: the subject, their manager
 * and HR. On the employee floor, because the subject needs to read their own plan
 * and tick its actions off — doing the things a plan asks for is their work.
 *
 * The create button is offered to anybody on the floor, because a manager writing a
 * plan for their report holds no performance grant. The API refuses the subject
 * authoring one about themselves.
 */
export default async function PlansPage({
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

  const kind = single('kind');
  const status = single('status');
  const overdueOnly = single('overdueOnly');

  const result = await fetchDevelopmentPlans({
    employeeId: single('employeeId'),
    departmentId: single('departmentId'),
    kind,
    status,
    overdueOnly,
    cursor: single('cursor'),
  });

  const filters: { label: string; href: string; active: boolean }[] = [
    {
      label: 'All',
      href: '/hr/performance/plans',
      active: !kind && !status && !overdueOnly,
    },
    {
      label: 'Open',
      href: '/hr/performance/plans?status=OPEN',
      active: status === 'OPEN' && !kind,
    },
    {
      label: 'Improvement',
      href: '/hr/performance/plans?kind=IMPROVEMENT',
      active: kind === 'IMPROVEMENT',
    },
    {
      label: 'Growth',
      href: '/hr/performance/plans?kind=GROWTH',
      active: kind === 'GROWTH',
    },
    {
      label: 'Review overdue',
      href: '/hr/performance/plans?overdueOnly=true',
      active: overdueOnly === 'true',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="Development plans"
        description="Improvement and growth plans, and how far through their actions each has got."
        actions={
          <Button asChild size="sm">
            <Link href="/hr/performance/plans/new">Create a plan</Link>
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
          <PlanTable plans={result.data.items} />

          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/performance/plans?${new URLSearchParams({
                    ...(kind ? { kind } : {}),
                    ...(status ? { status } : {}),
                    ...(overdueOnly ? { overdueOnly } : {}),
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
