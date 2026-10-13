import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchGoals } from '@/lib/performance-api';
import { GoalTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'Goals' };

/**
 * The goal board.
 *
 * Scoped server-side: an employee sees their own goals **and their department's**, a
 * manager sees their reports' too, HR sees everything. The department half matters —
 * somebody who could not see what their unit is working towards could not align
 * their own goals to it, which is the entire point of having department goals.
 *
 * This page does no filtering of its own beyond passing the query through, so
 * editing the URL cannot widen anybody's view.
 */
export default async function GoalsPage({
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

  const canAssign = can(access.user, 'HR_PERFORMANCE', 'ASSIGN');
  const status = single('status');
  const scope = single('scope');
  const overdueOnly = single('overdueOnly');

  const result = await fetchGoals({
    scope,
    status,
    employeeId: single('employeeId'),
    departmentId: single('departmentId'),
    cycleId: single('cycleId'),
    overdueOnly,
    search: single('search'),
    cursor: single('cursor'),
  });

  const filters: { label: string; href: string; active: boolean }[] = [
    {
      label: 'All',
      href: '/hr/performance/goals',
      active: !status && !scope && !overdueOnly,
    },
    {
      label: 'Agreed',
      href: '/hr/performance/goals?status=ACTIVE',
      active: status === 'ACTIVE',
    },
    {
      label: 'Draft',
      href: '/hr/performance/goals?status=DRAFT',
      active: status === 'DRAFT',
    },
    {
      label: 'Overdue',
      href: '/hr/performance/goals?overdueOnly=true',
      active: overdueOnly === 'true',
    },
    {
      label: 'Individual',
      href: '/hr/performance/goals?scope=EMPLOYEE',
      active: scope === 'EMPLOYEE',
    },
    {
      label: 'Department',
      href: '/hr/performance/goals?scope=DEPARTMENT',
      active: scope === 'DEPARTMENT',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="Goals"
        description="What people and departments are working towards, and how far they have got."
        actions={
          canAssign ? (
            <Button asChild size="sm">
              <Link href="/hr/performance/goals/new">Set a goal</Link>
            </Button>
          ) : undefined
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
          <GoalTable goals={result.data.items} />

          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/performance/goals?${new URLSearchParams({
                    ...(status ? { status } : {}),
                    ...(scope ? { scope } : {}),
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
