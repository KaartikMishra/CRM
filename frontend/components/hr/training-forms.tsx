'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PASSING_SCORE,
  TRAINING_MODULE_KINDS,
  TRAINING_OBLIGATIONS,
  type OrgUnitRef,
  type TrainingCategoryView,
  type TrainingProgramSummary,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  addModuleAction,
  assignTrainingAction,
  createProgramAction,
  updateProgramAction,
} from '@/app/(app)/hr/training-actions';
import { MODULE_KIND_LABELS, OBLIGATION_LABELS } from './training-labels';

/**
 * The Phase 4 authoring and assignment forms.
 *
 * Same shape as the Phase 3 forms, for the same reason: check the obvious things so
 * the person is told before submitting, then send and relay whatever the server says.
 * Every check here is mirrored by Zod and most by a database CHECK, and **those are
 * the ones that decide**.
 *
 * Nothing here computes a business value. No program code is invented (the server
 * allocates it from an atomic counter), no status is set (a program is born DRAFT and
 * publishing is its own act), no score is calculated, and no module is marked
 * complete.
 */

type Field = { path: string; message: string };

function errorsFrom(details: Field[] | undefined): Record<string, string> {
  return Object.fromEntries((details ?? []).map((d) => [d.path, d.message]));
}

function reader(formData: FormData) {
  return (key: string): string | undefined => {
    const value = formData.get(key);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed === '' ? undefined : trimmed;
  };
}

// ---------------------------------------------------------------------------
//  Program
// ---------------------------------------------------------------------------

/**
 * Creating or amending a program.
 *
 * ### The pass mark and the attempt allowance are fields, not constants
 *
 * `DEFAULT_PASSING_SCORE` (80) and `DEFAULT_MAX_ATTEMPTS` (3) appear here only as
 * placeholder text. Left blank, the column defaults apply — so the business default
 * lives in exactly one place and a program that wants a different threshold simply
 * states one. Nothing in the services reads the constant.
 *
 * ### `seedRequiredJourney` seeds; it does not constrain
 *
 * Checked, the server materialises the thirteen-step required journey as ordinary
 * module rows. They are plain data afterwards — reorderable, removable, extendable —
 * and no service consults the template again. That is the whole point: the journey is
 * a default template, not a hard-coded state machine.
 *
 * Offered on create only. Re-seeding an existing program would collide with the
 * modules already in it.
 */
export function ProgramForm({
  categories,
  departments,
  designations,
  program,
}: {
  categories: TrainingCategoryView[];
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
  /** Present when amending. Absent when creating. */
  program?: TrainingProgramSummary & {
    description: string | null;
    objectives: string | null;
    requiresPractical: boolean;
    requiresShadowing: boolean;
    requiresFinalAssessment: boolean;
    dueWithinDays: number | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const editing = program !== undefined;

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = reader(formData);
    const title = text('title');
    if (!title || title.length < 2) {
      setFieldErrors({ title: 'Name the program' });
      return;
    }

    const passingScore = text('passingScore');
    const maxAttempts = text('maxAttempts');
    const estimatedMinutes = text('estimatedMinutes');
    const dueWithinDays = text('dueWithinDays');

    const payload = {
      title,
      description: text('description'),
      objectives: text('objectives'),
      categoryId: text('categoryId'),
      targetDepartmentId: text('targetDepartmentId'),
      targetDesignationId: text('targetDesignationId'),
      obligation: text('obligation'),
      estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
      passingScore: passingScore ? Number(passingScore) : undefined,
      maxAttempts: maxAttempts ? Number(maxAttempts) : undefined,
      requiresPractical: formData.get('requiresPractical') === 'on',
      requiresShadowing: formData.get('requiresShadowing') === 'on',
      requiresFinalAssessment: formData.get('requiresFinalAssessment') === 'on',
      dueWithinDays: dueWithinDays ? Number(dueWithinDays) : undefined,
    };

    startTransition(async () => {
      const result = editing
        ? await updateProgramAction(program.id, payload)
        : await createProgramAction({
            ...payload,
            seedRequiredJourney: formData.get('seedRequiredJourney') === 'on',
          });

      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      router.push(`/hr/training/programs/${result.data.program.id}`);
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="title"
            label="Program title"
            required
            error={fieldErrors.title}
            defaultValue={program?.title}
            placeholder="New Joiner Induction"
          />
          <SelectField
            name="categoryId"
            label="Category"
            options={categories
              .filter((category) => category.isActive || category.id === program?.category?.id)
              .map((category) => ({ value: category.id, label: category.name }))}
            defaultValue={program?.category?.id}
          />
          <SelectField
            name="obligation"
            label="Obligation"
            options={TRAINING_OBLIGATIONS.map((o) => ({
              value: o,
              label: OBLIGATION_LABELS[o],
            }))}
            defaultValue={program?.obligation}
            placeholder="Required"
          />
          <TextField
            name="estimatedMinutes"
            label="Estimated effort (minutes)"
            type="number"
            error={fieldErrors.estimatedMinutes}
            defaultValue={program?.estimatedMinutes?.toString()}
          />
          <SelectField
            name="targetDepartmentId"
            label="Intended for department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
            defaultValue={program?.targetDepartment?.id}
            placeholder="Everybody"
          />
          <SelectField
            name="targetDesignationId"
            label="Intended for designation"
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
            defaultValue={program?.targetDesignation?.id}
            placeholder="Everybody"
          />
        </div>

        {/*
          The qualification policy. Blank means the column default — which is where
          the business default of 80 / 3 lives. The number typed here is the one the
          assessment services compare against; nothing reads the constant.
        */}
        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Passing policy
          </legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              name="passingScore"
              label="Pass mark (%)"
              type="number"
              step="0.01"
              error={fieldErrors.passingScore}
              defaultValue={program ? program.passingScore : undefined}
              placeholder={String(DEFAULT_PASSING_SCORE)}
            />
            <TextField
              name="maxAttempts"
              label="Attempts allowed"
              type="number"
              error={fieldErrors.maxAttempts}
              defaultValue={program?.maxAttempts.toString()}
              placeholder={String(DEFAULT_MAX_ATTEMPTS)}
            />
            <TextField
              name="dueWithinDays"
              label="Due within (days)"
              type="number"
              error={fieldErrors.dueWithinDays}
              defaultValue={program?.dueWithinDays?.toString()}
            />
          </div>
          <p className="text-xs text-muted">
            Left blank, a program uses the company default of {DEFAULT_PASSING_SCORE}% over{' '}
            {DEFAULT_MAX_ATTEMPTS} attempts.
          </p>
        </fieldset>

        {/*
          The gates. These flags are what `qualificationGaps` is computed from, so
          turning one on genuinely adds a requirement between a learner and live work.
        */}
        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Required before live work
          </legend>
          <CheckField
            name="requiresPractical"
            label="An approved practical exercise"
            defaultChecked={program?.requiresPractical ?? true}
          />
          <CheckField
            name="requiresShadowing"
            label="A signed-off shadowing period"
            defaultChecked={program?.requiresShadowing ?? true}
          />
          <CheckField
            name="requiresFinalAssessment"
            label="A passed final assessment"
            defaultChecked={program?.requiresFinalAssessment ?? true}
          />
        </fieldset>

        <AreaField
          name="description"
          label="About this program"
          defaultValue={program?.description ?? undefined}
        />
        <AreaField
          name="objectives"
          label="What the learner will be able to do"
          defaultValue={program?.objectives ?? undefined}
        />

        {!editing && (
          <fieldset className="flex flex-col gap-2 rounded-md border border-brass-line bg-brass-soft p-3">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Starting point
            </legend>
            <CheckField
              name="seedRequiredJourney"
              label="Start from the standard learning journey"
              defaultChecked
            />
            <p className="text-xs text-ink-2">
              Creates the thirteen standard steps — introduction through final assessment —
              as ordinary modules. You can reorder, remove or add to them afterwards.
            </p>
          </fieldset>
        )}

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create program'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Module authoring
// ---------------------------------------------------------------------------

/**
 * Adding a step to a program.
 *
 * `sortOrder` is not offered: the server appends to the end, which is what somebody
 * building a sequence wants, and the sequence is rearranged afterwards by reordering
 * rather than by typing position numbers into a form.
 *
 * Instructions become required for a PRACTICAL or SHADOWING step — checked here so
 * the author is told before submitting, and enforced by Zod and by the
 * `training_module_practical_has_instructions` CHECK regardless.
 */
export function AddModuleForm({ programId }: { programId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<(typeof TRAINING_MODULE_KINDS)[number]>('LESSON');
  const [open, setOpen] = useState(false);

  const needsInstructions = kind === 'PRACTICAL' || kind === 'SHADOWING';

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = reader(formData);
    const title = text('title');
    if (!title || title.length < 2) {
      setFieldErrors({ title: 'Name this step' });
      return;
    }

    const instructions = text('instructions');
    if (needsInstructions && !instructions) {
      setFieldErrors({
        instructions: 'A practical or shadowing step has to say what the learner should do',
      });
      return;
    }

    const estimatedMinutes = text('estimatedMinutes');

    startTransition(async () => {
      const result = await addModuleAction(programId, {
        title,
        kind,
        content: text('content'),
        referenceUrl: text('referenceUrl'),
        instructions,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
        isRequired: formData.get('isRequired') === 'on',
      });

      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      setOpen(false);
      setKind('LESSON');
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a step
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="title"
            label="Step title"
            required
            error={fieldErrors.title}
            placeholder="Product Training"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="module-kind">
              Kind<span className="text-critical"> *</span>
            </Label>
            <select
              id="module-kind"
              name="kind"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as (typeof TRAINING_MODULE_KINDS)[number])
              }
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              {TRAINING_MODULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MODULE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <TextField
            name="referenceUrl"
            label="Reference link"
            error={fieldErrors.referenceUrl}
            placeholder="https://…"
          />
          <TextField
            name="estimatedMinutes"
            label="Estimated effort (minutes)"
            type="number"
            error={fieldErrors.estimatedMinutes}
          />
        </div>

        {kind === 'ASSESSMENT' && (
          <p className="rounded-md border border-brass-line bg-brass-soft p-2.5 text-xs text-ink-2">
            Save this step, then build its question paper from the step itself. A test with
            no questions cannot be sat.
          </p>
        )}

        <AreaField name="content" label="Learning content" />

        <div className="flex flex-col gap-1">
          <Label htmlFor="instructions">
            Instructions to the learner
            {needsInstructions && <span className="text-critical"> *</span>}
          </Label>
          <Textarea
            id="instructions"
            name="instructions"
            rows={3}
            aria-invalid={Boolean(fieldErrors.instructions)}
            placeholder={
              needsInstructions
                ? 'What should the learner do, and what will the reviewer look for?'
                : undefined
            }
          />
          {fieldErrors.instructions && (
            <span className="text-xs text-critical">{fieldErrors.instructions}</span>
          )}
        </div>

        <CheckField
          name="isRequired"
          label="Required — the next step stays locked until this one is done"
          defaultChecked
        />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Add step'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Assignment
// ---------------------------------------------------------------------------

/**
 * Assigning a program.
 *
 * Exactly one target — named people, a department, or a designation. Checked here
 * because telling somebody after a round trip that they picked two is poor, and
 * enforced by the schema's refine regardless.
 *
 * The due date is optional: left blank, the server derives it from the program's
 * `dueWithinDays` against company time. This form does no date arithmetic — a
 * browser in another timezone would compute a different day.
 */
export function AssignTrainingForm({
  programs,
  departments,
  designations,
}: {
  /** Published programs only — an unpublished one cannot be assigned. */
  programs: TrainingProgramSummary[];
  departments: OrgUnitRef[];
  designations: OrgUnitRef[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<'employees' | 'department' | 'designation'>(
    'department',
  );

  const assignable = programs.filter((program) => program.status === 'ACTIVE');

  function submit(formData: FormData): void {
    setMessage(null);
    setNotice(null);
    setFieldErrors({});

    const text = reader(formData);
    const programId = text('programId');
    if (!programId) {
      setFieldErrors({ programId: 'Pick a program' });
      return;
    }

    const base: Record<string, unknown> = {
      programId,
      obligation: text('obligation'),
      dueOn: text('dueOn'),
    };

    if (target === 'employees') {
      // Comma or newline separated employee ids. A picker belongs here eventually;
      // ids are what the API takes and what a bulk assignment is pasted from today.
      const raw = text('employeeIds');
      const employeeIds = (raw ?? '')
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      if (employeeIds.length === 0) {
        setFieldErrors({ employeeIds: 'Name at least one employee' });
        return;
      }
      base.employeeIds = employeeIds;
    } else if (target === 'department') {
      const departmentId = text('departmentId');
      if (!departmentId) {
        setFieldErrors({ departmentId: 'Pick a department' });
        return;
      }
      base.departmentId = departmentId;
    } else {
      const designationId = text('designationId');
      if (!designationId) {
        setFieldErrors({ designationId: 'Pick a designation' });
        return;
      }
      base.designationId = designationId;
    }

    startTransition(async () => {
      const result = await assignTrainingAction(base);
      if (!result.ok) {
        setMessage(result.message);
        setFieldErrors(errorsFrom(result.details));
        return;
      }

      /*
        Created and skipped are both reported. Somebody already enrolled is skipped
        rather than duplicated — the unique index on (programId, employeeId) across
        live statuses guarantees it — and saying so is the difference between "it
        worked" and "it worked, and here is why the number is smaller than you
        expected".
      */
      const { assigned, skipped } = result.data;
      setNotice(
        skipped > 0
          ? `${assigned} assigned · ${skipped} already enrolled and left alone`
          : `${assigned} assigned`,
      );
      router.refresh();
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-3">
        <SelectField
          name="programId"
          label="Program"
          required
          error={fieldErrors.programId}
          options={assignable.map((program) => ({
            value: program.id,
            label: `${program.title} (${program.code})`,
          }))}
          placeholder="Pick a published program"
        />

        {assignable.length === 0 && (
          <p className="text-xs text-muted">
            No published programs yet. A draft program cannot be assigned — publish it
            first.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="assign-target">Assign to</Label>
          <select
            id="assign-target"
            value={target}
            onChange={(event) =>
              setTarget(event.target.value as 'employees' | 'department' | 'designation')
            }
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="department">A whole department</option>
            <option value="designation">Everybody on a designation</option>
            <option value="employees">Named people</option>
          </select>
        </div>

        {target === 'department' && (
          <SelectField
            name="departmentId"
            label="Department"
            required
            error={fieldErrors.departmentId}
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}

        {target === 'designation' && (
          <SelectField
            name="designationId"
            label="Designation"
            required
            error={fieldErrors.designationId}
            options={designations.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}

        {target === 'employees' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="employeeIds">
              Employee ids<span className="text-critical"> *</span>
            </Label>
            <Textarea
              id="employeeIds"
              name="employeeIds"
              rows={3}
              placeholder="One per line, or comma separated"
              aria-invalid={Boolean(fieldErrors.employeeIds)}
            />
            {fieldErrors.employeeIds && (
              <span className="text-xs text-critical">{fieldErrors.employeeIds}</span>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            name="obligation"
            label="Obligation"
            options={TRAINING_OBLIGATIONS.map((o) => ({
              value: o,
              label: OBLIGATION_LABELS[o],
            }))}
            placeholder="As the program says"
          />
          <TextField
            name="dueOn"
            label="Due date"
            type="date"
            error={fieldErrors.dueOn}
          />
        </div>
        <p className="text-xs text-muted">
          Left blank, the due date comes from the program&apos;s own window.
        </p>

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        {notice && <p className="text-sm text-positive">{notice}</p>}

        <div className="flex justify-end">
          <Button type="submit" disabled={pending || assignable.length === 0}>
            {pending ? 'Assigning…' : 'Assign'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Field primitives
// ---------------------------------------------------------------------------

/*
  Plain native inputs and selects, matching the Phase 3 forms: the shadcn `Select` is
  a popover needing its own open state and does not submit with a form, and these
  fields are read straight out of FormData.
*/

function TextField({
  name,
  label,
  type = 'text',
  required = false,
  error,
  placeholder,
  defaultValue,
  step,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  error?: string;
  placeholder?: string;
  defaultValue?: string;
  step?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <Input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        step={step}
        aria-invalid={Boolean(error)}
      />
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
  );
}

function AreaField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>{label}</Label>
      <Textarea id={name} name={name} rows={3} defaultValue={defaultValue} />
    </div>
  );
}

function SelectField({
  name,
  label,
  options,
  required = false,
  placeholder,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-critical"> *</span>}
      </Label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue ?? ''}
        aria-invalid={Boolean(error)}
        className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
      >
        <option value="">{placeholder ?? 'Not set'}</option>
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

function CheckField({
  name,
  label,
  defaultChecked = false,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}
