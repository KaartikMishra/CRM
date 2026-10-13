import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchCandidates } from '@/lib/recruitment-api';
import { CandidateTable } from '@/components/hr/candidate-table';
import { CandidateFilters } from '@/components/hr/recruitment-filters';
import { CreateCandidateForm } from '@/components/hr/recruitment-forms';

export const metadata: Metadata = { title: 'Candidates' };

/**
 * The candidate directory.
 *
 * Gated on the module itself, unlike the roles board. The difference is deliberate: an
 * interviewer who may read one application has no business browsing everybody the
 * business has ever considered, and the backend scope reaches candidates only *through*
 * applications for exactly that reason. So somebody without HR_RECRUITMENT:VIEW is shown
 * the access panel rather than an empty list that implies there is nothing here.
 */
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_RECRUITMENT');

  if (!access.allowed || !can(access.user, 'HR_RECRUITMENT', 'VIEW')) {
    return <NoModuleAccess module="HR_RECRUITMENT" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const canCreate = can(access.user, 'HR_RECRUITMENT', 'CREATE');

  const result = await fetchCandidates({
    search: single('search'),
    source: single('source'),
    cursor: single('cursor'),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Candidates"
        description="Everybody the business is considering. One person is one record, however many roles they apply for."
        actions={canCreate ? <CreateCandidateForm /> : undefined}
      />

      <CandidateFilters
        current={{ source: single('source') ?? '', search: single('search') ?? '' }}
      />

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <CandidateTable candidates={result.data.items} />
      )}

      {result.success && result.data.nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/hr/recruitment/candidates?cursor=${result.data.nextCursor}`}>
              Next page
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
