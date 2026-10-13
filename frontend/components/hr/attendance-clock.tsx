'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ATTENDANCE_WORK_MODES, formatMinutes, type AttendanceToday } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  clockInAction,
  clockOutAction,
  endBreakAction,
  startBreakAction,
} from '@/app/(app)/hr/attendance-actions';
import {
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUS_TONES,
  ATTENDANCE_WORK_MODE_LABELS,
  SESSION_STATE_LABELS,
  describeToday,
  formatClockTime,
} from './attendance-labels';

/**
 * The employee's own clock.
 *
 * ### The server decides what is possible
 *
 * Every button is driven by `canClockIn`, `canClockOut`, `canStartBreak` and
 * `canEndBreak`, which arrive on the payload already decided by the service from
 * the session state machine. The browser does not work them out: a page left open
 * across a clock-out in another tab would otherwise offer actions the API refuses,
 * and two implementations of the same state machine drift.
 *
 * Hiding a button is a courtesy, not the protection — the service refuses the
 * transition regardless, and `attendance.calc.ts` is where the rule lives.
 *
 * ### No timestamps
 *
 * None of these actions sends a time. The moment comes from Postgres, so a wrong
 * or deliberately-set browser clock cannot move attendance.
 */
export function AttendanceClock({ today }: { today: AttendanceToday }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [workMode, setWorkMode] = useState<string>('OFFICE');

  const record = today.record;

  function run(action: () => Promise<{ ok: boolean; message?: string }>): void {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        // The API's message verbatim: it knows why, and paraphrasing would risk
        // saying something different from what actually happened.
        setMessage(result.message ?? 'That could not be done.');
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Today
          </span>
          <span className="text-lg font-semibold text-ink">{describeToday(today)}</span>
          <span className="text-xs text-muted">
            {today.attendanceDate}
            {today.policy ? ` · ${today.policy.name}` : ' · no policy configured'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {record && (
            <Badge variant={ATTENDANCE_STATUS_TONES[record.status]}>
              {ATTENDANCE_STATUS_LABELS[record.status]}
            </Badge>
          )}
          <Badge variant="outline">
            {SESSION_STATE_LABELS[record?.sessionState ?? 'NONE']}
          </Badge>
        </div>
      </div>

      {/*
        Figures, every one of them computed by the service. Shown only once the
        session is closed: a running day's "worked time" would be a number the
        browser had to keep recomputing, and it would disagree with the server the
        moment the tab slept.
      */}
      {record && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Clock in" value={formatClockTime(record.clockInAt)} />
          <Figure label="Clock out" value={formatClockTime(record.clockOutAt)} />
          <Figure label="Worked" value={formatMinutes(record.workedMinutes)} />
          <Figure label="Break" value={formatMinutes(record.breakMinutes)} />
          <Figure
            label="Late"
            value={record.lateMinutes > 0 ? formatMinutes(record.lateMinutes) : '—'}
            tone={record.lateMinutes > 0 ? 'warning' : undefined}
          />
          <Figure
            label="Overtime"
            value={record.overtimeMinutes > 0 ? formatMinutes(record.overtimeMinutes) : '—'}
          />
        </div>
      )}

      {record && record.earlyExitMinutes > 0 && (
        <p className="text-xs text-warning">
          Left {formatMinutes(record.earlyExitMinutes)} before the expected end of day.
        </p>
      )}

      {today.openBreak && (
        <p className="text-xs text-muted">
          Break started at {formatClockTime(today.openBreak.startedAt)}.
        </p>
      )}

      {/*
        Work mode is offered only at clock-in, because it describes where the day
        was worked and changing it mid-session would make the record ambiguous. HR
        amends it through a correction, which records who decided.
      */}
      {today.canClockIn && (
        <label className="flex max-w-xs flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Working from
          </span>
          <select
            value={workMode}
            onChange={(event) => setWorkMode(event.target.value)}
            aria-label="Work mode"
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            {ATTENDANCE_WORK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {ATTENDANCE_WORK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {/*
          Each button is rendered only when the server says the transition is
          available, so there is no "clocked in twice" path to defend against in
          the UI — and the API still refuses one if a stale page tries.
        */}
        {today.canClockIn && (
          <Button disabled={pending} onClick={() => run(() => clockInAction(workMode))}>
            {pending ? 'Clocking in…' : 'Clock in'}
          </Button>
        )}

        {today.canStartBreak && (
          <Button variant="outline" disabled={pending} onClick={() => run(startBreakAction)}>
            {pending ? 'Starting…' : 'Start break'}
          </Button>
        )}

        {today.canEndBreak && (
          <Button variant="outline" disabled={pending} onClick={() => run(endBreakAction)}>
            {pending ? 'Ending…' : 'End break'}
          </Button>
        )}

        {today.canClockOut && (
          <Button variant="outline" disabled={pending} onClick={() => run(() => clockOutAction())}>
            {pending ? 'Clocking out…' : 'Clock out'}
          </Button>
        )}

        {/*
          The completed state. Deliberately a sentence rather than disabled
          buttons: a greyed-out "Clock in" after a finished day invites somebody to
          keep clicking it, while saying the day is done explains why there is
          nothing to press.
        */}
        {!today.canClockIn &&
          !today.canClockOut &&
          !today.canStartBreak &&
          !today.canEndBreak && (
            <p className="text-sm text-muted">
              {today.onLeave
                ? 'Nothing to record — you are on approved leave.'
                : record?.sessionState === 'CLOSED'
                  ? 'Your day is recorded. Raise a correction if anything is wrong.'
                  : 'No attendance actions are available today.'}
            </p>
          )}
      </div>

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warning';
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className={tone === 'warning' ? 'text-sm text-warning' : 'text-sm text-ink-2'}>
        {value}
      </span>
    </div>
  );
}
