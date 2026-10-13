import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments, fetchEmployees } from '@/lib/hr-api';
import { fetchReviewCycles } from '@/lib/performance-api';
import { GoalForm } from '@/components/hr/performance-forms';

export const metadata: Metadata = { title: 'New Goal' };

/**
 * Setting a goal.
 *
 * Gated on HR_PERFORMANCE:ASSIGN — setting a goal places an obligation with a
 * deadline on somebody, which is the same grant Phase 4 uses for putting a colleague
 * into a course.
 *
 * Archived cycles are excluded from the picker: attaching a goal to one would be
 * appraising it in a period already closed.
 */
export default async function NewGoalPage() {
  const access = await requireModule('HR_PERFORMANCE');
  if (!access.allowed || !can(access.user, 'HR_PERFORMANCE', 'ASSIGN')) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  /*
    The employee candidates come from the existing scoped directory endpoint — a
    manager sees their reports, HR sees everybody. `employedOnly` excludes people
    who have left, because a goal cannot be set for somebody who is gone and the
    API refuses it anyway.

    No new endpoint and no widened permission: this is the same list the reader can
    already see at /hr/employees.
  */
  const [departments, cycles, employees] = await Promise.all([
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
    fetchReviewCycles({ status: 'ACTIVE', limit: '100' }),
    fetchEmployees({ employedOnly: 'true', limit: '100', sort: 'name' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="Set a goal"
        description="A goal is born as a draft. Agreeing it is a separate act, so an imposed goal and an agreed one are distinguishable."
      />

      <GoalForm
        departments={departments.success ? departments.data.departments : []}
        cycles={cycles.success ? cycles.data.items : []}
        employees={employees.success ? employees.data.employees : []}
      />
    </div>
  );
}
