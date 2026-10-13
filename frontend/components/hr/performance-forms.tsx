'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  COMPETENCY_CATEGORIES,
  DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD,
  DEFAULT_GOAL_PARTIAL_THRESHOLD,
  DEVELOPMENT_PLAN_KINDS,
  GOAL_SCOPES,
  REVIEW_CYCLE_CADENCES,
  type EmployeeRow,
  type OrgUnitRef,
  type ReviewCycleSummary,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  addCompetencyAction,
  createCycleAction,
  createGoalAction,
  createPlanAction,
  generateReviewsAction,
} from '@/app/(app)/hr/performance-actions';
import {
  CADENCE_LABELS,
  COMPETENCY_CATEGORY_LABELS,
  GOAL_SCOPE_LABELS,
  PLAN_KIND_LABELS,
} from './performance-labels';
import { EmployeePicker } from './employee-picker';

/**
 * The Phase 5 creation forms.
 *
 * All of them share one shape, deliberately: check the obvious things so the person
 * is told before submitting, then send and relay whatever the server says. Every
 * client check here is mirrored by Zod and most by a database CHECK, and **those are
 * the ones that decide**.
 *
 * None of these computes a business value. No cycle code is invented (the server
 * allocates it from an atomic counter), no status is set (a cycle is born DRAFT, a
 * goal DRAFT, a review NOT_STARTED), no attainment is calculated, and no review is
 * finalised.
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
//  Review cycle
// ---------------------------------------------------------------------------

/**
 * Creating a review cycle.
 *
 * ### The thresholds are fields, not constants
 *
 * `DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD` (100) and `DEFAULT_GOAL_PARTIAL_THRESHOLD`
 * (50) appear here only as placeholder text. Left blank, the column defaults apply —
 * so the business default lives in one place, and a stretch cycle that defines
 * "achieved" as 110% simply states it. Nothing in the services compares against the
 * constants.
 *
 * ### The competency sheet is created with the cycle
 *
 * A cycle with no competencies cannot be opened — the API refuses it — because its
 * reviews would be unratable. Creating one and then forgetting the sheet would leave
 * something that looks ready and is not, so at least one row is required here.
 */
export function CycleForm({ departments }: { departments: OrgUnitRef[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [competencies, setCompetencies] = useState<
    { name: string; category: (typeof COMPETENCY_CATEGORIES)[number]; weight: string }[]
  >([{ name: '', category: 'CORE', weight: '' }]);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = reader(formData);
    const name = text('name');
    if (!name || name.length < 2) {
      setFieldErrors({ name: 'Name the cycle' });
      return;
    }

    const periodStart = text('periodStart');
    const periodEnd = text('periodEnd');
    if (!periodStart || !periodEnd) {
      setFieldErrors({ periodEnd: 'Give the period being appraised' });
      return;
    }
    if (periodEnd < periodStart) {
      setFieldErrors({ periodEnd: 'The period cannot end before it starts' });
      return;
    }

    const filled = competencies
      .map((c) => ({ ...c, name: c.name.trim() }))
      .filter((c) => c.name.length > 0);

    if (filled.length === 0) {
      setMessage('Add at least one competency — a cycle with none cannot be opened.');
      return;
    }

    const achievement = text('goalAchievementThreshold');
    const partial = text('goalPartialThreshold');
    if (achievement && partial && Number(partial) > Number(achievement)) {
      setFieldErrors({
        goalPartialThreshold: 'The partial threshold cannot be above the achievement one',
      });
      return;
    }

    startTransition(async () => {
      const res = await createCycleAction({
        name,
        description: text('description'),
        cadence: text('cadence') ?? 'ANNUAL',
        periodStart,
        periodEnd,
        selfAssessmentDueOn: text('selfAssessmentDueOn'),
        managerReviewDueOn: text('managerReviewDueOn'),
        targetDepartmentId: text('targetDepartmentId'),
        ...(achievement ? { goalAchievementThreshold: Number(achievement) } : {}),
        ...(partial ? { goalPartialThreshold: Number(partial) } : {}),
        competencies: filled.map((c, index) => ({
          name: c.name,
          category: c.category,
          ...(c.weight.trim() ? { weight: Number(c.weight) } : {}),
          sortOrder: index,
        })),
      });

      if (!res.ok) {
        setMessage(res.message);
        setFieldErrors(errorsFrom(res.details));
        return;
      }

      router.push(`/hr/performance/cycles/${res.data.cycle.id}`);
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="name"
            label="Cycle name"
            required
            error={fieldErrors.name}
            placeholder="FY26 Annual Review"
          />
          <SelectField
            name="cadence"
            label="Cadence"
            options={REVIEW_CYCLE_CADENCES.map((c) => ({
              value: c,
              label: CADENCE_LABELS[c],
            }))}
            placeholder="Annual"
          />
          <TextField
            name="periodStart"
            label="Period from"
            type="date"
            required
            error={fieldErrors.periodStart}
          />
          <TextField
            name="periodEnd"
            label="Period to"
            type="date"
            required
            error={fieldErrors.periodEnd}
          />
          <TextField
            name="selfAssessmentDueOn"
            label="Self-assessments due"
            type="date"
          />
          <TextField name="managerReviewDueOn" label="Manager reviews due" type="date" />
          <SelectField
            name="targetDepartmentId"
            label="Covers department"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
            placeholder="The whole company"
          />
        </div>

        <p className="text-xs text-muted">
          A cadence is descriptive — nothing is scheduled automatically from it.
        </p>

        {/*
          Blank means the column default — which is where the business default of
          100 / 50 lives. The numbers typed here are what `suggestGoalOutcome`
          compares against; nothing reads the constant.
        */}
        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Goal thresholds
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="goalAchievementThreshold"
              label="Achieved at (%)"
              type="number"
              step="0.01"
              error={fieldErrors.goalAchievementThreshold}
              placeholder={String(DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD)}
            />
            <TextField
              name="goalPartialThreshold"
              label="Partially met at (%)"
              type="number"
              step="0.01"
              error={fieldErrors.goalPartialThreshold}
              placeholder={String(DEFAULT_GOAL_PARTIAL_THRESHOLD)}
            />
          </div>
          <p className="text-xs text-muted">
            Left blank, this cycle uses {DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD}% for
            achieved and {DEFAULT_GOAL_PARTIAL_THRESHOLD}% for partially met. A
            stretch cycle may set achieved above 100%.
          </p>
        </fieldset>

        <AreaField name="description" label="About this cycle" />

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Competencies to rate
          </legend>
          <p className="text-xs text-muted">
            Fixed once the cycle opens, so everybody in one round is rated on the same
            things.
          </p>

          {competencies.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`comp-name-${index}`} className="text-xs">
                  Name
                </Label>
                <Input
                  id={`comp-name-${index}`}
                  value={row.name}
                  onChange={(event) =>
                    setCompetencies((current) =>
                      current.map((c, i) =>
                        i === index ? { ...c, name: event.target.value } : c,
                      ),
                    )
                  }
                  placeholder="Communication"
                  className="w-48"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`comp-cat-${index}`} className="text-xs">
                  Category
                </Label>
                <select
                  id={`comp-cat-${index}`}
                  value={row.category}
                  onChange={(event) =>
                    setCompetencies((current) =>
                      current.map((c, i) =>
                        i === index
                          ? {
                              ...c,
                              category: event.target
                                .value as (typeof COMPETENCY_CATEGORIES)[number],
                            }
                          : c,
                      ),
                    )
                  }
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {COMPETENCY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {COMPETENCY_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`comp-weight-${index}`} className="text-xs">
                  Weight
                </Label>
                <Input
                  id={`comp-weight-${index}`}
                  type="number"
                  step="0.01"
                  value={row.weight}
                  onChange={(event) =>
                    setCompetencies((current) =>
                      current.map((c, i) =>
                        i === index ? { ...c, weight: event.target.value } : c,
                      ),
                    )
                  }
                  placeholder="100"
                  className="w-24"
                />
              </div>
              {competencies.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setCompetencies((current) => current.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}

          {competencies.length < 20 && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCompetencies((current) => [
                    ...current,
                    { name: '', category: 'CORE', weight: '' },
                  ])
                }
              >
                Add another
              </Button>
            </div>
          )}
        </fieldset>

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
            {pending ? 'Creating…' : 'Create cycle'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Adding a competency to a DRAFT cycle, after creation. */
export function AddCompetencyForm({ cycleId }: { cycleId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function submit(formData: FormData): void {
    setMessage(null);
    const text = reader(formData);
    const name = text('name');
    if (!name || name.length < 2) {
      setMessage('Name the competency.');
      return;
    }

    const weight = text('weight');
    startTransition(async () => {
      const res = await addCompetencyAction(cycleId, {
        name,
        category: text('category') ?? 'CORE',
        description: text('description'),
        ...(weight ? { weight: Number(weight) } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add a competency
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="name" label="Competency" required placeholder="Communication" />
          <SelectField
            name="category"
            label="Category"
            options={COMPETENCY_CATEGORIES.map((c) => ({
              value: c,
              label: COMPETENCY_CATEGORY_LABELS[c],
            }))}
            placeholder="Core"
          />
          <TextField name="weight" label="Weight" type="number" step="0.01" placeholder="100" />
        </div>
        <AreaField name="description" label="What this means" />

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Generating a cycle's reviews.
 *
 * Sends either `allInScope` or a list of employee ids — never a precomputed roster.
 * The eligible set is resolved server-side from the cycle's department and who is
 * active at that moment, so somebody who joins next week is not retroactively owed a
 * review for a period they were not here for.
 */
export function GenerateReviewsForm({ cycleId }: { cycleId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | 'named'>('all');
  const [ids, setIds] = useState('');

  function generate(): void {
    setMessage(null);
    setNotice(null);

    let payload: Record<string, unknown>;
    if (mode === 'all') {
      payload = { allInScope: true };
    } else {
      const employeeIds = ids
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (employeeIds.length === 0) {
        setMessage('Name at least one employee.');
        return;
      }
      payload = { employeeIds };
    }

    startTransition(async () => {
      const res = await generateReviewsAction(cycleId, payload);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }

      /*
        Generated and skipped are both reported. Somebody already covered is skipped
        rather than duplicated — the unique index on (cycleId, employeeId) guarantees
        it — and saying so is the difference between "it worked" and "it worked, and
        here is why the number is smaller than you expected".
      */
      const { generated, skipped, eligible } = res.data;
      setNotice(
        skipped > 0
          ? `${generated} generated · ${skipped} already had one · ${eligible} in scope`
          : `${generated} generated from ${eligible} in scope`,
      );
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Generate reviews
      </h2>

      <div className="flex flex-col gap-1">
        <Label htmlFor="gen-mode">Who</Label>
        <select
          id="gen-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as 'all' | 'named')}
          className="h-9 w-64 rounded-md border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="all">Everybody in this cycle&apos;s scope</option>
          <option value="named">Named people</option>
        </select>
      </div>

      {mode === 'named' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="gen-ids">Employee ids</Label>
          <Textarea
            id="gen-ids"
            rows={3}
            value={ids}
            onChange={(event) => setIds(event.target.value)}
            placeholder="One per line, or comma separated"
          />
        </div>
      )}

      <p className="text-xs text-muted">
        Running this twice is safe — anybody who already has a review is skipped.
      </p>

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
      {notice && <p className="text-sm text-positive">{notice}</p>}

      <div>
        <Button size="sm" disabled={pending} onClick={generate}>
          {pending ? 'Generating…' : 'Generate'}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Goal
// ---------------------------------------------------------------------------

/**
 * Setting a goal.
 *
 * Exactly one owner — an employee or a department — checked here and enforced by the
 * `goal_exactly_one_owner` CHECK. A goal with neither belongs to nobody and a goal
 * with both is ambiguous about who is accountable.
 *
 * Born DRAFT: agreeing it is a separate act, so an imposed goal and an agreed one
 * are distinguishable and the agreement carries an author.
 */
export function GoalForm({
  departments,
  cycles,
  employees,
}: {
  departments: OrgUnitRef[];
  /** Cycles a goal may be appraised in. Archived ones are excluded by the caller. */
  cycles: ReviewCycleSummary[];
  /**
   * Candidates for an individual goal.
   *
   * From the existing scoped `GET /api/hr/employees` — a manager sees their
   * reports, HR sees everybody. Nothing was widened to fill this.
   */
  employees: EmployeeRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<(typeof GOAL_SCOPES)[number]>('EMPLOYEE');

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = reader(formData);
    const title = text('title');
    if (!title || title.length < 2) {
      setFieldErrors({ title: 'Name the goal' });
      return;
    }

    const startOn = text('startOn');
    const dueOn = text('dueOn');
    if (!startOn || !dueOn) {
      setFieldErrors({ dueOn: 'Give the dates it runs between' });
      return;
    }
    if (dueOn < startOn) {
      setFieldErrors({ dueOn: 'A goal cannot be due before it starts' });
      return;
    }

    const owner: Record<string, unknown> = {};
    if (scope === 'EMPLOYEE') {
      const employeeId = text('employeeId');
      if (!employeeId) {
        setFieldErrors({ employeeId: 'Name the employee this goal belongs to' });
        return;
      }
      owner.employeeId = employeeId;
    } else {
      const departmentId = text('departmentId');
      if (!departmentId) {
        setFieldErrors({ departmentId: 'Pick the department' });
        return;
      }
      owner.departmentId = departmentId;
    }

    const weight = text('weight');

    startTransition(async () => {
      const res = await createGoalAction({
        title,
        description: text('description'),
        successCriteria: text('successCriteria'),
        scope,
        ...owner,
        cycleId: text('cycleId'),
        startOn,
        dueOn,
        ...(weight ? { weight: Number(weight) } : {}),
      });

      if (!res.ok) {
        setMessage(res.message);
        setFieldErrors(errorsFrom(res.details));
        return;
      }

      router.push(`/hr/performance/goals/${res.data.goal.id}`);
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-4">
        <TextField
          name="title"
          label="Goal"
          required
          error={fieldErrors.title}
          placeholder="Reduce order turnaround to two days"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="goal-scope">Whose goal is this</Label>
            <select
              id="goal-scope"
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as (typeof GOAL_SCOPES)[number])
              }
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              {GOAL_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {GOAL_SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {scope === 'EMPLOYEE' ? (
            <EmployeePicker
              name="employeeId"
              label="Employee"
              employees={employees}
              required
              error={fieldErrors.employeeId}
            />
          ) : (
            <SelectField
              name="departmentId"
              label="Department"
              required
              error={fieldErrors.departmentId}
              options={departments.map((d) => ({ value: d.id, label: d.name }))}
            />
          )}

          <TextField
            name="startOn"
            label="Runs from"
            type="date"
            required
            error={fieldErrors.startOn}
          />
          <TextField
            name="dueOn"
            label="Due by"
            type="date"
            required
            error={fieldErrors.dueOn}
          />
          <SelectField
            name="cycleId"
            label="Appraised in cycle"
            options={cycles.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
            placeholder="Not tied to a cycle"
          />
          <TextField name="weight" label="Weight" type="number" step="0.01" placeholder="100" />
        </div>

        <AreaField name="description" label="What this means" />
        <AreaField name="successCriteria" label="How success is defined" />
        <p className="text-xs text-muted">
          Kept verbatim — if the goal is renegotiated later, this still shows what was
          originally asked.
        </p>

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
            {pending ? 'Creating…' : 'Create goal'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Development plan
// ---------------------------------------------------------------------------

/**
 * Creating a development plan.
 *
 * An IMPROVEMENT plan needs a review date — checked here, enforced by Zod and by the
 * `development_plan_improvement_has_review_date` CHECK. A formal improvement plan
 * with no review date is not a plan, it is a complaint on file.
 *
 * `supportOffered` is prominent for the same reason: a plan listing only what the
 * employee must change is a warning, not a plan.
 */
export function PlanForm({
  reviewId,
  employees,
  viewerEmployeeId,
}: {
  reviewId?: string;
  employees: EmployeeRow[];
  /**
   * The viewer's own Employee row id, where they have one.
   *
   * Excluded from the picker: the API refuses the subject authoring a plan about
   * themselves, so offering themselves would be offering a choice that always
   * fails. The refusal still stands server-side — this only avoids the dead option.
   */
  viewerEmployeeId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<(typeof DEVELOPMENT_PLAN_KINDS)[number]>('GROWTH');
  const [actions, setActions] = useState<{ description: string; dueOn: string }[]>([
    { description: '', dueOn: '' },
  ]);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = reader(formData);
    const employeeId = text('employeeId');
    if (!employeeId) {
      setFieldErrors({ employeeId: 'Name the employee' });
      return;
    }

    const title = text('title');
    if (!title || title.length < 2) {
      setFieldErrors({ title: 'Name the plan' });
      return;
    }

    const reviewOn = text('reviewOn');
    if (kind === 'IMPROVEMENT' && !reviewOn) {
      setFieldErrors({
        reviewOn: 'An improvement plan needs a review date — otherwise it is not a plan',
      });
      return;
    }

    const filled = actions
      .map((a) => ({ ...a, description: a.description.trim() }))
      .filter((a) => a.description.length > 0);

    startTransition(async () => {
      const res = await createPlanAction({
        employeeId,
        kind,
        title,
        objective: text('objective'),
        supportOffered: text('supportOffered'),
        ...(reviewOn ? { reviewOn } : {}),
        ...(reviewId ? { reviewId } : {}),
        ...(filled.length > 0
          ? {
              actions: filled.map((a, index) => ({
                description: a.description,
                ...(a.dueOn ? { dueOn: a.dueOn } : {}),
                sortOrder: index,
              })),
            }
          : {}),
      });

      if (!res.ok) {
        setMessage(res.message);
        setFieldErrors(errorsFrom(res.details));
        return;
      }

      router.push(`/hr/performance/plans/${res.data.plan.id}`);
    });
  }

  return (
    <Card className="p-4">
      <form action={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <EmployeePicker
            name="employeeId"
            label="Employee"
            employees={employees}
            required
            error={fieldErrors.employeeId}
            excludeIds={viewerEmployeeId ? [viewerEmployeeId] : []}
            hint="A plan is written with somebody, not about yourself."
          />

          <div className="flex flex-col gap-1">
            <Label htmlFor="plan-kind">Kind</Label>
            <select
              id="plan-kind"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as (typeof DEVELOPMENT_PLAN_KINDS)[number])
              }
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            >
              {DEVELOPMENT_PLAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLAN_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <TextField name="title" label="Plan" required error={fieldErrors.title} />
          <TextField
            name="reviewOn"
            label={kind === 'IMPROVEMENT' ? 'Review on (required)' : 'Review on'}
            type="date"
            required={kind === 'IMPROVEMENT'}
            error={fieldErrors.reviewOn}
          />
        </div>

        {kind === 'IMPROVEMENT' && (
          <p className="rounded-md border border-warning/30 bg-warning-soft p-2.5 text-xs text-ink-2">
            A formal improvement plan. The employee is notified that it exists, and it
            needs a review date.
          </p>
        )}

        <AreaField name="objective" label="What needs to change" />
        <AreaField name="supportOffered" label="What the business will do to help" />
        <p className="text-xs text-muted">
          A plan listing only what the employee must change is a warning, not a plan.
        </p>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Actions
          </legend>
          {actions.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor={`action-${index}`} className="text-xs">
                  What will be done
                </Label>
                <Input
                  id={`action-${index}`}
                  value={row.description}
                  onChange={(event) =>
                    setActions((current) =>
                      current.map((a, i) =>
                        i === index ? { ...a, description: event.target.value } : a,
                      ),
                    )
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`action-due-${index}`} className="text-xs">
                  By
                </Label>
                <Input
                  id={`action-due-${index}`}
                  type="date"
                  value={row.dueOn}
                  onChange={(event) =>
                    setActions((current) =>
                      current.map((a, i) =>
                        i === index ? { ...a, dueOn: event.target.value } : a,
                      ),
                    )
                  }
                  className="w-40"
                />
              </div>
              {actions.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setActions((current) => current.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {actions.length < 20 && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setActions((current) => [...current, { description: '', dueOn: '' }])
                }
              >
                Add another
              </Button>
            </div>
          )}
        </fieldset>

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
            {pending ? 'Creating…' : 'Create plan'}
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
  Plain native inputs and selects, matching the Phase 3 and Phase 4 forms: the shadcn
  `Select` is a popover needing its own open state and does not submit with a form,
  and these fields are read straight out of FormData.
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
