'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Target } from 'lucide-react';
import {
  GOAL_STATUSES,
  KPI_DIRECTIONS,
  KPI_METRIC_KINDS,
  type GoalView,
  type KpiView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  activateGoalAction,
  addKpiAction,
  closeGoalAction,
  recordProgressAction,
  removeKpiAction,
} from '@/app/(app)/hr/performance-actions';
import { KpiEditForm } from './competency-controls';
import {
  DIRECTION_HINTS,
  DIRECTION_LABELS,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_TONES,
  METRIC_KIND_LABELS,
  formatAttainment,
  formatMeasure,
  formatPerfMoment,
  formatTargetProgress,
} from './performance-labels';

/**
 * Goal and KPI controls.
 *
 * ### Every attainment figure on this screen came from the server
 *
 * `kpi.attainment` and `goal.attainment` are computed in `performance.calc.ts` from
 * the target, the baseline and the direction, then cached on the row inside the same
 * transaction as the progress that changed them. Nothing here recomputes one, and
 * `recordProgressAction` sends a measurement with no attainment field at all.
 *
 * That matters because the arithmetic is not obvious: a goal moving 20% → 30% that
 * reached 25% is **50%** attained, not the 83% a naive `value / target` would give.
 * A browser doing its own sum would disagree with the record, and the record is what
 * feeds the appraisal.
 *
 * ### Who may do what comes from the server too
 *
 * The flags here are passed in by the page, which reads them from the goal's own
 * state and the viewer's grants. Every one is enforced again by the API — the owner
 * cannot edit their own target or close their own goal, whatever the UI renders.
 */

// ---------------------------------------------------------------------------
//  KPI list with progress recording
// ---------------------------------------------------------------------------

export function KpiPanel({
  goal,
  canEdit,
  canRecord,
}: {
  goal: GoalView;
  /** Whether this viewer may change the indicator definitions. Never the owner. */
  canEdit: boolean;
  /** Whether they may record a measurement. The owner may, for their own goal. */
  canRecord: boolean;
}) {
  if (goal.kpis.length === 0) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Indicators
        </h2>
        <p className="text-sm text-muted">
          No measurable indicators yet. A goal with no measure is an intention — add
          one so progress can be tracked.
        </p>
        {canEdit && <AddKpiForm goalId={goal.id} />}
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Indicators
        </h2>
        <span className="text-sm text-ink-2">
          Overall:{' '}
          <span className="font-medium text-ink">{formatAttainment(goal.attainment)}</span>
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {goal.kpis.map((kpi) => (
          <KpiRow
            key={kpi.id}
            goalId={goal.id}
            goalStatus={goal.status}
            kpi={kpi}
            canEdit={canEdit}
            canRecord={canRecord}
          />
        ))}
      </ul>

      {canEdit && <AddKpiForm goalId={goal.id} />}
    </Card>
  );
}

function KpiRow({
  goalId,
  goalStatus,
  kpi,
  canEdit,
  canRecord,
}: {
  goalId: string;
  goalStatus: string;
  kpi: KpiView;
  canEdit: boolean;
  canRecord: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  // Progress only against an agreed, open goal — the API refuses otherwise, since a
  // number arriving after the outcome is judged would disagree with it.
  const recordable = canRecord && goalStatus === 'ACTIVE';

  /*
    The definition is editable while the goal is unsettled, and never by its owner.
    `canEdit` already carries the owner exclusion from the page; the status check
    here is the lifecycle half — a closed goal's target cannot move, because that
    would change what somebody was measured against after the fact.
  */
  const definitionEditable =
    canEdit && (goalStatus === 'DRAFT' || goalStatus === 'ACTIVE');

  function record(): void {
    if (value.trim() === '' || Number.isNaN(Number(value))) {
      setMessage('Enter the measured value.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await recordProgressAction(goalId, kpi.id, {
        value: Number(value),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setRecording(false);
      setValue('');
      setNote('');
      router.refresh();
    });
  }

  function remove(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await removeKpiAction(goalId, kpi.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  if (editing) {
    return (
      <li>
        <KpiEditForm goalId={goalId} kpi={kpi} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{kpi.name}</span>
          <span className="text-xs text-muted">
            {METRIC_KIND_LABELS[kpi.metricKind]} · {DIRECTION_LABELS[kpi.direction]} ·
            weight {kpi.weight}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {/*
            The server's figure, rendered as sent. "Not measured" where nothing is
            recorded — which is different from 0% and must look different.
          */}
          <span className="text-sm font-medium text-ink">
            {formatAttainment(kpi.attainment)}
          </span>
          <span className="text-xs text-muted">
            {formatTargetProgress(kpi.currentValue, kpi.targetValue, kpi.unitLabel)}
          </span>
        </div>
      </div>

      {kpi.description && <p className="text-xs text-ink-2">{kpi.description}</p>}

      {kpi.baselineValue !== null && (
        <p className="text-xs text-muted">
          Measured from a baseline of {formatMeasure(kpi.baselineValue, kpi.unitLabel)} —
          progress is the distance covered from there, not the raw figure.
        </p>
      )}

      {kpi.lastUpdatedAt && (
        <p className="text-xs text-muted">
          Last updated {formatPerfMoment(kpi.lastUpdatedAt)}
          {kpi.lastUpdatedBy ? ` by ${kpi.lastUpdatedBy.name}` : ''}
        </p>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}

      {recordable && (
        <div className="flex flex-col gap-2">
          {recording ? (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`value-${kpi.id}`} className="text-xs">
                    {kpi.metricKind === 'BOOLEAN' ? 'Done? (1 or 0)' : 'Measured value'}
                  </Label>
                  <Input
                    id={`value-${kpi.id}`}
                    type="number"
                    step="0.01"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    className="w-32"
                  />
                </div>
              </div>
              <Textarea
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Note (optional)"
                aria-label={`Note on ${kpi.name}`}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={record}>
                  {pending ? 'Recording…' : 'Record'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRecording(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-muted">
                The attainment percentage is calculated from this value against the
                target — it is not entered.
              </p>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setRecording(true)}>
                Record progress
              </Button>
              {definitionEditable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  Edit indicator
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {!recordable && canEdit && goalStatus === 'DRAFT' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit indicator
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Adding an indicator.
 *
 * `metricKind` cannot be changed afterwards — the update schema has no field for it,
 * because a 40 that meant "40 orders" becoming "40%" would reinterpret every
 * recorded value. So it is chosen once, here.
 */
function AddKpiForm({ goalId }: { goalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<(typeof KPI_METRIC_KINDS)[number]>('NUMBER');
  const [direction, setDirection] =
    useState<(typeof KPI_DIRECTIONS)[number]>('HIGHER_IS_BETTER');

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const text = (key: string): string | undefined => {
      const raw = formData.get(key);
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      return trimmed === '' ? undefined : trimmed;
    };

    const name = text('name');
    if (!name || name.length < 2) {
      setFieldErrors({ name: 'Name this indicator' });
      return;
    }

    const target = text('targetValue');
    if (target === undefined || Number.isNaN(Number(target))) {
      setFieldErrors({ targetValue: 'Give it a numeric target' });
      return;
    }
    if (Number(target) === 0) {
      setFieldErrors({
        targetValue:
          'A target of zero has no proportion to measure. For "zero defects", use lower-is-better with a small target.',
      });
      return;
    }
    if (kind === 'BOOLEAN' && Number(target) !== 1) {
      setFieldErrors({ targetValue: 'A done/not-done indicator has a target of 1' });
      return;
    }

    const baseline = text('baselineValue');
    const weight = text('weight');

    startTransition(async () => {
      const res = await addKpiAction(goalId, {
        name,
        description: text('description'),
        metricKind: kind,
        direction,
        targetValue: Number(target),
        ...(baseline !== undefined ? { baselineValue: Number(baseline) } : {}),
        unitLabel: text('unitLabel'),
        ...(weight !== undefined ? { weight: Number(weight) } : {}),
      });

      if (!res.ok) {
        setMessage(res.message);
        setFieldErrors(
          Object.fromEntries((res.details ?? []).map((d) => [d.path, d.message])),
        );
        return;
      }

      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Add an indicator
        </Button>
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3 rounded-md border border-line p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-name">
            Indicator<span className="text-critical"> *</span>
          </Label>
          <Input id="kpi-name" name="name" placeholder="Orders dispatched" />
          {fieldErrors.name && (
            <span className="text-xs text-critical">{fieldErrors.name}</span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-kind">How it is measured</Label>
          <select
            id="kpi-kind"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as (typeof KPI_METRIC_KINDS)[number])
            }
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            {KPI_METRIC_KINDS.map((k) => (
              <option key={k} value={k}>
                {METRIC_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-direction">Which way is good</Label>
          <select
            id="kpi-direction"
            value={direction}
            onChange={(event) =>
              setDirection(event.target.value as (typeof KPI_DIRECTIONS)[number])
            }
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            {KPI_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
          {/* Getting this wrong is silent and consequential — a handling-time KPI set
              to higher-is-better scores a team as failing for improving. */}
          <span className="text-xs text-muted">{DIRECTION_HINTS[direction]}</span>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-target">
            Target<span className="text-critical"> *</span>
          </Label>
          <Input
            id="kpi-target"
            name="targetValue"
            type="number"
            step="0.01"
            defaultValue={kind === 'BOOLEAN' ? '1' : undefined}
          />
          {fieldErrors.targetValue && (
            <span className="text-xs text-critical">{fieldErrors.targetValue}</span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-baseline">Starting point (optional)</Label>
          <Input id="kpi-baseline" name="baselineValue" type="number" step="0.01" />
          <span className="text-xs text-muted">
            Given, progress is measured from here rather than from zero.
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-unit">Unit label (optional)</Label>
          <Input id="kpi-unit" name="unitLabel" placeholder="orders" />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="kpi-weight">Weight (optional)</Label>
          <Input id="kpi-weight" name="weight" type="number" step="0.01" placeholder="100" />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="kpi-description">Description (optional)</Label>
        <Textarea id="kpi-description" name="description" rows={2} />
      </div>

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
          {pending ? 'Adding…' : 'Add indicator'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
//  Goal lifecycle
// ---------------------------------------------------------------------------

/**
 * Agreeing and closing a goal.
 *
 * ### The outcome is a judgement; the attainment is arithmetic
 *
 * The server computes what the figures suggest and the closing manager states the
 * outcome. Where they disagree the API **requires a note** — so an override is
 * possible and has to be explained, which is the compromise between auto-grading
 * (wrong in exactly the cases a human appraisal exists for) and ignoring the numbers.
 *
 * Never the goal's owner. The API refuses the subject before any permission check.
 */
export function GoalLifecyclePanel({
  goal,
  canActivate,
  canClose,
  isOwner,
}: {
  goal: GoalView;
  canActivate: boolean;
  canClose: boolean;
  /** Whether the viewer owns this goal. Changes only the wording. */
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<'ACHIEVED' | 'PARTIALLY_MET' | 'MISSED' | 'CANCELLED'>(
    'ACHIEVED',
  );
  const [note, setNote] = useState('');

  const settled =
    goal.status === 'ACHIEVED' ||
    goal.status === 'PARTIALLY_MET' ||
    goal.status === 'MISSED' ||
    goal.status === 'CANCELLED';

  function activate(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await activateGoalAction(goal.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function close(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await closeGoalAction(goal.id, {
        outcome,
        ...(note.trim() ? { closureNote: note.trim() } : {}),
      });
      if (!res.ok) {
        // The API's own message names the suggested outcome when it refuses an
        // unexplained override, which is more useful than anything invented here.
        setMessage(res.message);
        return;
      }
      setClosing(false);
      setNote('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Status
        </h2>
        <Badge variant={GOAL_STATUS_TONES[goal.status]}>
          {GOAL_STATUS_LABELS[goal.status]}
        </Badge>
      </div>

      {settled && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
          <span className="text-sm text-ink">
            Closed as {GOAL_STATUS_LABELS[goal.status]}
            {goal.closedBy ? ` by ${goal.closedBy.name}` : ''}
            {goal.closedAt ? ` · ${formatPerfMoment(goal.closedAt)}` : ''}
          </span>
          <span className="text-xs text-muted">
            Final attainment {formatAttainment(goal.attainment)}
          </span>
          {goal.closureNote && (
            <p className="text-xs text-ink-2">{goal.closureNote}</p>
          )}
        </div>
      )}

      {goal.status === 'DRAFT' && (
        <p className="text-xs text-muted">
          A draft goal is not yet agreed, so no progress can be recorded against it.
        </p>
      )}

      {isOwner && !settled && (
        <p className="text-xs text-muted">
          This is your goal. You can record progress against it, but the target itself
          and its outcome are set by your manager.
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      {canActivate && goal.status === 'DRAFT' && (
        <div>
          <Button size="sm" disabled={pending} onClick={activate}>
            {pending ? 'Saving…' : 'Agree this goal'}
          </Button>
        </div>
      )}

      {canClose && !settled && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {closing ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="goal-outcome">Outcome</Label>
                <select
                  id="goal-outcome"
                  value={outcome}
                  onChange={(event) =>
                    setOutcome(
                      event.target.value as
                        | 'ACHIEVED'
                        | 'PARTIALLY_MET'
                        | 'MISSED'
                        | 'CANCELLED',
                    )
                  }
                  className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                >
                  {GOAL_STATUSES.filter(
                    (s) => s !== 'DRAFT' && s !== 'ACTIVE',
                  ).map((s) => (
                    <option key={s} value={s}>
                      {GOAL_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Note on the outcome — required if it differs from the figures"
                aria-label="Closure note"
              />
              <span className="text-xs text-muted">
                Recorded attainment is {formatAttainment(goal.attainment)}. If your
                stated outcome disagrees with that, a note is required.
              </span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={close}>
                  {pending ? 'Closing…' : 'Close goal'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button size="sm" variant="outline" onClick={() => setClosing(true)}>
                Close this goal
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** A small empty state for pages with no goals and no right to add one. */
export function NoGoalsNotice() {
  return (
    <Card className="flex flex-col items-center gap-2 p-8 text-center">
      <Target className="size-6 text-muted" aria-hidden="true" />
      <span className="text-sm font-medium text-ink">No goals yet</span>
      <span className="text-xs text-muted">
        Goals are set by a manager or by HR, and appear here once agreed.
      </span>
    </Card>
  );
}
