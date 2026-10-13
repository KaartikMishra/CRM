import type { Metadata } from 'next';
import { formatMinuteOfDay } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
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
import { CalendarCheck } from 'lucide-react';
import { fetchAttendancePolicies, fetchHolidays } from '@/lib/attendance-api';
import { requireModule } from '@/lib/require-module';
import { formatHrDay, describeWeekOff } from '@/components/hr/attendance-labels';

export const metadata: Metadata = { title: 'Attendance Settings' };

/**
 * Holidays, attendance policies and the week-off pattern.
 *
 * Gated on HR_ADMIN — the same grant that governs departments and designations,
 * because configuring the working week is structural rather than clerical. An HR
 * coordinator who maintains attendance records has no reason to change when the
 * company opens.
 *
 * Read-only in Phase 2, deliberately. The create and update endpoints exist and
 * are tested, but a configuration form that can shift every employee's expected
 * hours deserves more care than a first pass — see the limitations in the report.
 * Everything here is the data those endpoints produce.
 */
export default async function AttendanceSettingsPage() {
  const access = await requireModule('HR_ADMIN');
  if (!access.allowed) return <NoModuleAccess module="HR_ADMIN" />;

  const [holidays, policies] = await Promise.all([
    fetchHolidays({}),
    fetchAttendancePolicies(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Attendance settings"
        description="When the company is closed, and what a working day looks like."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Attendance policies
        </h2>

        {!policies.success ? (
          <ErrorMessage message={policies.message} />
        ) : policies.data.policies.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No policy configured"
            description="Attendance falls back to 09:30–18:30 with 15 minutes' grace until one is set up."
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy</TableHead>
                    <TableHead>Hours</TableHead>
                    <TableHead>Grace</TableHead>
                    <TableHead>Full / half day</TableHead>
                    <TableHead>Overtime after</TableHead>
                    <TableHead>Weekly off</TableHead>
                    <TableHead>Scope</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.data.policies.map((policy) => (
                    <TableRow key={policy.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-ink">{policy.name}</span>
                          <span className="font-mono text-xs text-muted">{policy.code}</span>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-ink-2">
                        {formatMinuteOfDay(policy.expectedStartMinute)} –{' '}
                        {formatMinuteOfDay(policy.expectedEndMinute)}
                      </TableCell>
                      <TableCell className="text-ink-2">{policy.graceMinutes}m</TableCell>
                      <TableCell className="text-ink-2">
                        {Math.round(policy.fullDayMinutes / 60)}h /{' '}
                        {Math.round(policy.halfDayMinutes / 60)}h
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {Math.round(policy.overtimeThresholdMinutes / 60)}h
                      </TableCell>
                      <TableCell className="text-xs text-ink-2">
                        {describeWeekOff(policy.weekOffDays)}
                      </TableCell>
                      <TableCell>
                        {policy.isDefault ? (
                          <Badge variant="accent">Company default</Badge>
                        ) : policy.department ? (
                          <Badge variant="outline">{policy.department.name}</Badge>
                        ) : (
                          <Badge variant="outline">Unscoped</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Holidays
        </h2>

        {!holidays.success ? (
          <ErrorMessage message={holidays.message} />
        ) : holidays.data.holidays.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No holidays configured"
            description="Holidays are set by the business — no national calendar is assumed."
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Holiday</TableHead>
                    <TableHead>Applies to</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holidays.data.holidays.map((holiday) => (
                    <TableRow key={holiday.id}>
                      <TableCell className="whitespace-nowrap text-ink-2">
                        {formatHrDay(holiday.holidayDate)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-ink">{holiday.name}</span>
                          {holiday.description && (
                            <span className="text-xs text-muted">{holiday.description}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-ink-2">
                        {holiday.department ? holiday.department.name : 'Whole company'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={holiday.isActive ? 'positive' : 'outline'}>
                          {holiday.isActive ? 'Active' : 'Cancelled'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
