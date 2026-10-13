import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchTrainingEnrollments } from '@/lib/training-api';
import { EnrollmentTable } from '@/components/hr/training-tables';

export const metadata: Metadata = { title: 'My Learning' };

/**
 * A learner's own courses.
 *
 * ### This page deliberately does not require HR_TRAINING
 *
 * An ordinary employee being trained holds no training grant — being enrolled is a
 * fact about rows, not a permission. Gating here on the module would lock the people
 * the whole phase exists for out of their own courses.
 *
 * So the floor matches the backend's: `HR_TRAINING:VIEW` **or** `HR_EMPLOYEE:VIEW`,
 * which every employee who can see the directory holds. The server then scopes the
 * list — somebody with no grant gets `selfOnly`, a manager gets themselves plus their
 * direct reports, HR gets everybody. **This page does no scoping of its own**, and
 * could not: the filter is applied inside the query, so editing the URL cannot widen
 * it.
 *
 * ### Why the learner column is still shown for some readers
 *
 * A manager landing here sees their reports as well as themselves, so a row needs to
 * say whose it is. For somebody scoped to themselves every row is theirs and the
 * column is noise — but the page cannot tell which case it is in without asking, and
 * asking would mean a second request to learn something the rows already carry. So
 * the column shows whenever more than one person appears.
 */
export default async function MyLearningPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_TRAINING');

  // The backend's own floor, mirrored. Not `access.allowed` alone.
  const mayLearn =
    can(access.user, 'HR_TRAINING', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');

  if (!mayLearn) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const status = single('status');

  const result = await fetchTrainingEnrollments({
    status,
    cursor: single('cursor'),
  });

  const items = result.success ? result.data.items : [];
  const learners = new Set(items.map((item) => item.employee.id));

  const active = items.filter(
    (item) => item.status === 'NOT_STARTED' || item.status === 'IN_PROGRESS',
  );
  const overdue = active.filter((item) => item.isOverdue);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="My learning"
        description="What you have been asked to learn, and where you are up to."
        actions={
          can(access.user, 'HR_TRAINING', 'VIEW') ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/training">Training overview</Link>
            </Button>
          ) : undefined
        }
      />

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label="Outstanding" value={active.length} />
            <Tile label="Overdue" value={overdue.length} alarming />
            <Tile
              label="Finished"
              value={items.filter((item) => item.status === 'COMPLETED').length}
            />
          </div>

          {/*
            The overdue ones first and by name, because a table sorted by assignment
            date buries exactly the rows somebody needs to act on.
          */}
          {overdue.length > 0 && (
            <Card className="flex flex-col gap-1.5 border-critical/30 bg-critical-soft p-4">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-critical">
                Past due
              </span>
              <ul className="flex flex-col gap-1">
                {overdue.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/hr/training/learn/${item.id}`}
                      className="text-sm text-ink hover:underline"
                    >
                      {item.program.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <EnrollmentTable enrollments={items} showLearner={learners.size > 1} />

          {result.data.nextCursor && (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/hr/training/my-learning?${new URLSearchParams({
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

function Tile({
  label,
  value,
  alarming = false,
}: {
  label: string;
  value: number;
  alarming?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span
        className={
          alarming && value > 0
            ? 'text-2xl font-semibold text-critical'
            : 'text-2xl font-semibold text-ink'
        }
      >
        {value}
      </span>
    </Card>
  );
}
