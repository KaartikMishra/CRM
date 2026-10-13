import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchOnboarding } from '@/lib/recruitment-api';
import { fetchTrainingPrograms } from '@/lib/training-api';
import { OnboardingDetail } from '@/components/hr/onboarding-panel';

export const metadata: Metadata = { title: 'Onboarding' };

/**
 * One onboarding.
 *
 * `canEdit` is passed as EDIT *or* nothing, because the task controls are reachable by the
 * assignee too — an IT colleague closing their own laptop task holds no recruitment grant,
 * and the service decides. Passing `true` here would offer buttons to everybody; passing
 * only the module grant would hide them from the very people who owe the work. So the page
 * passes the module grant for the stage controls and the panel relies on the API for the
 * per-task rule.
 */
export default async function OnboardingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_RECRUITMENT');
  const { id } = await params;

  const canEdit = access.allowed && can(access.user, 'HR_RECRUITMENT', 'EDIT');
  const canDecide = access.allowed && can(access.user, 'HR_RECRUITMENT', 'APPROVE');

  /*
    Phase 4. The published catalogue, so a TRAINING task on this checklist can be
    linked to a real course. Only published programs — a draft cannot be assigned, and
    offering one would produce a refusal about something the person did not choose.

    Fetched for anybody who may work the checklist rather than gated on HR_TRAINING:
    the person linking is usually the HR colleague running the onboarding, who holds
    HR_RECRUITMENT and need not hold the training module. The link endpoint accepts
    HR_TRAINING:ASSIGN *or* HR_RECRUITMENT:EDIT for exactly that reason, and refuses
    whoever holds neither.
  */
  const [result, programs] = await Promise.all([
    fetchOnboarding(id),
    fetchTrainingPrograms({ status: 'ACTIVE', limit: '100' }),
  ]);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="HR & Workforce" title="Onboarding" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/onboarding">Back to onboarding</Link>
          </Button>
        </div>
      </div>
    );
  }

  const onboarding = result.data.onboarding;

  // Company time, so "overdue" means overdue in the business's timezone rather than the
  // viewer's — a colleague abroad must not see a task flagged a day early.
  const todayKey = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title={onboarding.candidate.displayName}
        description={`Joining ${onboarding.joiningDate} · ${onboarding.job.title}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/hr/recruitment/applications/${onboarding.applicationId}`}>
                Application
              </Link>
            </Button>
            {onboarding.employee && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/hr/employees/${onboarding.employee.id}`}>Employee</Link>
              </Button>
            )}
          </div>
        }
      />

      <OnboardingDetail
        onboarding={onboarding}
        canEdit={canEdit}
        canDecide={canDecide}
        todayKey={todayKey}
        trainingPrograms={programs.success ? programs.data.items : []}
      />
    </div>
  );
}
