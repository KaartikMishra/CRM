'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, type OrgUnitRef } from '@rs/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EMPLOYEE_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from './hr-labels';

/**
 * The directory's search and filters.
 *
 * State lives in the URL rather than in component state, which is the pattern the
 * other boards use and is the right one here for a specific reason: a filtered
 * directory is a thing people send each other. "Everyone in Operations on notice"
 * should be a link, and it is.
 *
 * Submitting resets the cursor by simply not carrying it forward — a filter change
 * invalidates the page position, and keeping the old cursor would start the new
 * result set partway through.
 */
export function EmployeeFilters({
  departments,
  current,
}: {
  departments: OrgUnitRef[];
  current: { q: string; status: string; departmentId: string; employmentType: string };
}) {
  const router = useRouter();
  const params = useSearchParams();

  function apply(key: string, value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Deliberately dropped: a new filter means a new result set, and the old
    // cursor would point into the middle of it.
    next.delete('cursor');
    router.push(`/hr/employees?${next.toString()}`);
  }

  const hasFilters = Boolean(
    current.q || current.status || current.departmentId || current.employmentType,
  );

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) => apply('q', String(formData.get('q') ?? ''))}
    >
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Search
        </span>
        <Input
          name="q"
          defaultValue={current.q}
          placeholder="Name, employee ID or work email"
          aria-label="Search employees"
        />
      </label>

      <Select
        label="Status"
        value={current.status}
        onChange={(value) => apply('status', value)}
        options={EMPLOYEE_STATUSES.map((status) => ({
          value: status,
          label: EMPLOYEE_STATUS_LABELS[status],
        }))}
      />

      <Select
        label="Department"
        value={current.departmentId}
        onChange={(value) => apply('departmentId', value)}
        options={departments.map((department) => ({
          value: department.id,
          label: department.name,
        }))}
      />

      <Select
        label="Employment"
        value={current.employmentType}
        onChange={(value) => apply('employmentType', value)}
        options={EMPLOYMENT_TYPES.map((type) => ({
          value: type,
          label: EMPLOYMENT_TYPE_LABELS[type],
        }))}
      />

      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>

      {hasFilters && (
        <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/hr/employees')}>
          Clear
        </Button>
      )}
    </form>
  );
}

/**
 * A plain native select.
 *
 * The shadcn `Select` is a popover that needs its own open state and does not
 * submit with a form. For a filter bar that writes to the URL on change, a native
 * element is fewer moving parts and keyboard-accessible for nothing.
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
