'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  APPLICATION_STAGES,
  APPLICATION_STATUSES,
  CANDIDATE_SOURCES,
  JOB_PRIORITIES,
  JOB_REQUISITION_STATUSES,
  type OrgUnitRef,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  APPLICATION_STAGE_LABELS,
  APPLICATION_STATUS_LABELS,
  CANDIDATE_SOURCE_LABELS,
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
} from './recruitment-labels';

/**
 * Recruitment filter bars.
 *
 * State lives in the URL, which is the pattern every other board uses and the right
 * one here: "open engineering roles" and "everybody at final interview" are things
 * people send each other, and they should be links.
 *
 * A filter change drops the cursor, because a new result set invalidates the page
 * position — keeping it would start the new list partway through.
 *
 * Note what these do NOT do: narrow what the viewer may see. A department filter is
 * ANDed with the server's scope, so a hiring manager filtering by department still
 * sees only their own vacancies. That merge happens in the service, deliberately —
 * doing it here would be a permission decision in the browser.
 */

export function JobFilters({
  departments,
  current,
}: {
  departments: OrgUnitRef[];
  current: { status: string; priority: string; departmentId: string; search: string };
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
    router.push(`/hr/recruitment/jobs?${next.toString()}`);
  }

  const hasFilters = Boolean(
    current.status || current.priority || current.departmentId || current.search,
  );

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) => apply({ search: String(formData.get('search') ?? '') })}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Search
        </span>
        <Input
          name="search"
          defaultValue={current.search}
          placeholder="Title or code"
          aria-label="Search roles"
        />
      </label>

      <Select
        label="Status"
        value={current.status}
        onChange={(value) => apply({ status: value })}
        options={JOB_REQUISITION_STATUSES.map((s) => ({ value: s, label: JOB_STATUS_LABELS[s] }))}
      />

      <Select
        label="Priority"
        value={current.priority}
        onChange={(value) => apply({ priority: value })}
        options={JOB_PRIORITIES.map((p) => ({ value: p, label: JOB_PRIORITY_LABELS[p] }))}
      />

      <Select
        label="Department"
        value={current.departmentId}
        onChange={(value) => apply({ departmentId: value })}
        options={departments.map((d) => ({ value: d.id, label: d.name }))}
      />

      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push('/hr/recruitment/jobs')}
        >
          Clear
        </Button>
      )}
    </form>
  );
}

export function CandidateFilters({
  current,
}: {
  current: { source: string; search: string };
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
    router.push(`/hr/recruitment/candidates?${next.toString()}`);
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) => apply({ search: String(formData.get('search') ?? '') })}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Search
        </span>
        <Input
          name="search"
          defaultValue={current.search}
          placeholder="Name or email"
          aria-label="Search candidates"
        />
      </label>

      <Select
        label="Source"
        value={current.source}
        onChange={(value) => apply({ source: value })}
        options={CANDIDATE_SOURCES.map((s) => ({ value: s, label: CANDIDATE_SOURCE_LABELS[s] }))}
      />

      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>

      {(current.source || current.search) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push('/hr/recruitment/candidates')}
        >
          Clear
        </Button>
      )}
    </form>
  );
}

export function ApplicationFilters({
  current,
  basePath,
}: {
  current: { stage: string; status: string; search: string };
  /** Which list this filters — the applications board, or one job's applications. */
  basePath: string;
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
    router.push(`${basePath}?${next.toString()}`);
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      action={(formData) => apply({ search: String(formData.get('search') ?? '') })}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Search
        </span>
        <Input
          name="search"
          defaultValue={current.search}
          placeholder="Candidate name or email"
          aria-label="Search applications"
        />
      </label>

      <Select
        label="Stage"
        value={current.stage}
        onChange={(value) => apply({ stage: value })}
        options={APPLICATION_STAGES.map((s) => ({
          value: s,
          label: APPLICATION_STAGE_LABELS[s],
        }))}
      />

      <Select
        label="Status"
        value={current.status}
        onChange={(value) => apply({ status: value })}
        options={APPLICATION_STATUSES.map((s) => ({
          value: s,
          label: APPLICATION_STATUS_LABELS[s],
        }))}
      />

      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>

      {(current.stage || current.status || current.search) && (
        <Button type="button" variant="ghost" size="sm" onClick={() => router.push(basePath)}>
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
 * with a form. For a filter bar that writes to the URL on change, a native element is
 * fewer moving parts and keyboard-accessible for nothing — the same choice the
 * attendance filters and the employee directory make.
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
