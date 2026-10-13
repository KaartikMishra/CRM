'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle } from 'lucide-react';
import type { DevelopmentPlanView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  addPlanActionAction,
  closePlanAction,
  completePlanActionAction,
  removePlanActionAction,
} from '@/app/(app)/hr/performance-actions';
import {
  PLAN_KIND_LABELS,
  PLAN_KIND_TONES,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TONES,
  formatPerfDay,
  formatPerfMoment,
  planProgress,
} from './performance-labels';

/**
 * A development plan and its actions.
 *
 * ### Who may do what, and the one asymmetry worth stating
 *
 * The subject cannot create, amend or close their own plan — an improvement plan is
 * a document the business is accountable for, and one the subject authored would be
 * neither a commitment by the business nor a record of one.
 *
 * But the subject **can** tick actions off. Doing the things a plan asks for is
 * their work, and requiring a manager to record each one would make the plan a
 * tracking burden rather than a support. They still cannot add, remove or reword an
 * action, so what they tick off is what was actually agreed.
 *
 * Both halves are enforced by the API; these flags only decide what renders.
 */

export function PlanDetailPanel({
  plan,
  canManage,
  canTickActions,
}: {
  plan: DevelopmentPlanView;
  /** HR_PERFORMANCE:EDIT or the subject's manager. Never the subject. */
  canManage: boolean;
  /** The subject, their manager, or HR. */
  canTickActions: boolean;
}) {
  const percent = planProgress(plan.completedActionCount, plan.actionCount);
  const open = plan.status === 'OPEN';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-medium text-ink">{plan.title}</span>
            <span className="text-xs text-muted">
              {plan.employee.displayName} · {plan.employee.employeeId}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={PLAN_KIND_TONES[plan.kind]}>{PLAN_KIND_LABELS[plan.kind]}</Badge>
            <Badge variant={PLAN_STATUS_TONES[plan.status]}>
              {PLAN_STATUS_LABELS[plan.status]}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <Figure label="Review on" value={formatPerfDay(plan.reviewOn)} />
          <Figure label="Created by" value={plan.createdBy.name} />
          <Figure
            label="Progress"
            value={`${plan.completedActionCount} / ${plan.actionCount} · ${percent}%`}
          />
        </div>

        {plan.isOverdue && open && (
          <p className="text-xs text-critical">
            The review date has passed and this plan is still open.
          </p>
        )}

        {plan.objective && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              What needs to change
            </span>
            <p className="whitespace-pre-line text-sm text-ink-2">{plan.objective}</p>
          </div>
        )}

        {plan.supportOffered && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              What the business will do
            </span>
            <p className="whitespace-pre-line text-sm text-ink-2">{plan.supportOffered}</p>
          </div>
        )}

        {!open && (
          <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
            <span className="text-sm text-ink">
              Closed as {PLAN_STATUS_LABELS[plan.status]}
              {plan.closedBy ? ` by ${plan.closedBy.name}` : ''}
              {plan.closedAt ? ` · ${formatPerfMoment(plan.closedAt)}` : ''}
            </span>
            {plan.outcomeNote && (
              <span className="text-xs text-ink-2">{plan.outcomeNote}</span>
            )}
          </div>
        )}
      </Card>

      <ActionList
        plan={plan}
        canManage={canManage && open}
        canTick={canTickActions && open}
      />

      {canManage && open && <ClosePlanPanel planId={plan.id} />}
    </div>
  );
}

function ActionList({
  plan,
  canManage,
  canTick,
}: {
  plan: DevelopmentPlanView;
  canManage: boolean;
  canTick: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [description, setDescription] = useState('');
  const [dueOn, setDueOn] = useState('');

  function toggle(actionId: string, isCompleted: boolean): void {
    setMessage(null);
    startTransition(async () => {
      const res = await completePlanActionAction(actionId, plan.id, isCompleted);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function add(): void {
    if (description.trim().length < 2) {
      setMessage('Say what will be done.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const res = await addPlanActionAction(plan.id, {
        description: description.trim(),
        ...(dueOn ? { dueOn } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setAdding(false);
      setDescription('');
      setDueOn('');
      router.refresh();
    });
  }

  function remove(actionId: string): void {
    setMessage(null);
    startTransition(async () => {
      const res = await removePlanActionAction(actionId, plan.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Actions
        </h2>
        {canManage && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add an action
          </Button>
        )}
      </div>

      {plan.actions.length === 0 && !adding && (
        <p className="text-sm text-muted">
          No actions on this plan yet. A plan with nothing to do is a statement, not a
          plan.
        </p>
      )}

      {plan.actions.length > 0 && (
        <ul className="flex flex-col gap-2">
          {plan.actions.map((action) => (
            <li
              key={action.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line p-3"
            >
              <div className="flex items-start gap-2.5">
                {canTick ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => toggle(action.id, !action.isCompleted)}
                    aria-label={
                      action.isCompleted
                        ? `Mark "${action.description}" not done`
                        : `Mark "${action.description}" done`
                    }
                    className="mt-0.5"
                  >
                    {action.isCompleted ? (
                      <CheckCircle2 className="size-4 text-positive" aria-hidden="true" />
                    ) : (
                      <Circle className="size-4 text-muted" aria-hidden="true" />
                    )}
                  </button>
                ) : action.isCompleted ? (
                  <CheckCircle2
                    className="mt-0.5 size-4 text-positive"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle className="mt-0.5 size-4 text-muted" aria-hidden="true" />
                )}

                <div className="flex flex-col gap-0.5">
                  <span
                    className={
                      action.isCompleted
                        ? 'text-sm text-muted line-through'
                        : 'text-sm text-ink'
                    }
                  >
                    {action.description}
                  </span>
                  <span className="text-xs text-muted">
                    {action.dueOn ? `Due ${formatPerfDay(action.dueOn)}` : 'No date'}
                    {action.isCompleted && action.completedAt
                      ? ` · done ${formatPerfMoment(action.completedAt)}`
                      : ''}
                    {action.isCompleted && action.completedBy
                      ? ` by ${action.completedBy.name}`
                      : ''}
                  </span>
                </div>
              </div>

              {canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => remove(action.id)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="new-action">What will be done</Label>
              <Input
                id="new-action"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-action-due">By</Label>
              <Input
                id="new-action-due"
                type="date"
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
                className="w-40"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={add}>
              {pending ? 'Adding…' : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

function ClosePlanPanel({ planId }: { planId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'COMPLETED' | 'ABANDONED'>('COMPLETED');
  const [note, setNote] = useState('');

  function close(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await closePlanAction(planId, {
        outcome,
        ...(note.trim() ? { outcomeNote: note.trim() } : {}),
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
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Close this plan
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="plan-outcome">Outcome</Label>
        <select
          id="plan-outcome"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as 'COMPLETED' | 'ABANDONED')}
          className="h-9 w-48 rounded-md border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="COMPLETED">Completed</option>
          <option value="ABANDONED">Abandoned</option>
        </select>
      </div>
      <Textarea
        rows={2}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What happened? (optional)"
        aria-label="Outcome note"
      />
      {/* "Abandoned" is kept rather than deleted: a plan that was set and dropped is
          itself worth knowing. */}
      <p className="text-xs text-muted">
        An abandoned plan stays on the record — a plan that was set and dropped is
        itself worth knowing.
      </p>

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={close}>
          {pending ? 'Closing…' : 'Confirm'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}
