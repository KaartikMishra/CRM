'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ATTENDANCE_WORK_MODES, type AttendanceCorrectionView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  decideCorrectionAction,
  requestCorrectionAction,
} from '@/app/(app)/hr/attendance-actions';
import {
  ATTENDANCE_WORK_MODE_LABELS,
  CORRECTION_STATUS_LABELS,
  DECISION_STATUS_TONES,
  formatClockTime,
  formatHrDay,
} from './attendance-labels';

/**
 * Raising a correction — "I forgot to clock out".
 *
 * Sends the requested times, which is the one place in attendance where a
 * client-supplied timestamp is legitimate: this is a *request*, somebody else
 * reviews it, and an approved one stamps the record `CORRECTION` so a future
 * Payroll phase can tell it from a self-recorded day.
 *
 * The form asks for at least one change, mirroring the API's rule and the database
 * CHECK. Two checks for one rule, because being told before submitting is kinder
 * than being told after — the API's is the one that decides.
 */
export function CorrectionRequestForm({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const date = text('attendanceDate');
    const clockIn = text('clockIn');
    const clockOut = text('clockOut');
    const mode = text('workMode');
    const reason = text('reason');

    if (!date) {
      setFieldErrors({ attendanceDate: 'Choose the date being corrected' });
      return;
    }
    if (!reason || reason.length < 5) {
      setFieldErrors({ reason: 'Say what needs correcting and why' });
      return;
    }
    if (!clockIn && !clockOut && !mode) {
      // The same rule the API and a CHECK both enforce: a correction that asks for
      // nothing is not a correction.
      setFieldErrors({ clockIn: 'Ask for at least one change' });
      return;
    }

    startTransition(async () => {
      const result = await requestCorrectionAction({
        attendanceDate: new Date(`${date}T00:00:00.000Z`),
        ...(clockIn ? { requestedClockInAt: new Date(`${date}T${clockIn}:00.000+05:30`) } : {}),
        ...(clockOut ? { requestedClockOutAt: new Date(`${date}T${clockOut}:00.000+05:30`) } : {}),
        ...(mode ? { requestedWorkMode: mode as never } : {}),
        reason,
      } as never);

      if (!result.ok) {
        setMessage(result.message);
        if (result.details) {
          setFieldErrors(
            Object.fromEntries(result.details.map((d) => [d.path, d.message])),
          );
        }
        return;
      }

      setOpen(false);
      onDone?.();
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Request a correction
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Request an attendance correction
      </h3>

      <form action={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="attendanceDate"
            label="Date"
            type="date"
            required
            error={fieldErrors.attendanceDate}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="workMode">Work mode</Label>
            <select
              id="workMode"
              name="workMode"
              defaultValue=""
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              <option value="">Leave unchanged</option>
              {ATTENDANCE_WORK_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {ATTENDANCE_WORK_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/*
          Times are entered as company-time wall clock and sent with an explicit
          +05:30 offset, so what the person typed is what the server stores. Sending
          a bare local time would be interpreted in the browser's zone and a
          colleague abroad would correct the wrong hour.
        */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field name="clockIn" label="Clock in (IST)" type="time" error={fieldErrors.clockIn} />
          <Field name="clockOut" label="Clock out (IST)" type="time" error={fieldErrors.clockOut} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="reason">
            Reason<span className="text-critical"> *</span>
          </Label>
          <Textarea id="reason" name="reason" rows={3} aria-invalid={Boolean(fieldErrors.reason)} />
          {fieldErrors.reason && (
            <span className="text-xs text-critical">{fieldErrors.reason}</span>
          )}
        </div>

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Send request'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The correction list — history for an employee, a queue for a reviewer.
 *
 * `canDecide` comes from the page, which asks the server what the viewer may do.
 * A decided row never renders its buttons again: that is the UI half of the
 * double-decision guard, and the conditional update in the repository is the half
 * that actually holds under concurrency.
 */
export function CorrectionList({
  corrections,
  canDecide,
  showEmployee,
}: {
  corrections: AttendanceCorrectionView[];
  canDecide: boolean;
  showEmployee: boolean;
}) {
  if (corrections.length === 0) {
    return (
      <p className="text-sm text-muted">
        {canDecide ? 'Nothing is waiting for a decision.' : 'No corrections raised yet.'}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {corrections.map((correction) => (
        <CorrectionRow
          key={correction.id}
          correction={correction}
          canDecide={canDecide}
          showEmployee={showEmployee}
        />
      ))}
    </ul>
  );
}

function CorrectionRow({
  correction,
  canDecide,
  showEmployee,
}: {
  correction: AttendanceCorrectionView;
  canDecide: boolean;
  showEmployee: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  // Only a pending request can be decided, and only by somebody entitled. The
  // service refuses anything else regardless of what this renders.
  const decidable = canDecide && correction.status === 'PENDING';

  function decide(decision: 'APPROVED' | 'REJECTED'): void {
    if (decision === 'REJECTED' && note.trim().length === 0) {
      setMessage('Say why this is being rejected.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await decideCorrectionAction(correction.id, decision, note.trim() || undefined);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setRejecting(false);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          {showEmployee && (
            <span className="text-sm font-medium text-ink">
              {correction.employee.displayName}
              <span className="ml-2 text-xs text-muted">{correction.employee.employeeId}</span>
            </span>
          )}
          <span className="text-sm text-ink-2">{formatHrDay(correction.attendanceDate)}</span>
        </div>
        <Badge variant={DECISION_STATUS_TONES[correction.status]}>
          {CORRECTION_STATUS_LABELS[correction.status]}
        </Badge>
      </div>

      {/*
        Both sides, side by side. The request snapshots what the record held when
        it was raised, so a reviewer sees the change without the record having been
        mutated first — and the evidence survives even if the record changes later.
      */}
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold uppercase tracking-wider text-muted">Currently</span>
          <span className="text-ink-2">
            In {formatClockTime(correction.currentClockInAt)} · Out{' '}
            {formatClockTime(correction.currentClockOutAt)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold uppercase tracking-wider text-muted">Requested</span>
          <span className="text-ink-2">
            In {formatClockTime(correction.requestedClockInAt)} · Out{' '}
            {formatClockTime(correction.requestedClockOutAt)}
            {correction.requestedWorkMode
              ? ` · ${ATTENDANCE_WORK_MODE_LABELS[correction.requestedWorkMode]}`
              : ''}
          </span>
        </div>
      </div>

      <p className="text-xs text-ink-2">{correction.reason}</p>

      {correction.decidedBy && (
        <p className="text-xs text-muted">
          {correction.status === 'APPROVED' ? 'Approved' : 'Rejected'} by{' '}
          {correction.decidedBy.name}
          {correction.decisionNote ? ` — ${correction.decisionNote}` : ''}
        </p>
      )}

      {decidable && (
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

          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => decide('APPROVED')}>
              Approve
            </Button>
            {rejecting ? (
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
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setRejecting(true)}
              >
                Reject
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

function Field({
  name,
  label,
  type,
  required = false,
  error,
}: {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <Input id={name} name={name} type={type} aria-invalid={Boolean(error)} />
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}
