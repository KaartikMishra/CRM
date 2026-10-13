import type { Metadata } from 'next';
import Link from 'next/link';
import { Building2, IdCard, Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { fetchHrOverview } from '@/lib/hr-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';

export const metadata: Metadata = { title: 'HR & Workforce' };

/**
 * The HR landing page.
 *
 * Four counts, every one answerable from the tables Phase 1 ships. There is
 * deliberately no attrition rate, headcount trend, average tenure, diversity
 * breakdown or chart of any kind: Phase 1 holds no time series to compute them
 * from, and a tile reading "0% attrition" would be a confident lie rather than an
 * honest absence. HR analytics is Phase 7.
 *
 * This page is also where the organization masters are reached, rather than the
 * sidebar. They are governed by HR_ADMIN — a different grant from HR_EMPLOYEE,
 * because an HR coordinator who maintains employee records has no reason to
 * restructure the company — so their links appear only for somebody who actually
 * holds it.
 */
export default async function HrOverviewPage() {
  const access = await requireModule('HR_EMPLOYEE');
  if (!access.allowed) return <NoModuleAccess module="HR_EMPLOYEE" />;

  const canCreate = can(access.user, 'HR_EMPLOYEE', 'CREATE');
  const canAdminOrg = can(access.user, 'HR_ADMIN', 'VIEW');
  const result = await fetchHrOverview();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          eyebrow="HR & Workforce"
          title="Overview"
          description="Who works here, how the organization is shaped, and what has changed."
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

      {!result.success ? (
        <ErrorMessage message={result.message} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Employees"
            value={result.data.overview.totalEmployees}
            hint="Every record, past and present"
            icon={Users}
          />
          <Tile
            label="Currently employed"
            value={result.data.overview.employedCount}
            hint="Probation, active or on notice"
            icon={Users}
          />
          <Tile
            label="Departments"
            value={result.data.overview.activeDepartments}
            hint="Active only"
            icon={Building2}
          />
          <Tile
            label="Designations"
            value={result.data.overview.activeDesignations}
            hint="Active only"
            icon={IdCard}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline" size="sm">
          <Link href="/hr/employees">Employee directory</Link>
        </Button>
        {canAdminOrg && (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/hr/departments">Departments</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/hr/designations">Designations</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-2 text-muted">
        <Icon className="size-4" />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-2xl font-semibold text-ink">{value}</span>
      <span className="text-xs text-muted">{hint}</span>
    </Card>
  );
}
