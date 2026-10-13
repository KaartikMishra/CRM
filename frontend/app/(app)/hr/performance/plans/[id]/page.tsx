import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDevelopmentPlan } from '@/lib/performance-api';
import { PlanDetailPanel } from '@/components/hr/plan-panels';

export const metadata: Metadata = { title: 'Development Plan' };

/**
 * One development plan.
 *
 * ### The one asymmetry worth restating
 *
 * The subject cannot create, amend or close their own plan, but **can** tick its
 * actions off. Doing the things a plan asks for is their work; requiring a manager
 * to record each one would make the plan a tracking burden rather than a support.
 * They still cannot add, remove or reword an action, so what they tick is what was
 * agreed.
 *
 * Both halves are enforced by the API. `canManage` is false for the subject here as
 * a courtesy — rendering controls that always 403 would be worse than rendering
 * none.
 */
export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_PERFORMANCE');

  const mayReach =
    can(access.user, 'HR_PERFORMANCE', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const { id } = await params;
  const result = await fetchDevelopmentPlan(id);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Performance" title="Development plan" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/performance/plans">Back to plans</Link>
          </Button>
        </div>
      </div>
    );
  }

  const plan = result.data.plan;

  // Compared on the employee code, which is what the session carries.
  const isSubject = plan.employee.employeeId === access.user.employeeId;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title={isSubject ? 'Your development plan' : plan.title}
        description={isSubject ? plan.title : `${plan.employee.displayName}'s plan`}
      />

      <PlanDetailPanel
        plan={plan}
        canManage={!isSubject}
        canTickActions
      />
    </div>
  );
}
