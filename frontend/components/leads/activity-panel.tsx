'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, Loader2, Plus } from 'lucide-react';
import {
  LEAD_ACTIVITY_KINDS,
  LEAD_ACTIVITY_KIND_LABELS,
  type LeadActivityKind,
  type LeadActivityView,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { createActivityAction, updateActivityAction } from '@/app/(app)/leads/actions';
import {
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUS_VARIANTS,
  activityDraftErrors,
  activityDraftOf,
  activityPayload,
  activityUpdatePayload,
  completionPayload,
  emptyActivityDraft,
  groupActivities,
  hasActivityChanges,
  isActivityValid,
  statusOf,
  type ActivityDraft,
} from './activity-logic';

/**
 * Activity and follow-ups — the workflow behind Last and Next Follow-up.
 *
 * Those two figures and the promptness rating were derived correctly from the
 * first, but nothing in the UI let an associate create the rows they derive
 * from, so they read "—" forever. This is that missing half: schedule a
 * follow-up, record a first contact, mark one done, correct one.
 *
 * Three groups rather than one list, because they are three different questions.
 * **Overdue** is work owed today; the backend deliberately excludes it from
 * `nextFollowUpAt`, since something already missed is outstanding rather than
 * planned, and this section is where it becomes visible instead. **Upcoming** is
 * the plan, soonest first, so its top row is the one the board names as next.
 * **History** is what happened.
 *
 * Every figure comes from the API. Completing a follow-up returns the whole lead
 * with `lastFollowUpAt`, `nextFollowUpAt` and promptness recomputed, so nothing
 * here recalculates any of them — only the status badge is derived locally, from
 * the same `dueAt`/`completedAt`/now comparison the backend uses.
 */
export function ActivityPanel({
  leadId,
  activities,
  canEdit,
}: {
  leadId: string;
  activities: LeadActivityView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState<LeadActivityKind | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  /*
    One clock for the whole render, taken once. Calling `new Date()` per row
    would let two activities a millisecond apart be judged against different
    "now"s — and would make the grouping disagree with the badges.
  */
  const now = new Date();
  const { overdue, upcoming, history } = groupActivities(activities, now);

  const done = (): void => {
    setAdding(null);
    setEditing(null);
    router.refresh();
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-ink">Activity &amp; follow-ups</h2>
          <p className="text-xs text-muted">
            What is owed, what is planned, and what has happened on this lead.
          </p>
        </div>

        {canEdit && adding === null && (
          <div className="flex flex-wrap gap-2">
            {/*
              First contact gets its own button because it is a distinct job:
              reaching the customer at all, rather than chasing them again.
            */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAdding('FIRST_CONTACT')}
            >
              <Plus className="size-4" />
              First contact
            </Button>
            <Button type="button" size="sm" onClick={() => setAdding('FOLLOW_UP')}>
              <CalendarClock className="size-4" />
              Schedule follow-up
            </Button>
          </div>
        )}
      </div>

      {adding !== null && canEdit && (
        <ActivityForm
          leadId={leadId}
          initialKind={adding}
          onDone={done}
          onCancel={() => setAdding(null)}
        />
      )}

      {activities.length === 0 && adding === null && (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line-2 px-4 py-8 text-center">
          <CalendarClock className="size-5 text-faint" aria-hidden />
          <p className="text-sm text-muted">No activity recorded yet</p>
          {canEdit ? (
            <p className="text-xs text-faint">
              Record the first contact, or schedule a follow-up, to start measuring promptness.
            </p>
          ) : (
            <p className="text-xs text-faint">You do not have permission to record activity.</p>
          )}
        </div>
      )}

      {/* Overdue first: the only group that needs acting on today. */}
      <Group
        title="Overdue"
        activities={overdue}
        leadId={leadId}
        canEdit={canEdit}
        now={now}
        editing={editing}
        setEditing={setEditing}
        onDone={done}
      />
      <Group
        title="Upcoming"
        activities={upcoming}
        leadId={leadId}
        canEdit={canEdit}
        now={now}
        editing={editing}
        setEditing={setEditing}
        onDone={done}
      />
      <Group
        title="History"
        activities={history}
        leadId={leadId}
        canEdit={canEdit}
        now={now}
        editing={editing}
        setEditing={setEditing}
        onDone={done}
      />
    </Card>
  );
}

function Group({
  title,
  activities,
  leadId,
  canEdit,
  now,
  editing,
  setEditing,
  onDone,
}: {
  title: string;
  activities: LeadActivityView[];
  leadId: string;
  canEdit: boolean;
  now: Date;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onDone: () => void;
}) {
  if (activities.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title} <span className="font-normal text-faint">({activities.length})</span>
      </h3>

      <ul className="flex flex-col gap-2">
        {activities.map((activity) =>
          editing === activity.id ? (
            <li key={activity.id}>
              <ActivityForm
                leadId={leadId}
                activity={activity}
                onDone={onDone}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={activity.id}>
              <ActivityRow
                leadId={leadId}
                activity={activity}
                canEdit={canEdit}
                now={now}
                onEdit={() => setEditing(activity.id)}
                onDone={onDone}
              />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function ActivityRow({
  leadId,
  activity,
  canEdit,
  now,
  onEdit,
  onDone,
}: {
  leadId: string;
  activity: LeadActivityView;
  canEdit: boolean;
  now: Date;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const status = statusOf(activity, now);
  const open = activity.completedAt === null;

  function complete(): void {
    startSaving(async () => {
      const result = await updateActivityAction(leadId, activity.id, completionPayload());
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line-2 bg-surface p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">
              {LEAD_ACTIVITY_KIND_LABELS[activity.kind]}
            </span>
            <Badge variant={ACTIVITY_STATUS_VARIANTS[status]}>
              {ACTIVITY_STATUS_LABELS[status]}
            </Badge>
          </div>

          <p className="mt-0.5 text-xs text-muted">
            Due {formatDateTime(activity.dueAt)}
            {activity.completedAt && ` · done ${formatDateTime(activity.completedAt)}`}
            {activity.performedBy && ` · ${activity.performedBy.name}`}
          </p>

          {activity.note && <p className="mt-1 text-sm text-ink-2">{activity.note}</p>}
        </div>

        {canEdit && (
          <div className="flex shrink-0 gap-1">
            {/* Only an open activity can be completed; a done one is history. */}
            {open && (
              <Button type="button" size="sm" onClick={complete} disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Mark completed
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={onEdit} disabled={saving}>
              Edit
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The add and edit form, as one component.
 *
 * `activity` absent means this is a new one; present means it is being corrected.
 * The kind is a chooser when adding and read-only when editing, because Phase 4D
 * made it immutable — the update contract has no `kind` field, so there is
 * nothing to send even if the control existed.
 */
function ActivityForm({
  leadId,
  activity,
  initialKind,
  onDone,
  onCancel,
}: {
  leadId: string;
  activity?: LeadActivityView;
  initialKind?: LeadActivityKind;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ActivityDraft>(
    activity ? activityDraftOf(activity) : emptyActivityDraft(initialKind ?? 'FOLLOW_UP'),
  );
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, startSaving] = useTransition();

  const errors = touched ? activityDraftErrors(draft) : {};
  const set = <K extends keyof ActivityDraft>(key: K, value: ActivityDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  function save(): void {
    setTouched(true);
    if (!isActivityValid(draft)) {
      setError('Fix the highlighted fields and try again.');
      return;
    }

    startSaving(async () => {
      if (activity) {
        const patch = activityUpdatePayload(activity, draft);
        const result = await updateActivityAction(leadId, activity.id, patch);
        if (!result.ok) {
          setError(result.message);
          return;
        }
      } else {
        const payload = activityPayload(draft);
        if (payload === null) {
          setError('Enter a valid date and time.');
          return;
        }
        const result = await createActivityAction(
          leadId,
          payload as Parameters<typeof createActivityAction>[1],
        );
        if (!result.ok) {
          setError(result.message);
          return;
        }
      }
      onDone();
    });
  }

  const id = activity?.id ?? 'new';

  return (
    <div className="flex flex-col gap-4 rounded-md border border-accent/40 bg-surface-2 p-4">
      <h3 className="text-sm font-semibold text-ink">
        {activity
          ? `Edit ${LEAD_ACTIVITY_KIND_LABELS[activity.kind].toLowerCase()}`
          : 'New activity'}
      </h3>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`kind-${id}`}>Activity type</Label>
          {activity ? (
            // Immutable. Shown so the form is complete, not editable.
            <Input id={`kind-${id}`} value={LEAD_ACTIVITY_KIND_LABELS[activity.kind]} disabled />
          ) : (
            <Select
              value={draft.kind}
              onValueChange={(v) => set('kind', v as LeadActivityKind)}
              disabled={saving}
            >
              <SelectTrigger id={`kind-${id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_ACTIVITY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {LEAD_ACTIVITY_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`date-${id}`}>Due date</Label>
          <Input
            id={`date-${id}`}
            type="date"
            value={draft.dueDate}
            onChange={(e) => set('dueDate', e.target.value)}
            disabled={saving}
            aria-invalid={Boolean(errors.dueDate)}
          />
          {errors.dueDate && <p className="text-xs text-critical">{errors.dueDate}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`time-${id}`}>Due time</Label>
          <Input
            id={`time-${id}`}
            type="time"
            value={draft.dueTime}
            onChange={(e) => set('dueTime', e.target.value)}
            disabled={saving}
            aria-invalid={Boolean(errors.dueTime)}
          />
          {errors.dueTime && <p className="text-xs text-critical">{errors.dueTime}</p>}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`note-${id}`}>Note</Label>
        <Textarea
          id={`note-${id}`}
          value={draft.note}
          onChange={(e) => set('note', e.target.value)}
          placeholder="What needs saying, or what was said"
          rows={2}
          disabled={saving}
        />
      </div>

      {/*
        Recording something that already happened — a call just made. Unticked
        sends no completion at all, because the API must never default one to
        now: "due" and "done" are different facts and promptness reads both.
      */}
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input
          type="checkbox"
          checked={draft.completed}
          onChange={(e) => set('completed', e.target.checked)}
          disabled={saving}
          className="size-4 rounded-sm border-line-2"
        />
        This already happened
      </label>

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving || (activity ? !hasActivityChanges(activity, draft) : false)}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {activity ? 'Save changes' : 'Add activity'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
