'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  ATTENDANCE_STATUSES,
  ATTENDANCE_WORK_MODES,
  type OrgUnitRef,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_WORK_MODE_LABELS } from './attendance-labels';

/**
 * The attendance board's filters.
 *
 * State lives in the URL, which is the pattern the other boards use and the right
 * one here: a filtered attendance view is a thing people send each other.
 * "Everybody in Operations who was late last month" should be a link, and it is.
 *
 * A filter change drops the cursor, because a new result set invalidates the page
 * position — keeping it would start the new list partway through.
 *
 * Note what this does NOT do: narrow what the viewer may see. A department filter
 * is ANDed with the server's scope, so a manager filtering by department still
 * sees only their own reports. That merge happens in the service, deliberately —
 * doing it here would be a permission decision in the browser.
 */
export function AttendanceFilters({
  departments,
  current,
}: {
  departments: OrgUnitRef[];
  current: {
    from: string;
    to: string;
    departmentId: string;
    status: string;
    workMode: string;
  };
}) {
  const router = useRouter();
  const params = useSearchParams();

  function apply(changes: Record<string, string>): void {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete('cursor');
    router.push(`/hr/attendance?${next.toString()}`);
  }

  const hasFilters = Boolean(current.departmentId || current.status || current.workMode);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) =>
        apply({
          from: String(formData.get('from') ?? ''),
          to: String(formData.get('to') ?? ''),
        })
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">From</span>
        <Input name="from" type="date" defaultValue={current.from} aria-label="From date" />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">To</span>
        <Input name="to" type="date" defaultValue={current.to} aria-label="To date" />
      </label>

      <Select
        label="Department"
        value={current.departmentId}
        onChange={(value) => apply({ departmentId: value })}
        options={departments.map((d) => ({ value: d.id, label: d.name }))}
      />

      <Select
        label="Status"
        value={current.status}
        onChange={(value) => apply({ status: value })}
        options={ATTENDANCE_STATUSES.map((s) => ({
          value: s,
          label: ATTENDANCE_STATUS_LABELS[s],
        }))}
      />

      <Select
        label="Work mode"
        value={current.workMode}
        onChange={(value) => apply({ workMode: value })}
        options={ATTENDANCE_WORK_MODES.map((m) => ({
          value: m,
          label: ATTENDANCE_WORK_MODE_LABELS[m],
        }))}
      />

      <Button type="submit" variant="outline" size="sm">
        Apply dates
      </Button>

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push('/hr/attendance')}
        >
          Clear
        </Button>
      )}
    </form>
  );
}

/**
 * A plain native select.
 *
 * The shadcn `Select` is a popover needing its own open state and does not submit
 * with a form. For a filter bar that writes to the URL on change, a native element
 * is fewer moving parts and keyboard-accessible for nothing — the same choice the
 * employee directory's filters make.
 */
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
