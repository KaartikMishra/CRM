import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchPayslip } from '@/lib/payroll-api';
import {
  formatDays,
  formatMinutes,
  formatMoney,
  formatPayrollDate,
  formatPeriodMonth,
} from '@/components/hr/payroll-labels';

export const metadata: Metadata = { title: 'Payslip' };

/**
 * One payslip.
 *
 * ### Everything here came from a frozen snapshot
 *
 * The API serves this from `PayrollItem.snapshot`, written once inside the
 * finalisation transaction and never updated afterwards. Nothing is recomputed —
 * not by the server and certainly not here. Every input could legitimately have
 * changed since: the component rate, the structure, the employee's assignment,
 * the attendance policy. A payslip that recomputed itself would quietly restate
 * what somebody was paid.
 *
 * ### Not found rather than forbidden
 *
 * A payslip outside the reader's scope returns **404**. Telling somebody "you may
 * not read employee X's payslip" would confirm that X is paid and roughly when,
 * which is the thing the confidentiality rule exists to prevent. So this page
 * cannot distinguish "does not exist" from "not yours", and that is correct.
 *
 * ### `notApplied` is rendered, always
 *
 * The snapshot carries what the computation did *not* include — unvalued
 * overtime, absent deductions, the standing compliance caveat. A payslip that
 * omitted those would imply completeness it cannot claim.
 */
export default async function PayslipPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const access = await requireModule('HR_PAYROLL');

  const mayReach =
    can(access.user, 'HR_PAYROLL', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PAYROLL" />;
  }

  const { itemId } = await params;
  const result = await fetchPayslip(itemId);

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Payroll" title="Payslip" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/payroll/my-payslips">Back to my payslips</Link>
          </Button>
        </div>
      </div>
    );
  }

  const slip = result.data.payslip;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Payslip"
        title={formatPeriodMonth(slip.period.year, slip.period.month)}
        description={`${slip.employee.displayName} · ${slip.employee.employeeId}`}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/payroll/my-payslips">All payslips</Link>
          </Button>
        }
      />

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Employee" value={slip.employee.displayName} />
        <Figure label="Department" value={slip.employee.departmentName ?? '—'} />
        <Figure label="Designation" value={slip.employee.designationName ?? '—'} />
        <Figure
          label="Period"
          value={`${formatPayrollDate(slip.period.periodStart)} – ${formatPayrollDate(slip.period.periodEnd)}`}
        />
        <Figure label="Reference" value={slip.period.code} />
        <Figure label="Issued" value={formatPayrollDate(slip.finalizedAt)} />
      </Card>

      <Card className="flex flex-wrap gap-6 p-4">
        <Figure label="Payable days" value={formatDays(slip.attendance.payableDays)} />
        <Figure
          label="Unpaid leave"
          value={formatDays(slip.attendance.unpaidLeaveDays)}
        />
        <Figure
          label="Overtime"
          value={formatMinutes(slip.attendance.overtimeMinutes)}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <LineGroup
          title="Earnings"
          lines={slip.earnings}
          total={slip.grossEarnings}
          totalLabel="Gross earnings"
          currency={slip.currency}
        />
        <LineGroup
          title="Deductions"
          lines={slip.deductions}
          total={slip.totalDeductions}
          totalLabel="Total deductions"
          currency={slip.currency}
        />
      </div>

      <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
        <span className="text-sm font-semibold uppercase tracking-wider text-muted">
          Net pay
        </span>
        <span className="text-2xl font-semibold text-ink">
          {formatMoney(slip.netPay, slip.currency)}
        </span>
      </Card>

      {/*
        Employer contributions are shown separately and are NOT part of net pay.
        Folding them in would understate what the employee received; omitting them
        entirely would hide a real cost of their employment. Stated, and labelled.
      */}
      {slip.employerContributions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Employer contributions
          </h2>
          <Card className="flex flex-col gap-2 p-4">
            <p className="text-xs text-muted">
              Paid by the company in addition to your salary. These do not reduce your
              net pay.
            </p>
            {slip.employerContributions.map((line) => (
              <div key={line.label} className="flex items-center justify-between gap-4">
                <span className="text-sm text-ink">{line.label}</span>
                <span className="text-sm text-ink">
                  {formatMoney(line.amount, slip.currency)}
                </span>
              </div>
            ))}
          </Card>
        </section>
      )}

      {slip.notApplied.length > 0 && (
        <Card className="border-warning/30 bg-warning-soft p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-warning">
            What this payslip does not include
          </h2>
          <ul className="mt-2 flex flex-col gap-1">
            {slip.notApplied.map((note) => (
              <li key={note} className="text-xs text-warning">
                {note}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function LineGroup({
  title,
  lines,
  total,
  totalLabel,
  currency,
}: {
  title: string;
  lines: Array<{ label: string; amount: string }>;
  total: string;
  totalLabel: string;
  currency: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </h2>
      <Card className="flex flex-col gap-2 p-4">
        {lines.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          lines.map((line) => (
            <div key={line.label} className="flex items-center justify-between gap-4">
              <span className="text-sm text-ink">{line.label}</span>
              <span className="text-sm text-ink">{formatMoney(line.amount, currency)}</span>
            </div>
          ))
        )}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-line pt-2">
          <span className="text-sm font-semibold text-ink">{totalLabel}</span>
          <span className="text-sm font-semibold text-ink">
            {formatMoney(total, currency)}
          </span>
        </div>
      </Card>
    </section>
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
