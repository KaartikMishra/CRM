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
import { fetchPayrollPeriods } from '@/lib/payroll-api';
import {
  PERIOD_STATUS_SHORT,
  PERIOD_STATUS_TONES,
  formatMoney,
  formatPeriodMonth,
} from '@/components/hr/payroll-labels';

export const metadata: Metadata = { title: 'Payroll runs' };

/**
 * Every payroll run.
 *
 * ### VIEW only — this is the administrative surface
 *
 * Unlike the dashboard and My Payslips, this page requires `HR_PAYROLL:VIEW`
 * outright, because it lists company-wide totals. An employee reaching it sees
 * the module-access notice rather than an empty list: there is no scoped version
 * of "every payroll run" that would be meaningful to them, and their own pay has
 * its own surface.
 *
 * The backend agrees — `GET /payroll/periods` is gated on VIEW, not the
 * self-service floor — so a reader who got past this check would still be
 * refused by the API.
 */
export default async function PayrollPeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; year?: string }>;
}) {
  const access = await requireModule('HR_PAYROLL');

  if (!can(access.user, 'HR_PAYROLL', 'VIEW')) {
    return <NoModuleAccess module="HR_PAYROLL" />;
  }

  const canCreate = can(access.user, 'HR_PAYROLL', 'CREATE');
  const filters = await searchParams;

  const result = await fetchPayrollPeriods({
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.year ? { year: Number(filters.year) } : {}),
    limit: 50,
  });

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Payroll" title="Payroll runs" />
        <ErrorMessage message={result.message} />
      </div>
    );
  }

  const periods = result.data.periods;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Payroll"
        title="Payroll runs"
        description="One run per calendar month."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/payroll">Dashboard</Link>
            </Button>
            {canCreate && (
              <Button asChild size="sm">
                <Link href="/hr/payroll/periods/new">Open a run</Link>
              </Button>
            )}
          </div>
        }
      />

      {filters.status && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">
            Filtered to {PERIOD_STATUS_SHORT[filters.status as 'DRAFT'] ?? filters.status}
          </span>
          <Button asChild size="sm" variant="ghost">
            <Link href="/hr/payroll/periods">Clear</Link>
          </Button>
        </div>
      )}

      {periods.length === 0 ? (
        <EmptyState
          title="No payroll runs"
          description={
            canCreate
              ? 'Open a run for a month to begin costing it.'
              : 'No runs have been opened yet.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <Th>Month</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th align="right">Employees</Th>
                <Th align="right">Gross</Th>
                <Th align="right">Net pay</Th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id} className="border-b border-line/60">
                  <td className="px-3 py-2">
                    <Link
                      href={`/hr/payroll/periods/${period.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {formatPeriodMonth(period.year, period.month)}
                    </Link>
                    {/*
                      The separation-of-duties signal, surfaced in the list so a
                      reader knows before opening a run that they cannot decide it.
                    */}
                    {period.viewerIsPaidByThisRun && (
                      <span className="ml-2 text-[11px] text-muted">(includes you)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">{period.code}</td>
                  <td className="px-3 py-2">
                    <Badge variant={PERIOD_STATUS_TONES[period.status]}>
                      {PERIOD_STATUS_SHORT[period.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">{period.employeeCount}</td>
                  <td className="px-3 py-2 text-right">
                    {period.totals
                      ? formatMoney(period.totals.grossEarnings, period.currency)
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {period.totals ? formatMoney(period.totals.netPay, period.currency) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.data.nextCursor && (
        <Card className="p-3">
          <p className="text-xs text-muted">
            More runs exist beyond this page. Narrow by year to see them.
          </p>
        </Card>
      )}
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
