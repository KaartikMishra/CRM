'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { COMPETENCY_CATEGORIES, type CompetencyDefinitionView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  removeCompetencyAction,
  updateCompetencyAction,
  updateKpiAction,
} from '@/app/(app)/hr/performance-actions';
import { COMPETENCY_CATEGORY_LABELS } from './performance-labels';

/**
 * Editing and removing one competency on a cycle's sheet.
 *
 * ### Both are DRAFT-only, and the UI says why rather than hiding
 *
 * A competency sheet is fixed once its cycle opens. Changing a name or a weight
 * mid-cycle would mean two employees in one round rated against different things or
 * weighted differently; removing one would delete ratings already given.
 *
 * So on an open cycle these controls are absent and a sentence explains it. Hiding
 * them silently would leave an HR colleague looking for a button that used to be
 * there — and the API refuses both regardless, with its own message.
 *
 * ### Deletion preserves history
 *
 * The backend refuses removal of a competency that has any rating against it,
 * counting them directly rather than inferring safety from the cycle status. On the
 * path the UI allows that count is provably zero, but the refusal is the guarantee:
 * a referenced competency is never deleted, so no appraisal loses its ratings.
 */
export function CompetencyRow({
  competency,
  cycleId,
  editable,
}: {
  competency: CompetencyDefinitionView;
  cycleId: string;
  /** Whether the cycle is still DRAFT *and* the viewer holds CREATE. */
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [name, setName] = useState(competency.name);
  const [category, setCategory] = useState<(typeof COMPETENCY_CATEGORIES)[number]>(
    competency.category,
  );
  const [weight, setWeight] = useState(competency.weight);
  const [description, setDescription] = useState(competency.description ?? '');

  function save(): void {
    if (name.trim().length < 2) {
      setMessage('Name the competency.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await updateCompetencyAction(competency.id, cycleId, {
        name: name.trim(),
        category,
        description: description.trim() || null,
        ...(weight.trim() ? { weight: Number(weight) } : {}),
      });
      if (!res.ok) {
        // The API's own message names the real obstacle — a locked sheet, a
        // duplicate name — which is more useful than anything invented here.
        setMessage(res.message);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function remove(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await removeCompetencyAction(competency.id, cycleId);
      if (!res.ok) {
        setMessage(res.message);
        setConfirming(false);
        return;
      }
      router.refresh();
    });
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-3 rounded-md border border-line p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`cname-${competency.id}`} className="text-xs">
              Competency
            </Label>
            <Input
              id={`cname-${competency.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`ccat-${competency.id}`} className="text-xs">
              Category
            </Label>
            <select
              id={`ccat-${competency.id}`}
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as (typeof COMPETENCY_CATEGORIES)[number])
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
            <Label htmlFor={`cwt-${competency.id}`} className="text-xs">
              Weight
            </Label>
            <Input
              id={`cwt-${competency.id}`}
              type="number"
              step="0.01"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              className="w-28"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`cdesc-${competency.id}`} className="text-xs">
            What this means
          </Label>
          <Textarea
            id={`cdesc-${competency.id}`}
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {message && (
          <p role="alert" className="text-xs text-critical">
            {message}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">{competency.name}</span>
        <span className="text-xs text-muted">
          {COMPETENCY_CATEGORY_LABELS[competency.category]} · weight {competency.weight}
        </span>
        {competency.description && (
          <span className="text-xs text-ink-2">{competency.description}</span>
        )}
        {message && (
          <span role="alert" className="text-xs text-critical">
            {message}
          </span>
        )}
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted">Remove this competency?</span>
              <Button size="sm" variant="outline" disabled={pending} onClick={remove}>
                {pending ? 'Removing…' : 'Yes, remove'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                No
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Editing a KPI's definition.
 *
 * ### `metricKind` is absent, and that is deliberate
 *
 * There is no field for it here because the update schema has none: a 40 that meant
 * "40 orders" becoming "40%" would reinterpret every value already recorded against
 * it. Changing how a thing is measured is a new indicator, not an edit.
 *
 * ### Changing a target recomputes attainment
 *
 * The backend recomputes the KPI's attainment and the goal's roll-up in the same
 * transaction as the edit, because the stored figure was computed against the old
 * definition. Renaming it does not — a write that looked like a measurement nobody
 * took would be worse than a stale name.
 *
 * ### Not on a settled goal
 *
 * `mayEditGoal` refuses any closed goal: its outcome has been judged and recorded,
 * and amending the target afterwards would change what somebody was measured
 * against. The owner is refused too, whatever grants they hold.
 */
export function KpiEditForm({
  goalId,
  kpi,
  onDone,
}: {
  goalId: string;
  kpi: {
    id: string;
    name: string;
    description: string | null;
    direction: string;
    targetValue: string;
    baselineValue: string | null;
    unitLabel: string | null;
    weight: string;
  };
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const [name, setName] = useState(kpi.name);
  const [description, setDescription] = useState(kpi.description ?? '');
  const [direction, setDirection] = useState(kpi.direction);
  const [target, setTarget] = useState(kpi.targetValue);
  const [baseline, setBaseline] = useState(kpi.baselineValue ?? '');
  const [unit, setUnit] = useState(kpi.unitLabel ?? '');
  const [weight, setWeight] = useState(kpi.weight);

  function save(): void {
    if (name.trim().length < 2) {
      setMessage('Name the indicator.');
      return;
    }
    if (target.trim() === '' || Number.isNaN(Number(target))) {
      setMessage('Give it a numeric target.');
      return;
    }
    if (Number(target) === 0) {
      setMessage(
        'A target of zero has no proportion to measure. For "zero defects", use a lower-is-better indicator with a small target.',
      );
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await updateKpiAction(goalId, kpi.id, {
        name: name.trim(),
        description: description.trim() || null,
        direction,
        targetValue: Number(target),
        baselineValue: baseline.trim() === '' ? null : Number(baseline),
        unitLabel: unit.trim() || null,
        ...(weight.trim() ? { weight: Number(weight) } : {}),
      });

      if (!res.ok) {
        // The API's message names the real obstacle — a settled goal, the owner
        // trying to edit their own target — which beats anything invented here.
        setMessage(res.message);
        return;
      }

      onDone();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`kname-${kpi.id}`} className="text-xs">
            Indicator
          </Label>
          <Input
            id={`kname-${kpi.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`kdir-${kpi.id}`} className="text-xs">
            Which way is good
          </Label>
          <select
            id={`kdir-${kpi.id}`}
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="HIGHER_IS_BETTER">Higher is better</option>
            <option value="LOWER_IS_BETTER">Lower is better</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`ktgt-${kpi.id}`} className="text-xs">
            Target
          </Label>
          <Input
            id={`ktgt-${kpi.id}`}
            type="number"
            step="0.01"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`kbase-${kpi.id}`} className="text-xs">
            Starting point
          </Label>
          <Input
            id={`kbase-${kpi.id}`}
            type="number"
            step="0.01"
            value={baseline}
            onChange={(event) => setBaseline(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`kunit-${kpi.id}`} className="text-xs">
            Unit label
          </Label>
          <Input
            id={`kunit-${kpi.id}`}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`kwt-${kpi.id}`} className="text-xs">
            Weight
          </Label>
          <Input
            id={`kwt-${kpi.id}`}
            type="number"
            step="0.01"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`kdesc-${kpi.id}`} className="text-xs">
          Description
        </Label>
        <Textarea
          id={`kdesc-${kpi.id}`}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      {/*
        Said plainly, because the consequence is invisible otherwise: the stored
        attainment was computed against the old target, so it is recomputed.
      */}
      <p className="text-xs text-muted">
        Changing the target, the starting point or the direction recalculates this
        indicator&apos;s attainment and the goal&apos;s overall figure. How it is
        measured cannot be changed — that would reinterpret every value already
        recorded.
      </p>

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save indicator'}
        </Button>
      </div>
    </div>
  );
}
