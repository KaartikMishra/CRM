'use client';

import { useMemo, useState } from 'react';
import type { EmployeeRow } from '@rs/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * A searchable employee picker.
 *
 * ### No new endpoint, and no new permission
 *
 * The candidates come from the existing `GET /api/hr/employees`, fetched by the
 * *page* (a server component) and passed in. That endpoint is already scoped
 * server-side — `visibleEmployeeFilter` is ANDed into the query, so a manager sees
 * their reports and HR sees everybody — and this list is whatever the reader was
 * already entitled to see in the directory. Nothing was widened to populate a
 * dropdown.
 *
 * ### And no sensitive field reaches the browser
 *
 * `EmployeeRow` carries name, employee code, department, designation, status and
 * whether they hold a login. No salary, no date of birth, no personal contact — the
 * Phase 1 schema deliberately never collected most of that, and the picker shows a
 * subset even of what it does carry: name, code and department. The work email is
 * part of the row but is not rendered, because a picker does not need it and a
 * screen that shows it invites copying it somewhere else.
 *
 * ### Why the filtering is local
 *
 * The list arrives bounded by the server's own page size and the reader's scope. A
 * keystroke-driven refetch would mean an authenticated request per character from a
 * client component, and the set a picker chooses from is small. If a deployment
 * outgrows one page, the right fix is a server-side `q` on the page's own fetch —
 * the endpoint already supports it — not a client that queries.
 *
 * The hidden input is what the form reads, so this submits with FormData exactly
 * like the plain fields beside it.
 */
export function EmployeePicker({
  name,
  label,
  employees,
  required = false,
  error,
  defaultValue,
  /** Employees to leave out — the viewer themselves, say, where self-selection is refused. */
  excludeIds = [],
  hint,
}: {
  name: string;
  label: string;
  employees: EmployeeRow[];
  required?: boolean;
  error?: string;
  defaultValue?: string;
  excludeIds?: string[];
  hint?: string;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(defaultValue ?? '');

  const available = useMemo(
    () => employees.filter((employee) => !excludeIds.includes(employee.id)),
    [employees, excludeIds],
  );

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return available;
    return available.filter((employee) => {
      const haystack = [
        employee.displayName,
        employee.employeeId,
        employee.department?.name ?? '',
        employee.designation?.name ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [available, search]);

  const selected = available.find((employee) => employee.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${name}-search`}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>

      {/* What the form actually submits. */}
      <input type="hidden" name={name} value={selectedId} />

      {selected ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2">
          <span className="text-sm text-ink">
            {selected.displayName}
            <span className="ml-2 text-xs text-muted">{selected.employeeId}</span>
            {selected.department && (
              <span className="ml-2 text-xs text-muted">· {selected.department.name}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setSelectedId('');
              setSearch('');
            }}
            className="text-xs text-accent hover:underline"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <Input
            id={`${name}-search`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, employee id or department"
            aria-invalid={Boolean(error)}
            autoComplete="off"
          />

          {available.length === 0 ? (
            /*
              An empty list is not a failure state — it is what somebody with no
              reports and no HR grant correctly sees. Saying so beats an empty box
              that looks broken.
            */
            <span className="text-xs text-muted">
              Nobody available to pick. You can only choose from employees you are
              able to see.
            </span>
          ) : (
            <ul
              className="max-h-56 overflow-y-auto rounded-md border border-line"
              role="listbox"
              aria-label={label}
            >
              {matches.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-muted">
                  Nobody matches &ldquo;{search.trim()}&rdquo;.
                </li>
              ) : (
                matches.slice(0, 50).map((employee) => (
                  <li key={employee.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(employee.id)}
                      className="flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="text-sm text-ink">{employee.displayName}</span>
                      <span className="text-xs text-muted">
                        {employee.employeeId}
                        {employee.department ? ` · ${employee.department.name}` : ''}
                        {employee.designation ? ` · ${employee.designation.name}` : ''}
                      </span>
                    </button>
                  </li>
                ))
              )}
              {/*
                Capped at fifty rendered rows. The list is already bounded by the
                server's page size; this stops a wide search painting hundreds of
                rows nobody will scroll through.
              */}
              {matches.length > 50 && (
                <li className="px-2.5 py-2 text-xs text-muted">
                  {matches.length - 50} more — narrow the search.
                </li>
              )}
            </ul>
          )}
        </>
      )}

      {hint && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}
