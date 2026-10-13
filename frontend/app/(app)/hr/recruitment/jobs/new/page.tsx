import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchDepartments, fetchDesignations } from '@/lib/hr-api';
import { CreateJobForm } from '@/components/hr/recruitment-forms';

export const metadata: Metadata = { title: 'Raise a requisition' };

/**
 * Raising a requisition.
 *
 * Gated on CREATE rather than on the module, because this page does nothing except
 * offer a write. Anybody who cannot perform it has no reason to see the form, and the
 * API would refuse the submission anyway.
 */
export default async function NewJobPage() {
  const access = await requireModule('HR_RECRUITMENT');

  if (!access.allowed || !can(access.user, 'HR_RECRUITMENT', 'CREATE')) {
    return <NoModuleAccess module="HR_RECRUITMENT" />;
  }

  const [departments, designations] = await Promise.all([
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
    fetchDesignations({ status: 'ACTIVE', limit: '200' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Recruitment"
        title="Raise a requisition"
        description="A role starts as a draft. Publishing it is a separate decision."
      />

      {!departments.success && <ErrorMessage message={departments.message} />}
      {!designations.success && <ErrorMessage message={designations.message} />}

      <CreateJobForm
        departments={departments.success ? departments.data.departments : []}
        designations={designations.success ? designations.data.designations : []}
      />
    </div>
  );
}
