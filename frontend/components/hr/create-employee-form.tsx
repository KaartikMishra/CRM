'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { EMPLOYMENT_TYPES, WORK_MODES, type OrgUnitRef } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createEmployeeAction } from '@/app/(app)/hr/actions';
import { EMPLOYMENT_TYPE_LABELS, WORK_MODE_LABELS } from './hr-labels';

/**
 * The add-employee form.
 *
 * Sectioned rather than one long column, matching how the profile reads it back —
 * identity, then organization, then employment.
 *
 * Note what it does not collect: no employee ID field (allocated by the server
 * from an atomic counter — a browser-supplied one would collide under concurrent
 * creates), no status (a new record is ACTIVE, and every move after that goes
 * through the status endpoint so it writes history), and no date of birth, gender,
 * home address or emergency contact. Those need a stated purpose and a retention
 * rule before they are collected, and Phase 1 has neither.
 *
 * Field-level errors come back from the server's Zod result and are shown against
 * the field that failed. There is deliberately no client-side mirror of those
 * rules: two validators drift, and the server's is the one that decides.
 */
export function CreateEmployeeForm({
  departments,
  designations,
}: {
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function onSubmit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const value = formData.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const joiningDate = text('joiningDate');
    if (!joiningDate) {
      setFieldErrors({ joiningDate: 'A joining date is required' });
      return;
    }

    startTransition(async () => {
      const result = await createEmployeeAction({
        firstName: text('firstName') ?? '',
        middleName: text('middleName'),
        lastName: text('lastName') ?? '',
        workEmail: text('workEmail') ?? '',
        phone: text('phone'),
        departmentId: text('departmentId'),
        designationId: text('designationId'),
        employmentType: text('employmentType') as never,
        workMode: text('workMode') as never,
        location: text('location'),
        joiningDate: new Date(joiningDate),
      } as never);

      if (!result.ok) {
        setMessage(result.message);
        if (result.details) {
          setFieldErrors(
            Object.fromEntries(result.details.map((detail) => [detail.path, detail.message])),
          );
        }
        return;
      }

      router.push(`/hr/employees/${result.data.employee.id}`);
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Identity
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field name="firstName" label="First name" required error={fieldErrors.firstName} />
          <Field name="middleName" label="Middle name" error={fieldErrors.middleName} />
          <Field name="lastName" label="Last name" required error={fieldErrors.lastName} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="workEmail"
            label="Work email"
            type="email"
            required
            error={fieldErrors.workEmail}
          />
          <Field name="phone" label="Phone" error={fieldErrors.phone} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Organization
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <NativeSelect
            name="departmentId"
            label="Department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
            error={fieldErrors.departmentId}
          />
          <NativeSelect
            name="designationId"
            label="Designation"
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
            error={fieldErrors.designationId}
          />
        </div>
        <p className="text-xs text-muted">
          A reporting line can be set from the profile once the record exists.
        </p>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Employment
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="joiningDate"
            label="Joining date"
            type="date"
            required
            error={fieldErrors.joiningDate}
          />
          <Field name="location" label="Location" error={fieldErrors.location} />
          <NativeSelect
            name="employmentType"
            label="Employment type"
            defaultValue="FULL_TIME"
            includeBlank={false}
            options={EMPLOYMENT_TYPES.map((t) => ({
              value: t,
              label: EMPLOYMENT_TYPE_LABELS[t],
            }))}
            error={fieldErrors.employmentType}
          />
          <NativeSelect
            name="workMode"
            label="Work mode"
            defaultValue="ON_SITE"
            includeBlank={false}
            options={WORK_MODES.map((m) => ({ value: m, label: WORK_MODE_LABELS[m] }))}
            error={fieldErrors.workMode}
          />
        </div>
      </Card>

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add employee'}
        </Button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required = false,
  error,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <Input id={name} name={name} type={type} required={required} aria-invalid={Boolean(error)} />
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}

function NativeSelect({
  name,
  label,
  options,
  defaultValue,
  includeBlank = true,
  error,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  includeBlank?: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-invalid={Boolean(error)}
        className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        {includeBlank && <option value="">Not set</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}
