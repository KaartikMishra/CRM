import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchReviewCycles } from '@/lib/performance-api';
import { CycleTable } from '@/components/hr/performance-tables';

export const metadata: Metadata = { title: 'Review Cycles' };

/**
 * The cycle list.
 *
 * On the employee floor, not gated on the module: a cycle is the terms somebody is
 * being judged against, and withholding them would be withholding the rules of
 * their own appraisal. Nothing on a cycle is personal to anybody.
 *
 * The create button *is* gated, because designing a cycle sets what everybody will
 * be judged on — and offering a button that 403s is worse than not offering it.
 */
export default async function CyclesPage({
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

  const canCreate = can(access.user, 'HR_PERFORMANCE', 'CREATE');
  const status = single('status');

  const result = await fetchReviewCycles({
    status,
    cadence: single('cadence'),
    departmentId: single('departmentId'),
    search: single('search'),
    cursor: single('cursor'),
  });

  const filters: { label: string; value: string | undefined }[] = [
    { label: 'All', value: undefined },
    { label: 'Open', value: 'ACTIVE' },
    { label: 'Draft', value: 'DRAFT' },
    { label: 'Closed', value: 'CLOSED' },
    { label: 'Archived', value: 'ARCHIVED' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="Review cycles"
        description="Appraisal periods, and what each one rates against."
        actions={
          canCreate ? (
            <Button asChild size="sm">
              <Link href="/hr/performance/cycles/new">Create a cycle</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const active = status === filter.value;
          return (
            <Button
              key={filter.label}
              asChild
              size="sm"
              variant={active ? 'default' : 'outline'}
            >
              <Link
                href={
                  filter.value === undefined
                    ? '/hr/performance/cycles'
                    : `/hr/performance/cycles?status=${filter.value}`
                }
              >
                {filter.label}
              </Link>
            </Button>
          );
        })}
      </div>

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <>
          <CycleTable cycles={result.data.items} />

          {/*
            Cursor pagination: "next" is a link and there is no page number to get
            wrong. No "previous" because a cursor walks forward only — the back
            button is the previous page.
          */}
          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/performance/cycles?${new URLSearchParams({
                    ...(status ? { status } : {}),
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
