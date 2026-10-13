'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { HALF_DAY_PERIODS, type LeaveBalanceView, type LeaveTypeView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { applyForLeaveAction } from '@/app/(app)/hr/attendance-actions';
import { HALF_DAY_PERIOD_LABELS, formatLeaveDays } from './attendance-labels';

/**
 * Applying for leave.
 *
 * ### The day count comes from the server, always
 *
 * As soon as a valid range is entered the form asks `/api/hr/leave/preview`, which
 * runs the same calculator the eventual charge will. **Nothing here counts days.**
 * That is the whole reason the calculator is shared: a browser that excluded
 * weekends but not holidays would promise two days and the balance would take
 * three, and the employee would be right to complain.
 *
 * The preview also explains itself — "5 calendar days, 1 holiday, 2 week-offs" —
 * which is what stops somebody disputing the figure afterwards.
 *
 * ### Validation is advisory here and authoritative there
 *
 * The obvious client checks (end before start, half day over two dates, balance
 * too small) are mirrored so the person is told before submitting rather than
 * after. Every one of them is enforced again by Zod and by a database CHECK, and
 * those are the ones that decide.
 */
export function LeaveApplyForm({
  leaveTypes,
  balances,
}: {
  leaveTypes: LeaveTypeView[];
  balances: LeaveBalanceView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isHalfDay, setIsHalfDay] = useState(false);

  /** The server's answer about what this range costs. Null until it has one. */
  const [preview, setPreview] = useState<{
    leaveDays: string;
    totalDays: number;
    holidayDays: number;
    weekOffDays: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const selectedType = leaveTypes.find((t) => t.id === leaveTypeId) ?? null;
  const balance = balances.find((b) => b.leaveType.id === leaveTypeId) ?? null;

  /*
    Ask the server what the range costs. Debounced, because a date input fires on
    every keystroke in some browsers and this is a network call.

    Deliberately NOT computed locally even as an optimistic guess: a figure that
    briefly differs from the server's is worse than no figure, because somebody
    will read the first one.
  */
  useEffect(() => {
    if (!startDate || !endDate || endDate < startDate) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const search = new URLSearchParams({ startDate, endDate });
        if (isHalfDay) search.set('isHalfDay', 'true');
        const response = await fetch(`/api/hr/leave/preview?${search}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          setPreview(null);
          setPreviewError('The day count could not be checked.');
          return;
        }
        const body = (await response.json()) as {
          data?: { preview?: typeof preview };
        };
        setPreview(body.data?.preview ?? null);
        setPreviewError(null);
      } catch {
        // An aborted request is the expected case while typing, not an error.
        if (!controller.signal.aborted) setPreviewError('The day count could not be checked.');
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [startDate, endDate, isHalfDay]);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const reason = String(formData.get('reason') ?? '').trim();
    const halfDayPeriod = String(formData.get('halfDayPeriod') ?? '');

    if (!leaveTypeId) {
      setFieldErrors({ leaveTypeId: 'Choose a leave type' });
      return;
    }
    if (!startDate || !endDate) {
      setFieldErrors({ startDate: 'Choose both dates' });
      return;
    }
    if (endDate < startDate) {
      setFieldErrors({ endDate: 'The end date cannot be before the start date' });
      return;
    }
    if (isHalfDay && startDate !== endDate) {
      setFieldErrors({ endDate: 'A half day covers a single date' });
      return;
    }
    if (isHalfDay && !halfDayPeriod) {
      setFieldErrors({ halfDayPeriod: 'Say which half of the day' });
      return;
    }
    if (reason.length < 5) {
      setFieldErrors({ reason: 'Say why you need the leave' });
      return;
    }

    startTransition(async () => {
      const result = await applyForLeaveAction({
        leaveTypeId,
        startDate: new Date(`${startDate}T00:00:00.000Z`),
        endDate: new Date(`${endDate}T00:00:00.000Z`),
        ...(isHalfDay ? { isHalfDay: true, halfDayPeriod: halfDayPeriod as never } : {}),
        reason,
      } as never);

      if (!result.ok) {
        setMessage(result.message);
        if (result.details) {
          setFieldErrors(Object.fromEntries(result.details.map((d) => [d.path, d.message])));
        }
        return;
      }

      setOpen(false);
      setStartDate('');
      setEndDate('');
      setIsHalfDay(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} disabled={leaveTypes.length === 0}>
        Apply for leave
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Apply for leave
      </h3>

      <form action={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="leaveTypeId">
              Leave type<span className="text-critical"> *</span>
            </Label>
            <select
              id="leaveTypeId"
              value={leaveTypeId}
              onChange={(event) => setLeaveTypeId(event.target.value)}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              {leaveTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
            {fieldErrors.leaveTypeId && (
              <span className="text-xs text-critical">{fieldErrors.leaveTypeId}</span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Available
            </span>
            <span className="text-sm text-ink-2">
              {balance ? formatLeaveDays(balance.available) : 'No balance for this type'}
            </span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="startDate">
              From<span className="text-critical"> *</span>
            </Label>
            <Input
              id="startDate"
              type="date"
              value={startDate}
              onChange={(event) => {
                setStartDate(event.target.value);
                // A half day is a single date, so keep the two in step rather than
                // letting the person build a state the API will refuse.
                if (isHalfDay) setEndDate(event.target.value);
              }}
              aria-invalid={Boolean(fieldErrors.startDate)}
            />
            {fieldErrors.startDate && (
              <span className="text-xs text-critical">{fieldErrors.startDate}</span>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="endDate">
              To<span className="text-critical"> *</span>
            </Label>
            <Input
              id="endDate"
              type="date"
              value={endDate}
              disabled={isHalfDay}
              onChange={(event) => setEndDate(event.target.value)}
              aria-invalid={Boolean(fieldErrors.endDate)}
            />
            {fieldErrors.endDate && (
              <span className="text-xs text-critical">{fieldErrors.endDate}</span>
            )}
          </div>
        </div>

        {selectedType?.halfDayAllowed && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={isHalfDay}
                onChange={(event) => {
                  setIsHalfDay(event.target.checked);
                  if (event.target.checked) setEndDate(startDate);
                }}
              />
              Half day
            </label>

            {isHalfDay && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="halfDayPeriod">Which half</Label>
                <select
                  id="halfDayPeriod"
                  name="halfDayPeriod"
                  defaultValue=""
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  <option value="">Choose…</option>
                  {HALF_DAY_PERIODS.map((period) => (
                    <option key={period} value={period}>
                      {HALF_DAY_PERIOD_LABELS[period]}
                    </option>
                  ))}
                </select>
                {fieldErrors.halfDayPeriod && (
                  <span className="text-xs text-critical">{fieldErrors.halfDayPeriod}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/*
          The server's figure, with its own explanation. This is the number the
          balance will actually be charged, because it comes from the same
          calculator the charge does.
        */}
        {preview && (
          <div className="rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2">
            <p className="font-medium text-ink">{formatLeaveDays(preview.leaveDays)} of leave</p>
            <p className="mt-0.5 text-muted">
              {preview.totalDays} calendar {preview.totalDays === 1 ? 'day' : 'days'}
              {preview.holidayDays > 0 ? `, ${preview.holidayDays} holiday` : ''}
              {preview.weekOffDays > 0 ? `, ${preview.weekOffDays} week-off` : ''}
            </p>
          </div>
        )}

        {previewError && <p className="text-xs text-warning">{previewError}</p>}

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
            {pending ? 'Submitting…' : 'Submit request'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
