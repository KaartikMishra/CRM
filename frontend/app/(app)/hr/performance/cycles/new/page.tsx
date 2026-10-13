import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments } from '@/lib/hr-api';
import { CycleForm } from '@/components/hr/performance-forms';

export const metadata: Metadata = { title: 'New Review Cycle' };

/**
 * Creating a cycle.
 *
 * Gated on HR_PERFORMANCE:CREATE here as well as in the route table — the API
 * refuses the write regardless, but rendering a form somebody cannot submit is its
 * own small cruelty.
 *
 * Only ACTIVE departments are offered: targeting an archived one would aim a cycle
 * at a unit nobody is placed in.
 */
export default async function NewCyclePage() {
  const access = await requireModule('HR_PERFORMANCE');
  if (!access.allowed || !can(access.user, 'HR_PERFORMANCE', 'CREATE')) {
    return <NoModuleAccess module="HR_PERFORMANCE" />;
  }

  const departments = await fetchDepartments({ status: 'ACTIVE', limit: '100' });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Performance"
        title="New review cycle"
        description="A cycle is born as a draft. Opening it is a separate act, so it carries a record of who did it."
      />

      <CycleForm departments={departments.success ? departments.data.departments : []} />
    </div>
  );
}
