'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays } from 'lucide-react';
import type { LeaveRequestRow } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/common/empty-state';
import { cancelLeaveAction, decideLeaveAction } from '@/app/(app)/hr/attendance-actions';
import {
  HALF_DAY_PERIOD_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUS_TONES,
  formatDayRange,
  formatHrDay,
  formatLeaveDays,
} from './attendance-labels';

/**
 * Leave requests — an employee's own list, or a reviewer's queue.
 *
 * The actions a row offers are decided by three things, and all three matter:
 *
 *   `canDecide`  whether the viewer may approve or reject at all, which the page
 *                asks the server about rather than inferring.
 *   `status`     only a PENDING request can be decided; a decided one never shows
 *                its buttons again. That is the UI half of the double-decision
 *                guard — the conditional update in the repository is the half that
 *                holds under concurrency.
 *   `isOwn`      the requester never sees approve/reject on their own request,
 *                because nobody decides their own and offering it would be a
 *                button that always fails.
 *
 * Cancellation is offered on a PENDING request, and on an APPROVED one only while
 * it is still in the future — mirroring the service, which refuses to reverse
 * leave that has already started because that is attendance history. A button the
 * API would reject is worse than no button.
 */
export function LeaveRequestList({
  requests,
  canDecide,
  showEmployee,
  ownEmployeeId,
}: {
  requests: LeaveRequestRow[];
  canDecide: boolean;
  showEmployee: boolean;
  /** The viewer's own employee id, where they have one. */
  ownEmployeeId: string | null;
}) {
  if (requests.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={canDecide ? 'Nothing to review' : 'No leave requests yet'}
        description={
          canDecide
            ? 'No request is waiting for a decision.'
            : 'Apply for leave and it will appear here.'
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {requests.map((request) => (
        <LeaveRequestRowCard
          key={request.id}
          request={request}
          canDecide={canDecide}
          showEmployee={showEmployee}
          isOwn={ownEmployeeId !== null && request.employee.id === ownEmployeeId}
        />
      ))}
    </ul>
  );
}

function LeaveRequestRowCard({
  request,
  canDecide,
  showEmployee,
  isOwn,
}: {
  request: LeaveRequestRow;
  canDecide: boolean;
  showEmployee: boolean;
  isOwn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  // Nobody decides their own, whatever else they hold — the service refuses it,
  // so offering the button would be offering a guaranteed failure.
  const decidable = canDecide && !isOwn && request.status === 'PENDING';

  /*
    Cancellable while pending, or approved and still in the future. The date
    comparison mirrors the service's rule rather than guessing: past leave is
    attendance history and is corrected, not reversed.
  */
  const startsInFuture = request.startDate > new Date().toISOString().slice(0, 10);
  const cancellable =
    isOwn && (request.status === 'PENDING' || (request.status === 'APPROVED' && startsInFuture));

  function decide(decision: 'APPROVED' | 'REJECTED'): void {
    if (decision === 'REJECTED' && note.trim().length === 0) {
      setMessage('Say why this is being rejected.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await decideLeaveAction(request.id, decision, note.trim() || undefined);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setRejecting(false);
      router.refresh();
    });
  }

  function cancel(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await cancelLeaveAction(request.id);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          {showEmployee && (
            <span className="text-sm font-medium text-ink">
              {request.employee.displayName}
              <span className="ml-2 text-xs text-muted">{request.employee.employeeId}</span>
            </span>
          )}
          <span className="text-sm text-ink-2">
            {request.leaveType.name} · {formatDayRange(request.startDate, request.endDate)}
          </span>
          <span className="text-xs text-muted">
            {formatLeaveDays(request.requestedDays)}
            {request.isHalfDay && request.halfDayPeriod
              ? ` · ${HALF_DAY_PERIOD_LABELS[request.halfDayPeriod]}`
              : ''}
          </span>
        </div>

        <Badge variant={LEAVE_STATUS_TONES[request.status]}>
          {LEAVE_STATUS_LABELS[request.status]}
        </Badge>
      </div>

      <p className="text-xs text-ink-2">{request.reason}</p>

      {request.decidedBy && (
        <p className="text-xs text-muted">
          {request.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {request.decidedBy.name}
          {request.decidedAt ? ` on ${formatHrDay(request.decidedAt)}` : ''}
          {request.decisionNote ? ` — ${request.decisionNote}` : ''}
        </p>
      )}

      {request.cancelledAt && (
        <p className="text-xs text-muted">Cancelled on {formatHrDay(request.cancelledAt)}</p>
      )}

      {(decidable || cancellable) && (
        <div className="flex flex-col gap-2">
          {rejecting && (
            <Textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why is this being rejected?"
              aria-label="Rejection reason"
            />
          )}

          <div className="flex flex-wrap gap-2">
            {decidable && !rejecting && (
              <>
                <Button size="sm" disabled={pending} onClick={() => decide('APPROVED')}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setRejecting(true)}
                >
                  Reject
                </Button>
              </>
            )}

            {decidable && rejecting && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => decide('REJECTED')}
                >
                  Confirm rejection
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                  Back
                </Button>
              </>
            )}

            {cancellable && !rejecting && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
                {request.status === 'PENDING' ? 'Withdraw' : 'Cancel leave'}
              </Button>
            )}
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * The balance cards.
 *
 * `available` arrives derived from the service — allocated + accrued + carried +
 * adjusted − used − reserved — and is deliberately not recomputed here. Showing
 * the components alongside it is what makes the figure defensible: somebody who
 * disputes "17 days" can see the 20 allocated, the 2 used and the 1 held.
 */
export function LeaveBalanceCards({
  balances,
}: {
  balances: { leaveType: { id: string; name: string }; available: string; used: string; reserved: string; allocated: string }[];
}) {
  if (balances.length === 0) {
    return (
      <p className="text-sm text-muted">
        No leave has been allocated to you yet. HR allocates entitlements for each year.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {balances.map((balance) => (
        <Card key={balance.leaveType.id} className="flex flex-col gap-1 p-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {balance.leaveType.name}
          </span>
          <span className="text-lg font-semibold text-ink">
            {formatLeaveDays(balance.available)}
          </span>
          <span className="text-xs text-muted">
            {balance.allocated} allocated · {balance.used} used
            {balance.reserved !== '0.00' ? ` · ${balance.reserved} held` : ''}
          </span>
        </Card>
      ))}
    </div>
  );
}
