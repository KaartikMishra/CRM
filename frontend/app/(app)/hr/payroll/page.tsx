import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { EmptyState } from '@/components/common/empty-state';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPayrollOverview } from '@/lib/payroll-api';
import {
  NOT_STATUTORY_NOTICE,
  PERIOD_STATUS_SHORT,
  PERIOD_STATUS_TONES,
  formatMoney,
  formatPeriodMonth,
} from '@/components/hr/payroll-labels';

export const metadata: Metadata = { title: 'Payroll' };

/**
 * The payroll dashboard.
 *
 * ### Who lands here, and what each sees
 *
 * Anybody who can reach the module *or* the employee floor — because everybody is
 * paid, and an employee who could not reach their own payslip would have nowhere
 * to find it. That mirrors the backend's floor on `/payroll/overview`.
 *
 * But the two readers see genuinely different pages, and the difference is
 * decided by the **server**, not here. `overview.canReadAll` is false for an
 * employee, and the shape they receive carries no open periods, no company
 * totals and no employee-gap count — those fields are empty or null before this
 * page ever sees them. This page renders what it was given; it does not filter a
 * fuller payload down, because a filter in the browser is not a boundary.
 *
 * ### The notice is not decoration
 *
 * `NOT_STATUTORY_NOTICE` appears on every payroll surface. This module computes
 * what it is configured to compute and makes no compliance claim, and somebody
 * about to act on these figures is entitled to know that before they do.
 */
export default async function PayrollPage() {
  const access = await requireModule('HR_PAYROLL');

  // The backend's own floor, mirrored. Not `access.allowed` alone — everybody is
  // paid, so requiring the module would lock out the people self-service is for.
  const mayReach =
    can(access.user, 'HR_PAYROLL', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');

  if (!mayReach) {
    return <NoModuleAccess module="HR_PAYROLL" />;
  }

  const canCreate = can(access.user, 'HR_PAYROLL', 'CREATE');
  const canAssign = can(access.user, 'HR_PAYROLL', 'ASSIGN');

  const result = await fetchPayrollOverview();

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="HR" title="Payroll" />
        <ErrorMessage message={result.message} />
      </div>
    );
  }

  const overview = result.data.overview;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR"
        title="Payroll"
        description={
          overview.canReadAll
            ? 'Compensation, monthly runs and payslips.'
            : 'Your pay and your payslips.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/payroll/my-payslips">My payslips</Link>
            </Button>
            {overview.canReadAll && (
              <Button asChild size="sm" variant="outline">
                <Link href="/hr/payroll/periods">All runs</Link>
              </Button>
            )}
            {canCreate && (
              <Button asChild size="sm">
                <Link href="/hr/payroll/periods/new">Open a run</Link>
              </Button>
            )}
          </div>
        }
      />

      {/*
        The employee's own payslip first, because for an ordinary reader it is the
        only part of this page that concerns them.
      */}
      {overview.myLatestPayslip ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Your latest payslip
            </span>
            <span className="text-sm font-medium text-ink">
              {overview.myLatestPayslip.periodName}
            </span>
            <span className="text-lg font-semibold text-ink">
              {formatMoney(overview.myLatestPayslip.netPay, overview.myLatestPayslip.currency)}
            </span>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/hr/payroll/payslips/${overview.myLatestPayslip.itemId}`}>
              View payslip
            </Link>
          </Button>
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-sm text-muted">
            You have no payslips yet. One appears here once a payroll run covering you
            is finalised.
          </p>
        </Card>
      )}

      {overview.canReadAll && (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Configuration
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Tile
                label="Salary components"
                value={String(overview.activeComponentCount)}
                href="/hr/payroll/components"
              />
              <Tile
                label="Salary structures"
                value={String(overview.activeStructureCount)}
                href="/hr/payroll/structures"
              />
              <Tile
                label="Awaiting approval"
                value={String(overview.awaitingApprovalCount)}
                href="/hr/payroll/periods?status=PENDING_APPROVAL"
                alarming={overview.awaitingApprovalCount > 0}
              />
              {/*
                The gap that matters most before a run: somebody with no salary
                assignment is silently excluded, and this is where that becomes
                visible rather than being discovered in the run's warnings.
              */}
              <Tile
                label="Employees without a salary"
                value={
                  overview.employeesWithoutSalaryCount === null
                    ? '—'
                    : String(overview.employeesWithoutSalaryCount)
                }
                href="/hr/payroll/salaries"
                alarming={(overview.employeesWithoutSalaryCount ?? 0) > 0}
              />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Open runs
              </h2>
              {canAssign && (
                <Button asChild size="sm" variant="ghost">
                  <Link href="/hr/payroll/salaries">Assign a salary</Link>
                </Button>
              )}
            </div>

            {overview.openPeriods.length === 0 ? (
              <EmptyState
                title="No open payroll runs"
                description={
                  canCreate
                    ? 'Open a run for a month to cost it.'
                    : 'Nothing is being costed at the moment.'
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {overview.openPeriods.map((period) => (
                  <li key={period.id}>
                    <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={`/hr/payroll/periods/${period.id}`}
                          className="text-sm font-medium text-accent hover:underline"
                        >
                          {period.name}
                        </Link>
                        <span className="text-xs text-muted">
                          {formatPeriodMonth(period.year, period.month)} · {period.code} ·{' '}
                          {period.employeeCount} employee
                          {period.employeeCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <Badge variant={PERIOD_STATUS_TONES[period.status]}>
                        {PERIOD_STATUS_SHORT[period.status]}
                      </Badge>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {overview.lastFinalizedPeriod && (
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Last finalised run
                </span>
                <span className="text-sm font-medium text-ink">
                  {overview.lastFinalizedPeriod.name}
                </span>
                {/*
                  "Total net pay", never "paid". Nothing in this module moves money.
                */}
                <span className="text-xs text-muted">
                  Total net pay{' '}
                  {formatMoney(
                    overview.lastFinalizedPeriod.netPay,
                    overview.lastFinalizedPeriod.currency,
                  )}
                </span>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/hr/payroll/periods/${overview.lastFinalizedPeriod.id}`}>
                  Open run
                </Link>
              </Button>
            </Card>
          )}
        </>
      )}

      <Card className="border-warning/30 bg-warning-soft p-4">
        <p className="text-xs text-warning">{NOT_STATUTORY_NOTICE}</p>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  href,
  alarming = false,
}: {
  label: string;
  value: string;
  href: string;
  alarming?: boolean;
}) {
  return (
    <Link href={href}>
      <Card className="flex flex-col gap-1 p-4 transition hover:border-accent/40">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
        <span
          className={`text-2xl font-semibold ${alarming ? 'text-critical' : 'text-ink'}`}
        >
          {value}
        </span>
      </Card>
    </Link>
  );
}
