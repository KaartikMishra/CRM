import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments } from '@/lib/hr-api';
import { fetchJobs } from '@/lib/recruitment-api';
import { JobTable } from '@/components/hr/job-table';
import { JobFilters } from '@/components/hr/recruitment-filters';

export const metadata: Metadata = { title: 'Roles' };

/**
 * The requisition board.
 *
 * Not gated on `access.allowed`, deliberately: a hiring manager who owns a vacancy
 * without holding HR_RECRUITMENT must still see it, and the server scopes the list to
 * their involvement. Somebody with neither the module nor an involvement gets an empty
 * board rather than a 403 — the same shape the employee directory uses, and for the
 * same reason.
 *
 * The create button *is* gated, because raising a requisition needs CREATE and offering
 * a button that 403s is worse than not offering it.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_RECRUITMENT');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const canCreate = access.allowed && can(access.user, 'HR_RECRUITMENT', 'CREATE');

  const [result, departments] = await Promise.all([
    fetchJobs({
      status: single('status'),
      priority: single('priority'),
      departmentId: single('departmentId'),
      search: single('search'),
      cursor: single('cursor'),
    }),
    // Archived departments are excluded: filtering by one would be filtering by
    // something nobody can raise a new role in.
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Roles"
        description="Requisitions the business is filling, and how far each has got."
        actions={
          canCreate ? (
            <Button asChild size="sm">
              <Link href="/hr/recruitment/jobs/new">Raise a requisition</Link>
            </Button>
          ) : undefined
        }
      />

      {departments.success && (
        <JobFilters
          departments={departments.data.departments}
          current={{
            status: single('status') ?? '',
            priority: single('priority') ?? '',
            departmentId: single('departmentId') ?? '',
            search: single('search') ?? '',
          }}
        />
      )}

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <JobTable jobs={result.data.items} />
      )}

      {result.success && result.data.nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/hr/recruitment/jobs?cursor=${result.data.nextCursor}`}>Next page</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
