import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments, fetchDesignations } from '@/lib/hr-api';
import { fetchTrainingCategories } from '@/lib/training-api';
import { ProgramForm } from '@/components/hr/training-forms';

export const metadata: Metadata = { title: 'New Training Program' };

/**
 * Creating a program.
 *
 * Gated on HR_TRAINING:CREATE here as well as in the route table — the API refuses the
 * write regardless, but rendering a form somebody cannot submit is its own small
 * cruelty.
 *
 * Only ACTIVE departments and designations are offered: targeting an archived one
 * would aim a program at a unit nobody can be placed in.
 */
export default async function NewTrainingProgramPage() {
  const access = await requireModule('HR_TRAINING');
  if (!access.allowed || !can(access.user, 'HR_TRAINING', 'CREATE')) {
    return <NoModuleAccess module="HR_TRAINING" />;
  }

  const [categories, departments, designations] = await Promise.all([
    fetchTrainingCategories({ status: 'ACTIVE' }),
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
    fetchDesignations({ status: 'ACTIVE', limit: '100' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Training"
        title="New program"
        description="A program is born as a draft. Publishing it is a separate act, so it carries a record of who did it."
      />

      <ProgramForm
        categories={categories.success ? categories.data.categories : []}
        departments={departments.success ? departments.data.departments : []}
        designations={designations.success ? designations.data.designations : []}
      />
    </div>
  );
}
