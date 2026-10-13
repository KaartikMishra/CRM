import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Users } from 'lucide-react';
import type { EmployeeRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { fetchDepartments, fetchEmployees } from '@/lib/hr-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_STATUS_TONES,
  EMPLOYMENT_TYPE_LABELS,
  WORK_MODE_LABELS,
  formatHrDate,
} from '@/components/hr/hr-labels';
import { EmployeeFilters } from '@/components/hr/employee-filters';

export const metadata: Metadata = { title: 'Employee Directory' };

/**
 * The employee directory.
 *
 * Note what gates this page: `requireModule('HR_EMPLOYEE')` is *not* used, and
 * that is deliberate rather than an omission. A manager who holds no HR permission
 * still needs their own team, and the backend scopes the query to their reports —
 * a manager is identified by being somebody's manager, which is a fact about
 * employee rows and cannot be expressed as a module grant. So the page is reachable
 * by anybody signed in, and the API decides what they see; somebody with neither
 * HR access nor reports gets an empty directory rather than a 403.
 *
 * That also means this page must not assume the viewer holds HR_EMPLOYEE. The
 * create button and the per-row actions are gated individually.
 */
export default async function EmployeeDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Reached for the scoped view; `allowed` is not required to render, so the
  // verdict is used only for the action gating below.
  const access = await requireModule('HR_EMPLOYEE');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const canCreate = access.allowed && can(access.user, 'HR_EMPLOYEE', 'CREATE');

  const [result, departments] = await Promise.all([
    fetchEmployees({
      q: single('q'),
      status: single('status'),
      departmentId: single('departmentId'),
      employmentType: single('employmentType'),
      employedOnly: single('employedOnly'),
      cursor: single('cursor'),
    }),
    // For the filter dropdown. Archived departments are excluded: filtering by one
    // would be filtering by something nobody can be newly placed in.
    fetchDepartments({ status: 'ACTIVE', limit: '100' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          eyebrow="HR & Workforce"
          title="Employee Directory"
          description="Everyone the business employs, and who they report to."
        />

        {canCreate && (
          <Button asChild size="sm">
            <Link href="/hr/employees/new">
              <Plus className="size-4" />
              Add employee
            </Link>
          </Button>
        )}
      </div>

      <EmployeeFilters
        departments={departments.success ? departments.data.departments : []}
        current={{
          q: single('q') ?? '',
          status: single('status') ?? '',
          departmentId: single('departmentId') ?? '',
          employmentType: single('employmentType') ?? '',
        }}
      />

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : result.data.employees.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No employees to show"
          description={
            single('q') || single('status') || single('departmentId')
              ? 'No employee matches these filters. Try widening them.'
              : 'Nobody has been added yet, or you have access to no records.'
          }
          action={
            canCreate ? (
              <Button asChild size="sm">
                <Link href="/hr/employees/new">Add the first employee</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Designation</TableHead>
                  <TableHead>Reports to</TableHead>
                  <TableHead>Employment</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.employees.map((employee) => (
                  <EmployeeTableRow key={employee.id} employee={employee} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {result.success && result.data.nextCursor && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={`/hr/employees?cursor=${result.data.nextCursor}`}>Next page</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function EmployeeTableRow({ employee }: { employee: EmployeeRow }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/hr/employees/${employee.id}`}
          className="flex flex-col gap-0.5 hover:underline"
        >
          <span className="font-medium text-ink">{employee.displayName}</span>
          <span className="text-xs text-muted">
            {employee.employeeId} · {employee.workEmail}
          </span>
        </Link>
      </TableCell>
      <TableCell className="text-ink-2">{employee.department?.name ?? '—'}</TableCell>
      <TableCell className="text-ink-2">{employee.designation?.name ?? '—'}</TableCell>
      <TableCell className="text-ink-2">{employee.manager?.displayName ?? '—'}</TableCell>
      <TableCell className="text-ink-2">
        <div className="flex flex-col gap-0.5">
          <span>{EMPLOYMENT_TYPE_LABELS[employee.employmentType]}</span>
          <span className="text-xs text-muted">{WORK_MODE_LABELS[employee.workMode]}</span>
        </div>
      </TableCell>
      <TableCell className="text-ink-2">{formatHrDate(employee.joiningDate)}</TableCell>
      <TableCell>
        <Badge variant={EMPLOYEE_STATUS_TONES[employee.status]}>
          {EMPLOYEE_STATUS_LABELS[employee.status]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
