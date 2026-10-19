import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { EmptyState } from '@/components/common/empty-state';
import { NoModuleAccess } from '@/components/common/no-module-access';
import { requireModule } from '@/lib/require-module';
import { can } from '@/lib/current-user';
import { fetchMyPayroll } from '@/lib/payroll-api';
import {
  NOT_STATUTORY_NOTICE,
  formatMoney,
  formatPayrollDate,
  formatPeriodMonth,
} from '@/components/hr/payroll-labels';

export const metadata: Metadata = { title: 'My payslips' };

/**
 * An employee's own pay and payslips.
 *
 * ### This page cannot be pointed at anybody else
 *
 * It calls `fetchMyPayroll()`, which takes **no employee id**. There is no
 * parameter to tamper with and no query string that would widen it — the API
 * resolves the reader's own employee record from their session and returns that
 * and nothing else.
 *
 * That is a deliberately stronger design than an `/employees/:id/pay` route with
 * a scope check. A check can be got wrong; an absent parameter cannot be
 * supplied. It is also why there is no "view another employee" control here even
 * for a payroll administrator: they use the run's item list, which is a
 * different surface with its own VIEW gate.
 *
 * ### An account with no employee record
 *
 * A shared operations login, or an administrator who is not on the payroll, gets
 * an explanatory empty state rather than an error. They are not broken; they
 * simply have no pay to show.
 */
export default async function MyPayslipsPage() {
  const access = await requireModule('HR_PAYROLL');

  const mayReach =
    can(access.user, 'HR_PAYROLL', 'VIEW') || can(access.user, 'HR_EMPLOYEE', 'VIEW');
  if (!mayReach) {
    return <NoModuleAccess module="HR_PAYROLL" />;
  }

  const result = await fetchMyPayroll();

  if (!result.success) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Payroll" title="My payslips" />
        <ErrorMessage message={result.message} />
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/payroll">Back to payroll</Link>
          </Button>
        </div>
      </div>
    );
  }

  const mine = result.data.mine;

  // No HR record at all: not an error, just nothing to show.
  if (!mine.employee) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Payroll" title="My payslips" />
        <EmptyState
          title="Your account is not linked to an employee record"
          description="Payslips are issued against an employee record. Ask HR to link your account if you expect to see pay here."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Payroll"
        title="My payslips"
        description={mine.employee.displayName}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/hr/payroll">Back to payroll</Link>
          </Button>
        }
      />

      {mine.currentSalary ? (
        <Card className="flex flex-wrap gap-6 p-4">
          <Figure
            label="Monthly gross"
            value={formatMoney(mine.currentSalary.monthlyGross, mine.currentSalary.currency)}
          />
          <Figure
            label="In force since"
            value={formatPayrollDate(mine.currentSalary.effectiveFrom)}
          />
          <Figure label="Structure" value={mine.currentSalary.structureName ?? 'Not set'} />
        </Card>
      ) : (
        <Card className="p-4">
          <p className="text-sm text-muted">
            No salary is currently assigned to your record. Ask HR if you expect one.
          </p>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Payslips
        </h2>

        {mine.payslips.length === 0 ? (
          <EmptyState
            title="No payslips yet"
            description="A payslip appears here once a payroll run covering you has been finalised."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {mine.payslips.map((slip) => (
              <li key={slip.itemId}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="flex flex-col gap-0.5">
                    <Link
                      href={`/hr/payroll/payslips/${slip.itemId}`}
                      className="text-sm font-medium text-accent hover:underline"
                    >
                      {formatPeriodMonth(slip.year, slip.month)}
                    </Link>
                    <span className="text-xs text-muted">
                      {slip.periodCode} · issued {formatPayrollDate(slip.finalizedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                        Net pay
                      </span>
                      <span className="text-sm font-semibold text-ink">
                        {formatMoney(slip.netPay, slip.currency)}
                      </span>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/hr/payroll/payslips/${slip.itemId}`}>View</Link>
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="border-warning/30 bg-warning-soft p-4">
        <p className="text-xs text-warning">{NOT_STATUTORY_NOTICE}</p>
      </Card>
    </div>
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
