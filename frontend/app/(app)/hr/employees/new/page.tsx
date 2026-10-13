import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { fetchDepartments, fetchDesignations } from '@/lib/hr-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { CreateEmployeeForm } from '@/components/hr/create-employee-form';

export const metadata: Metadata = { title: 'Add Employee' };

/**
 * Adding an employee.
 *
 * Gated on HR_EMPLOYEE:CREATE here as well as in the route table. The UI check is
 * a courtesy — the API refuses the write regardless — but rendering a form
 * somebody cannot submit is its own small cruelty.
 *
 * Only ACTIVE departments and designations are offered: an archived one exists for
 * history, and placing a new employee in one would be creating the very debris
 * archiving is meant to prevent.
 */
export default async function NewEmployeePage() {
  const access = await requireModule('HR_EMPLOYEE');
  if (!access.allowed || !can(access.user, 'HR_EMPLOYEE', 'CREATE')) {
    return <NoModuleAccess module="HR_EMPLOYEE" />;
  }

  const [departments, designations] = await Promise.all([
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
    fetchDesignations({ status: 'ACTIVE', limit: '100' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Add employee"
        description="An employee record. A CRM login is separate and optional."
      />

      <CreateEmployeeForm
        departments={departments.success ? departments.data.departments : []}
        designations={designations.success ? designations.data.designations : []}
      />
    </div>
  );
}
