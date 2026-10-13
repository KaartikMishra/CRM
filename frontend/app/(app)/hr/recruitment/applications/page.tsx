import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchApplications, fetchCandidates, fetchJobs } from '@/lib/recruitment-api';
import { ApplicationTable } from '@/components/hr/candidate-table';
import { ApplicationFilters } from '@/components/hr/recruitment-filters';
import { CreateApplicationForm } from '@/components/hr/recruitment-forms';

export const metadata: Metadata = { title: 'Applications' };

/**
 * The applications board.
 *
 * Reachable without the module, like the roles board: a hiring manager sees the
 * applications on their vacancies and an interviewer the ones they are booked against,
 * both scoped by the server. Somebody with neither gets an empty board.
 */
export default async function ApplicationsPage({
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

  const [result, jobs, candidates] = await Promise.all([
    fetchApplications({
      stage: single('stage'),
      status: single('status'),
      search: single('search'),
      cursor: single('cursor'),
    }),
    canCreate ? fetchJobs({ status: 'PUBLISHED', limit: '100' }) : Promise.resolve(null),
    canCreate ? fetchCandidates({ isActive: 'true', limit: '100' }) : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Applications"
        description="Who is being considered for what, and where each stands."
        actions={
          canCreate && jobs?.success && candidates?.success ? (
            <CreateApplicationForm jobs={jobs.data.items} candidates={candidates.data.items} />
          ) : undefined
        }
      />

      <ApplicationFilters
        basePath="/hr/recruitment/applications"
        current={{
          stage: single('stage') ?? '',
          status: single('status') ?? '',
          search: single('search') ?? '',
        }}
      />

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <ApplicationTable applications={result.data.items} />
      )}

      {result.success && result.data.nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/hr/recruitment/applications?cursor=${result.data.nextCursor}`}>
              Next page
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
