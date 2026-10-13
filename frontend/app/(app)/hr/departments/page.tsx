import type { Metadata } from 'next';
import { Building2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { EmptyState } from '@/components/common/empty-state';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { fetchDepartments } from '@/lib/hr-api';
import { requireModule } from '@/lib/require-module';
import { ORG_UNIT_STATUS_LABELS } from '@/components/hr/hr-labels';

export const metadata: Metadata = { title: 'Departments' };

/**
 * The department master.
 *
 * Gated on HR_ADMIN, not HR_EMPLOYEE: restructuring the company is a different
 * job from maintaining employee records, and an HR coordinator has no reason to do
 * it. That separation is why this page is reached from the HR overview rather than
 * the sidebar — the navigation table requires every child to share its parent's
 * module, and these do not share HR_EMPLOYEE.
 *
 * There is no delete action, deliberately. A department with employees against it is
 * referenced history; ARCHIVED stops it being offered to new records while keeping
 * every existing reference readable.
 */
export default async function DepartmentsPage() {
  const access = await requireModule('HR_ADMIN');
  if (!access.allowed) return <NoModuleAccess module="HR_ADMIN" />;

  const result = await fetchDepartments({ limit: '100' });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Departments"
        description="How the organization is shaped."
      />

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : result.data.departments.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No departments yet"
          description="Nothing has been set up. Employees can be added without one."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Employees</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.departments.map((unit) => (
                  <TableRow key={unit.id}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-ink">{unit.name}</span>
                        {unit.description && (
                          <span className="text-xs text-muted">{unit.description}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-ink-2">{unit.code}</TableCell>
                    <TableCell className="text-ink-2">{unit.employeeCount}</TableCell>
                    <TableCell>
                      <Badge variant={unit.status === 'ACTIVE' ? 'positive' : 'outline'}>
                        {ORG_UNIT_STATUS_LABELS[unit.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
