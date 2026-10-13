import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchQualifications, fetchTrainingEnrollments } from '@/lib/training-api';
import { EnrollmentTable, QualificationTable } from '@/components/hr/training-tables';

export const metadata: Metadata = { title: 'Live-Work Qualification' };

/**
 * Who is cleared for live customer work.
 *
 * ### The "ready" list is the server's answer, asked for by status
 *
 * Learners whose every gate is met arrive as enrollments in the COMPLETED state. This
 * page does not decide who is ready — `qualificationGaps` is computed per enrollment
 * on its own page, and the API recomputes it again immediately before granting, so a
 * stale list cannot clear anybody.
 *
 * Granting happens on the learner's own page rather than here, deliberately: clearing
 * somebody for live customer work on the strength of a table row, without seeing what
 * they actually did, is the decision this module exists to make harder.
 */
export default async function QualificationPage({
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

  const canApprove = can(access.user, 'HR_TRAINING', 'APPROVE');
  const activeOnly = single('activeOnly');

  const [qualifications, ready] = await Promise.all([
    fetchQualifications({
      programId: single('programId'),
      employeeId: single('employeeId'),
      activeOnly,
      cursor: single('cursor'),
    }),
    // Finished learners. Whether each is actually clearable is answered per
    // enrollment by the server's gap list, not by this page.
    canApprove
      ? fetchTrainingEnrollments({ status: 'COMPLETED', limit: '50' })
      : Promise.resolve(null),
  ]);

  // A learner who finished and has no live clearance is the one somebody needs to
  // look at. Read from the row's own qualification state, not computed here.
  const awaiting = ready?.success ? ready.data.items : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="Qualification"
        description="Who may do live customer work, and who is still waiting to be cleared."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant={activeOnly === 'true' ? 'default' : 'outline'}>
              <Link href="/hr/training/qualification?activeOnly=true">Cleared only</Link>
            </Button>
            <Button asChild size="sm" variant={activeOnly ? 'outline' : 'default'}>
              <Link href="/hr/training/qualification">Everything</Link>
            </Button>
          </div>
        }
      />

      {canApprove && awaiting.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Finished — open each to see what is left and clear them
          </h2>
          {/*
            Opened individually rather than cleared from here. Signing somebody off
            for live customer work on the strength of a table row, without seeing
            what they did, is exactly what this module exists to make harder.
          */}
          <EnrollmentTable enrollments={awaiting} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Clearances
        </h2>
        {!qualifications.success ? (
          <ErrorMessage message={qualifications.message} />
        ) : (
          <>
            <QualificationTable qualifications={qualifications.data.items} />

            {qualifications.data.nextCursor && (
              <div className="flex justify-end">
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={`/hr/training/qualification?${new URLSearchParams({
                      ...(activeOnly ? { activeOnly } : {}),
                      cursor: qualifications.data.nextCursor,
                    }).toString()}`}
                  >
                    Next
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {ready !== null && !ready.success && (
        <Card className="p-4">
          <ErrorMessage message={ready.message} />
        </Card>
      )}
    </div>
  );
}
