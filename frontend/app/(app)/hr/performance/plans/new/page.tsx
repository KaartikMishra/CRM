import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchEmployees } from '@/lib/hr-api';
import { PlanForm } from '@/components/hr/performance-forms';

export const metadata: Metadata = { title: 'New Development Plan' };

/**
 * Creating a development plan.
 *
 * On the employee floor rather than gated on the module, because a manager writing a
 * plan for their report holds no performance grant — being somebody's manager is a
 * fact about rows, which the route table cannot see.
 *
 * The API refuses the subject authoring a plan about themselves: an improvement plan
 * is a document the business is accountable for, and one the subject wrote would be
 * neither a commitment by the business nor a record of one.
 */
export default async function NewPlanPage({
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
  const reviewRaw = params.reviewId;
  const reviewId = Array.isArray(reviewRaw) ? reviewRaw[0] : reviewRaw;

  // Same scoped directory endpoint as the goal form. Nothing widened.
  const employees = await fetchEmployees({
    employedOnly: 'true',
    limit: '100',
    sort: 'name',
  });

  /*
    The viewer's own Employee row id, found by matching the session's employee code
    against the list they can already see. Used only to drop themselves from the
    picker — the API refuses a self-authored plan regardless, so this avoids
    offering a choice that always fails rather than being the control.
  */
  const viewerEmployeeId = employees.success
    ? employees.data.employees.find(
        (employee) => employee.employeeId === access.user.employeeId,
      )?.id
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="New development plan"
        description="A plan says what will change and what the business will do to help."
      />

      <PlanForm
        reviewId={reviewId}
        employees={employees.success ? employees.data.employees : []}
        viewerEmployeeId={viewerEmployeeId}
      />
    </div>
  );
}
