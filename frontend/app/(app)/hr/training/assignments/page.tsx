import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments, fetchDesignations } from '@/lib/hr-api';
import { fetchTrainingEnrollments, fetchTrainingPrograms } from '@/lib/training-api';
import { EnrollmentTable } from '@/components/hr/training-tables';
import { AssignTrainingForm } from '@/components/hr/training-forms';

export const metadata: Metadata = { title: 'Training Assignments' };

/**
 * Who has been given what.
 *
 * The list is scoped server-side — a department head sees their own people, HR sees
 * everybody — so this page does no filtering of its own beyond passing the query
 * through. A manager reading it cannot widen their view by editing the URL.
 *
 * The assign form appears only with HR_TRAINING:ASSIGN. The API refuses the write
 * regardless; this just avoids rendering a form that would always be refused.
 */
export default async function TrainingAssignmentsPage({
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

  const canAssign = can(access.user, 'HR_TRAINING', 'ASSIGN');
  const status = single('status');
  const obligation = single('obligation');
  const overdueOnly = single('overdueOnly');

  const [result, programs, departments, designations] = await Promise.all([
    fetchTrainingEnrollments({
      programId: single('programId'),
      employeeId: single('employeeId'),
      departmentId: single('departmentId'),
      status,
      obligation,
      assignedVia: single('assignedVia'),
      overdueOnly,
      search: single('search'),
      cursor: single('cursor'),
    }),
    // Published programs only — the picker should not offer a draft, which cannot be
    // assigned and would be refused with a message about something the person did
    // not choose.
    canAssign
      ? fetchTrainingPrograms({ status: 'ACTIVE', limit: '100' })
      : Promise.resolve(null),
    canAssign ? fetchDepartments({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
    canAssign ? fetchDesignations({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
  ]);

  const filters: { label: string; href: string; active: boolean }[] = [
    {
      label: 'All',
      href: '/hr/training/assignments',
      active: !status && !obligation && !overdueOnly,
    },
    {
      label: 'Not started',
      href: '/hr/training/assignments?status=NOT_STARTED',
      active: status === 'NOT_STARTED',
    },
    {
      label: 'In progress',
      href: '/hr/training/assignments?status=IN_PROGRESS',
      active: status === 'IN_PROGRESS',
    },
    {
      label: 'Finished',
      href: '/hr/training/assignments?status=COMPLETED',
      active: status === 'COMPLETED',
    },
    {
      label: 'Overdue',
      href: '/hr/training/assignments?overdueOnly=true',
      active: overdueOnly === 'true',
    },
    {
      label: 'Required only',
      href: '/hr/training/assignments?obligation=MANDATORY',
      active: obligation === 'MANDATORY',
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="Assignments"
        description="Who has been given what, and how far they have got."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/training/programs">Programs</Link>
          </Button>
        }
      />

      {canAssign && (
        <AssignTrainingForm
          programs={programs?.success ? programs.data.items : []}
          departments={departments?.success ? departments.data.departments : []}
          designations={designations?.success ? designations.data.designations : []}
        />
      )}

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
          <EnrollmentTable enrollments={result.data.items} />

          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/training/assignments?${new URLSearchParams({
                    ...(status ? { status } : {}),
                    ...(obligation ? { obligation } : {}),
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
