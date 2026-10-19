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
import { fetchPayrollItems, fetchPayrollPeriod } from '@/lib/payroll-api';
import { PayrollWorkflowPanel } from '@/components/hr/payroll-panels';
import {
  BASIS_HINTS,
  BASIS_LABELS,
  EXCLUSION_REASON_LABELS,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_TONES,
  NOT_STATUTORY_NOTICE,
  PERIOD_STATUS_LABELS,
  PERIOD_STATUS_TONES,
  ROUNDING_LABELS,
  formatDays,
  formatMoney,
  formatPayrollDate,
  formatPayrollMoment,
  formatPeriodMonth,
  isNegative,
} from '@/components/hr/payroll-labels';

export const metadata: Metadata = { title: 'Payroll run' };

/**
 * One payroll run.
 *
 * ### Everything on this page was decided by the server
 *
 * `period.viewerCan` gates every control and `period.viewerIsPaidByThisRun`
 * drives the separation-of-duties notice. The item list arrives already scoped —
 * an employee reaching this page receives their own line and nothing else, which
 * is why the table below applies no filter of its own.
 *
 * ### The arithmetic policy is shown, not hidden
 *
 * `dailyRateBasis`, `roundingMode` and `payableDaysDivisor` are displayed
 * because they are what make the figures reproducible. The three bases disagree
 * by up to 10% on the same salary, so a reader checking a number by hand needs
 * to know which one produced it — and a finalised run keeps the policy it was
 * computed under forever.
 *
 * ### Negative net pay is flagged loudly
 *
 * A line whose deductions exceeded its earnings is real and blocks finalisation.
 * It is rendered in the critical tone rather than as an ordinary number, because
 * a negative figure that reads like any other is one somebody approves by
 * accident.
 */
export default async function PayrollPeriodPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireModule('HR_PAYROLL');

  const mayReach =
    can(access.user, 'HR_PAYROLL', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PAYROLL" />;
  }

  const { id } = await params;
  const [periodResult, itemsResult] = await Promise.all([
    fetchPayrollPeriod(id),
    fetchPayrollItems(id, { limit: 100 }),
  ]);

  if (!periodResult.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Payroll" title="Payroll run" />
        <ErrorMessage message={periodResult.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/payroll/periods">Back to runs</Link>
          </Button>
        </div>
      </div>
    );
  }

  const period = periodResult.data.period;
  const items = itemsResult.success ? itemsResult.data.items : [];
  const isAdministrator = can(access.user, 'HR_PAYROLL', 'VIEW');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Payroll run"
        title={formatPeriodMonth(period.year, period.month)}
        description={`${period.name} · ${period.code}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={PERIOD_STATUS_TONES[period.status]}>
              {PERIOD_STATUS_LABELS[period.status]}
            </Badge>
            {isAdministrator && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/hr/payroll/periods/${period.id}/summary`}>Summary</Link>
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/hr/payroll/periods">All runs</Link>
            </Button>
          </div>
        }
      />

      <PayrollWorkflowPanel period={period} />

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure
          label="Period"
          value={`${formatPayrollDate(period.periodStart)} – ${formatPayrollDate(period.periodEnd)}`}
        />
        <Figure label="Employees costed" value={String(period.employeeCount)} />
        <Figure
          label="Day basis"
          value={`${BASIS_LABELS[period.dailyRateBasis]}${period.payableDaysDivisor > 0 ? ` (÷ ${period.payableDaysDivisor})` : ''}`}
        />
        <Figure label="Rounding" value={ROUNDING_LABELS[period.roundingMode]} />
        <Figure label="Calendar days" value={String(period.calendarDays)} />
        <Figure label="Working days" value={String(period.workingDays)} />
      </Card>

      <Card className="p-3">
        <p className="text-xs text-muted">{BASIS_HINTS[period.dailyRateBasis]}</p>
      </Card>

      {period.totals && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Gross earnings"
            value={formatMoney(period.totals.grossEarnings, period.currency)}
          />
          <Tile
            label="Deductions"
            value={formatMoney(period.totals.totalDeductions, period.currency)}
          />
          <Tile
            label="Net pay"
            value={formatMoney(period.totals.netPay, period.currency)}
          />
          <Tile
            label="Employer contributions"
            value={formatMoney(period.totals.employerContributions, period.currency)}
            hint="A company cost. Not part of net pay."
          />
        </div>
      )}

      {/*
        Two counts a total would otherwise hide: who was left out, and whose net
        came out below zero. Both block or qualify a finalisation decision.
      */}
      {period.totals &&
        (period.totals.excludedCount > 0 || period.totals.negativeNetCount > 0) && (
          <Card className="flex flex-col gap-1 border-warning/30 bg-warning-soft p-3">
            {period.totals.excludedCount > 0 && (
              <p className="text-xs text-warning">
                {period.totals.excludedCount} employee
                {period.totals.excludedCount === 1 ? ' was' : 's were'} excluded from this
                run. Each exclusion records a reason.
              </p>
            )}
            {period.totals.negativeNetCount > 0 && (
              <p className="text-xs text-critical">
                {period.totals.negativeNetCount} employee
                {period.totals.negativeNetCount === 1 ? ' has' : 's have'} a negative net
                pay. This must be resolved before the run can be finalised.
              </p>
            )}
          </Card>
        )}

      {period.finalizedAt && (
        <Card className="flex flex-wrap gap-6 p-4">
          <Figure
            label="Finalised"
            value={formatPayrollMoment(period.finalizedAt)}
          />
          <Figure label="Finalised by" value={period.finalizedBy?.name ?? '—'} />
          <Figure label="Approved by" value={period.approvedBy?.name ?? '—'} />
          <Figure label="Costed by" value={period.calculatedBy?.name ?? '—'} />
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {isAdministrator ? 'Employees in this run' : 'Your line in this run'}
        </h2>

        {!itemsResult.success ? (
          <ErrorMessage message={itemsResult.message} />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing costed yet"
            description="Cost the run to see every employee's figures."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Employee</Th>
                  <Th>Status</Th>
                  <Th align="right">Payable days</Th>
                  <Th align="right">Gross</Th>
                  <Th align="right">Deductions</Th>
                  <Th align="right">Net pay</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-line/60">
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink">
                        {item.employee.displayName}
                      </span>
                      <span className="ml-2 text-xs text-muted">
                        {item.employee.employeeId}
                      </span>
                      {item.exclusionReason && (
                        <p className="text-xs text-muted">
                          {EXCLUSION_REASON_LABELS[item.exclusionReason]}
                          {item.exclusionNote ? ` — ${item.exclusionNote}` : ''}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={ITEM_STATUS_TONES[item.status]}>
                        {ITEM_STATUS_LABELS[item.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">{formatDays(item.payableDays)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatMoney(item.grossEarnings, item.currency)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {formatMoney(item.totalDeductions, item.currency)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${
                        isNegative(item.netPay) ? 'text-critical' : 'text-ink'
                      }`}
                    >
                      {formatMoney(item.netPay, item.currency)}
                      {item.status === 'FINALIZED' && (
                        <Link
                          href={`/hr/payroll/payslips/${item.id}`}
                          className="ml-2 text-xs text-accent hover:underline"
                        >
                          payslip
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Card className="border-warning/30 bg-warning-soft p-4">
        <p className="text-xs text-warning">{NOT_STATUTORY_NOTICE}</p>
      </Card>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-xl font-semibold text-ink">{value}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-sm font-medium text-ink">{value}</span>
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
