import type { Metadata } from 'next';
import Link from 'next/link';
import { formatMinutes } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import { NoModuleAccess } from '@/components/common/no-module-access';
import {
  fetchAttendance,
  fetchAttendanceSummary,
  fetchAttendanceToday,
  fetchCorrections,
} from '@/lib/attendance-api';
import { fetchDepartments } from '@/lib/hr-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { AttendanceClock } from '@/components/hr/attendance-clock';
import { AttendanceTable } from '@/components/hr/attendance-table';
import { AttendanceFilters } from '@/components/hr/attendance-filters';
import { CorrectionList, CorrectionRequestForm } from '@/components/hr/correction-panel';

export const metadata: Metadata = { title: 'Attendance' };

/**
 * The attendance page — self service and, for those entitled, the board.
 *
 * ### Why this is not gated on HR_ATTENDANCE
 *
 * `requireModule` is called for the *verdict*, not to block: an ordinary employee
 * holding no HR permission must still be able to clock in, or every employee in
 * the company needs a grant and the grant stops meaning anything. The API scopes
 * every read to what the viewer may see — their own rows, a manager's team, or
 * everybody for HR — and refuses every write it should.
 *
 * So the page renders for anyone signed in, and each section is decided by what
 * the server actually returned rather than by a permission check here. Hiding a
 * section is a courtesy; the API is the authority.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_ATTENDANCE');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  /*
    Whether to show the board at all. Somebody with HR_ATTENDANCE:VIEW manages
    other people's attendance; everybody else gets their own history, which the
    same endpoint returns because the scope decides.
  */
  const managesOthers = access.allowed && can(access.user, 'HR_ATTENDANCE', 'VIEW');

  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const todayKey = today.toISOString().slice(0, 10);

  const [todayResult, boardResult, summaryResult, correctionsResult, departments] =
    await Promise.all([
      fetchAttendanceToday(),
      fetchAttendance({
        from: single('from') ?? monthStart,
        to: single('to') ?? todayKey,
        employeeId: single('employeeId'),
        departmentId: single('departmentId'),
        status: single('status'),
        workMode: single('workMode'),
        cursor: single('cursor'),
        limit: '25',
      }),
      fetchAttendanceSummary({ from: single('from') ?? monthStart, to: single('to') ?? todayKey }),
      // The reviewer's queue when they can decide, otherwise their own history.
      fetchCorrections(managesOthers ? { mine: 'true', limit: '25' } : { limit: '25' }),
      managesOthers ? fetchDepartments({ status: 'ACTIVE', limit: '100' }) : Promise.resolve(null),
    ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Attendance"
        description="Your day, and — if you manage people — theirs."
      />

      {/*
        The clock. A failure here is reported rather than hidden: somebody who
        cannot clock in needs to know why, and an absent widget would read as
        "there is nothing to do today".
      */}
      {!todayResult.success ? (
        <ErrorMessage message={todayResult.message} />
      ) : (
        <AttendanceClock today={todayResult.data.today} />
      )}

      {summaryResult.success && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Present" value={String(summaryResult.data.summary.presentDays)} />
          <Tile label="Half days" value={String(summaryResult.data.summary.halfDays)} />
          <Tile label="Absent" value={String(summaryResult.data.summary.absentDays)} />
          <Tile label="On leave" value={String(summaryResult.data.summary.leaveDays)} />
          <Tile label="Worked" value={formatMinutes(summaryResult.data.summary.workedMinutes)} />
          <Tile label="Overtime" value={formatMinutes(summaryResult.data.summary.overtimeMinutes)} />
        </div>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {managesOthers ? 'Attendance records' : 'Your attendance'}
          </h2>
        </div>

        {managesOthers && (
          <AttendanceFilters
            departments={departments?.success ? departments.data.departments : []}
            current={{
              from: single('from') ?? monthStart,
              to: single('to') ?? todayKey,
              departmentId: single('departmentId') ?? '',
              status: single('status') ?? '',
              workMode: single('workMode') ?? '',
            }}
          />
        )}

        {!boardResult.success ? (
          <ErrorMessage message={boardResult.message} />
        ) : (
          <>
            <AttendanceTable
              rows={boardResult.data.attendance}
              filtered={Boolean(single('status') || single('departmentId') || single('workMode'))}
              showEmployee={managesOthers}
            />
            {boardResult.data.nextCursor && (
              <div className="flex justify-end">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/hr/attendance?cursor=${boardResult.data.nextCursor}`}>
                    Next page
                  </Link>
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {managesOthers ? 'Corrections awaiting a decision' : 'Your corrections'}
        </h2>

        {!managesOthers && <CorrectionRequestForm />}

        {!correctionsResult.success ? (
          <ErrorMessage message={correctionsResult.message} />
        ) : (
          <Card className="p-4">
            <CorrectionList
              corrections={correctionsResult.data.corrections}
              /*
                Whether the viewer may decide. The server refuses a decision from
                anybody who may not — including the requester, whatever else they
                hold — so this only decides whether to draw the buttons.
              */
              canDecide={managesOthers}
              showEmployee={managesOthers}
            />
          </Card>
        )}
      </section>

      {access.allowed && can(access.user, 'HR_ADMIN', 'VIEW') && (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/attendance/settings">Holidays &amp; policies</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-lg font-semibold text-ink">{value}</span>
    </Card>
  );
}
