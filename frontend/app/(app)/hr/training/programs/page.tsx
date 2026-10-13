import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchTrainingCategories, fetchTrainingPrograms } from '@/lib/training-api';
import { ProgramTable } from '@/components/hr/training-tables';

export const metadata: Metadata = { title: 'Training Programs' };

/**
 * The catalogue.
 *
 * Gated on the module, unlike the requisition board: training has no self-service
 * population on this page. A learner's own courses live on My Learning, so somebody
 * without `HR_TRAINING` has nothing to see here and the access panel is the honest
 * answer.
 *
 * The filters are plain links rather than a client component. There are three of them,
 * they are mutually exclusive, and a link is bookmarkable — which a select driving
 * `router.push` is not.
 */
export default async function TrainingProgramsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_TRAINING');
  if (!access.allowed) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const canCreate = can(access.user, 'HR_TRAINING', 'CREATE');
  const status = single('status');

  const [result, categories] = await Promise.all([
    fetchTrainingPrograms({
      status,
      categoryId: single('categoryId'),
      departmentId: single('departmentId'),
      obligation: single('obligation'),
      search: single('search'),
      cursor: single('cursor'),
    }),
    fetchTrainingCategories({ status: 'ACTIVE' }),
  ]);

  const filters: { label: string; value: string | undefined }[] = [
    { label: 'All', value: undefined },
    { label: 'Open', value: 'ACTIVE' },
    { label: 'Draft', value: 'DRAFT' },
    { label: 'Archived', value: 'ARCHIVED' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="Programs"
        description="What the business teaches, in the order it is taught."
        actions={
          canCreate ? (
            <Button asChild size="sm">
              <Link href="/hr/training/programs/new">Create a program</Link>
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
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
                    ? '/hr/training/programs'
                    : `/hr/training/programs?status=${filter.value}`
                }
              >
                {filter.label}
              </Link>
            </Button>
          );
        })}

        {categories.success && categories.data.categories.length > 0 && (
          <span className="ml-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {categories.data.categories.map((category) => (
              <Link
                key={category.id}
                href={`/hr/training/programs?categoryId=${category.id}`}
                className="rounded-full border border-line px-2 py-0.5 hover:bg-surface-2"
              >
                {category.name}
              </Link>
            ))}
          </span>
        )}
      </div>

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <>
          <ProgramTable programs={result.data.items} />

          {/*
            Cursor pagination: the server returns the next cursor, so "next" is a link
            and there is no page number to get wrong. There is no "previous" because a
            cursor walks forward only — the back button is the previous page.
          */}
          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/training/programs?${new URLSearchParams({
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
