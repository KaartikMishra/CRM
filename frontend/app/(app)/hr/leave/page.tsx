import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { ErrorMessage } from '@/components/common/error-message';
import {
  fetchLeaveBalances,
  fetchLeaveRequests,
  fetchLeaveTypes,
} from '@/lib/attendance-api';
import { can } from '@/lib/current-user';
import { requireModule } from '@/lib/require-module';
import { LeaveApplyForm } from '@/components/hr/leave-apply-form';
import { LeaveBalanceCards, LeaveRequestList } from '@/components/hr/leave-requests';

export const metadata: Metadata = { title: 'Leave' };

/**
 * The leave page — balances and self service, plus an approval queue for those
 * entitled to one.
 *
 * Not gated on HR_LEAVE, for the same reason attendance is not: an employee must
 * be able to apply for their own leave without an HR grant, or every employee
 * needs one. The API scopes every read and refuses every write it should.
 *
 * Both sections are shown to a reviewer: their own requests (which they cannot
 * decide) and the queue (which excludes their own). Separating them is what stops
 * the queue showing work nobody can do.
 */
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireModule('HR_LEAVE');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // Whether this person reviews other people's leave. HR_LEAVE:APPROVE or being
  // somebody's manager — the second is a fact about employee rows, so the queue
  // endpoint decides and an empty queue is the honest answer either way.
  const reviews =
    access.allowed &&
    (can(access.user, 'HR_LEAVE', 'APPROVE') || can(access.user, 'HR_LEAVE', 'VIEW'));

  const [balances, leaveTypes, own, queue] = await Promise.all([
    fetchLeaveBalances({}),
    fetchLeaveTypes({ isActive: 'true' }),
    fetchLeaveRequests({ limit: '25', cursor: single('cursor') }),
    // `mine=true` means "requests I may decide": pending, and never the viewer's
    // own. Requested for everybody — a manager with no HR grant has a queue too.
    fetchLeaveRequests({ mine: 'true', limit: '25' }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="HR & Workforce"
        title="Leave"
        description="What you have left, what you have asked for, and what needs your decision."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Your balances
        </h2>
        {!balances.success ? (
          <ErrorMessage message={balances.message} />
        ) : (
          <LeaveBalanceCards balances={balances.data.balances} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Your requests
          </h2>
          {leaveTypes.success && balances.success && (
            <LeaveApplyForm
              leaveTypes={leaveTypes.data.leaveTypes}
              balances={balances.data.balances}
            />
          )}
        </div>

        {!own.success ? (
          <ErrorMessage message={own.message} />
        ) : (
          <Card className="p-4">
            <LeaveRequestList
              requests={own.data.requests}
              /* Never on one's own list: nobody decides their own. */
              canDecide={false}
              showEmployee={false}
              ownEmployeeId={own.data.requests[0]?.employee.id ?? null}
            />
          </Card>
        )}

        {own.success && own.data.nextCursor && (
          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={`/hr/leave?cursor=${own.data.nextCursor}`}>Next page</Link>
            </Button>
          </div>
        )}
      </section>

      {/*
        The queue. Rendered whenever the endpoint returned anything a reviewer can
        act on — a manager with no HR permission reaches it through the reporting
        line, which no permission check here could see.
      */}
      {queue.success && queue.data.requests.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Awaiting your decision
          </h2>
          <Card className="p-4">
            <LeaveRequestList
              requests={queue.data.requests}
              canDecide
              showEmployee
              ownEmployeeId={null}
            />
          </Card>
        </section>
      )}

      {access.allowed && can(access.user, 'HR_ADMIN', 'VIEW') && (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href="/hr/leave/settings">Leave types &amp; policies</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
