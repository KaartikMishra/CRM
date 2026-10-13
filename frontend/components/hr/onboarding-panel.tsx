'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ONBOARDING_STAGES,
  type OnboardingTaskView,
  type OnboardingView,
  type TrainingProgramSummary,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  advanceOnboardingAction,
  completeOnboardingTaskAction,
  createEmployeeAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  ONBOARDING_STAGE_LABELS,
  ONBOARDING_TASK_CATEGORY_LABELS,
  ONBOARDING_TASK_STATUS_LABELS,
  ONBOARDING_TASK_STATUS_TONES,
  formatDay,
  formatMoment,
  isOverdue,
  progressPercent,
} from './recruitment-labels';
import { OnboardingTrainingLink } from './onboarding-training-link';

/**
 * One onboarding — the checklist, the stage, and the employment record.
 *
 * ### EMPLOYEE_CREATED is the hinge, and it is not a stage move
 *
 * The three stages before it run without an employment record; every stage after it
 * has one. Crossing that boundary is its own operation with its own button, because it
 * *creates a person's employment* rather than ticking a box — and `availableStages`
 * from the server deliberately never offers EMPLOYEE_CREATED as a move, so there is no
 * way to mark the hinge passed without an Employee behind it.
 *
 * ### Why the employee form asks for so little
 *
 * Work email, phone and location. Nothing else, because nothing else is missing: the
 * name comes from the candidate, the joining date from this record, the department,
 * designation and manager from the fields above. Re-asking for any of them would let
 * the employment record disagree with the offer somebody signed.
 *
 * **No employee number field.** It is allocated by the Phase 1 atomic counter inside
 * the creating transaction, which is what stops two concurrent creates being handed the
 * same one. There is no input here to pass one.
 *
 * **No password, and no invitation.** See the ACCOUNT note below.
 */
export function OnboardingDetail({
  onboarding,
  canEdit,
  canDecide,
  todayKey,
  trainingPrograms,
}: {
  onboarding: OnboardingView;
  /**
   * Whether the viewer may advance the onboarding stage. HR_RECRUITMENT:EDIT.
   *
   * Deliberately NOT used to gate the task controls. An assignee — an IT or facilities
   * colleague closing their own laptop task — holds no recruitment grant at all, and
   * hiding the buttons from them would mean the checklist could only be worked by HR.
   * The service decides per task (`mayCompleteOnboardingTask`: the assignee, or anybody
   * who may edit recruitment), so the controls are offered and the API refuses whoever
   * should not have them. That is the one place in this phase where showing a button
   * that might fail is the right call, because the alternative silently breaks the
   * feature for its main users.
   */
  canEdit: boolean;
  /** Whether they hold APPROVE — needed to create the employment record. */
  canDecide: boolean;
  /** Today in company time, passed in so "overdue" is not read off the viewer's clock. */
  todayKey: string;
  /**
   * Published training programs, for linking a TRAINING task to a real course.
   *
   * Optional: without them the checklist behaves exactly as it did in Phase 3 and the
   * link control does not appear. Passed down to `TaskList`.
   */
  trainingPrograms?: TrainingProgramSummary[];
}) {
  const percent = progressPercent(onboarding.completedTaskCount, onboarding.taskCount);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">
              {onboarding.candidate.displayName}
            </span>
            <span className="text-xs text-ink-2">
              {onboarding.job.title} · {onboarding.job.code}
            </span>
          </div>
          <Badge variant={onboarding.completedAt ? 'positive' : 'accent'}>
            {ONBOARDING_STAGE_LABELS[onboarding.stage]}
          </Badge>
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <Field label="Joining date" value={formatDay(onboarding.joiningDate)} />
          <Field label="Actual start" value={formatDay(onboarding.actualJoiningDate)} />
          <Field label="Department" value={onboarding.department?.name ?? 'Not set'} />
          <Field label="Designation" value={onboarding.designation?.name ?? 'Not set'} />
          <Field label="Manager" value={onboarding.manager?.displayName ?? 'Not set'} />
          <Field
            label="Employee record"
            value={
              onboarding.employee
                ? `${onboarding.employee.employeeId} · ${onboarding.employee.displayName}`
                : 'Not created yet'
            }
          />
        </div>

        {/* Progress, derived from the two counts the server sends. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider text-muted">Progress</span>
            <span className="text-ink-2">
              {onboarding.completedTaskCount} of {onboarding.taskCount} tasks · {percent}%
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Onboarding progress"
          >
            <div className="h-full rounded-full bg-positive" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <StageTrack stage={onboarding.stage} />
      </Card>

      {canDecide && onboarding.employee === null && (
        <EmployeeCreationCard onboarding={onboarding} />
      )}

      {canEdit && onboarding.availableStages.length > 0 && (
        <AdvanceCard onboarding={onboarding} />
      )}

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Checklist
        </h2>
        {/*
          `canAct` is true for everybody, not `canEdit` — see the prop note above. The
          service enforces the per-task rule; hiding these from an unassigned-but-entitled
          colleague would make the checklist HR-only.
        */}
        <TaskList
          tasks={onboarding.tasks}
          onboardingId={onboarding.id}
          canAct
          todayKey={todayKey}
          trainingPrograms={trainingPrograms}
        />
      </Card>
    </div>
  );
}

/**
 * The whole checklist as a track, with the current stage marked.
 *
 * Showing the stages still ahead rather than only the ones reached is what makes the
 * position meaningful — "Documents" means little without seeing that thirteen steps and
 * a probation decision lie between it and a settled employee.
 */
function StageTrack({ stage }: { stage: OnboardingView['stage'] }) {
  const currentIndex = ONBOARDING_STAGES.indexOf(stage);

  return (
    <ol className="flex flex-wrap gap-1.5">
      {ONBOARDING_STAGES.map((value, index) => {
        const passed = index < currentIndex;
        const here = index === currentIndex;
        return (
          <li key={value}>
            <span
              className={
                here
                  ? 'inline-flex items-center rounded-full border border-brass-line bg-brass-soft px-2.5 py-1 text-xs font-medium text-accent'
                  : passed
                    ? 'inline-flex items-center rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2'
                    : 'inline-flex items-center rounded-full border border-line px-2.5 py-1 text-xs text-muted'
              }
              aria-current={here ? 'step' : undefined}
            >
              {ONBOARDING_STAGE_LABELS[value]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function AdvanceCard({ onboarding }: { onboarding: OnboardingView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  function advance(toStage: string): void {
    setMessage(null);
    startTransition(async () => {
      const result = await advanceOnboardingAction(
        onboarding.id,
        toStage,
        notes.trim() || undefined,
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setNotes('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Advance onboarding
      </h2>

      {/*
        The next stage — the server's list, not ours. Onboarding is genuinely
        sequential, unlike the ATS pipeline: there is no sensible reading of "go back to
        DOCUMENTS" once the employment record exists, because the thing that changed is
        not reversible.
      */}
      <div className="flex flex-wrap gap-2">
        {onboarding.availableStages.map((stage) => (
          <Button key={stage} size="sm" disabled={pending} onClick={() => advance(stage)}>
            Move to {ONBOARDING_STAGE_LABELS[stage]}
          </Button>
        ))}
      </div>

      <Textarea
        rows={2}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Note (optional)"
        aria-label="Stage note"
      />

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

/**
 * Creating the employment record.
 *
 * `canCreateEmployee` is the server's answer and the button follows it — it accounts
 * for the record already existing and for an adverse background check. A button the API
 * would refuse is worse than no button, so when it says no the reason is shown instead.
 */
function EmployeeCreationCard({ onboarding }: { onboarding: OnboardingView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);
    setFieldErrors({});

    const workEmail = String(formData.get('workEmail') ?? '').trim();
    if (!workEmail.includes('@')) {
      setFieldErrors({ workEmail: 'Enter a valid work email' });
      return;
    }

    startTransition(async () => {
      const result = await createEmployeeAction(onboarding.id, {
        workEmail,
        phone: String(formData.get('phone') ?? '').trim() || undefined,
        location: String(formData.get('location') ?? '').trim() || undefined,
      });

      if (!result.ok) {
        setMessage(result.message);
        if (result.details) {
          setFieldErrors(Object.fromEntries(result.details.map((d) => [d.path, d.message])));
        }
        return;
      }

      setOpen(false);
      router.refresh();
    });
  }

  if (!onboarding.canCreateEmployee) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Employment record
        </h2>
        <p className="text-sm text-ink-2">
          The employment record cannot be created yet. A background check may be flagged,
          or one may already exist — open the application to see where it stands.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Create the employment record
      </h2>

      <p className="text-sm text-ink-2">
        This creates the employee for {onboarding.candidate.displayName}, using the
        department, designation, manager and joining date above. The employee number is
        allocated automatically.
      </p>

      {/*
        The limitation, stated where somebody will act on it rather than buried in a
        release note. There is no secure invitation flow in this codebase — no token
        table, no expiry, no first-password journey — and the shortcuts (a generated
        password in an email, a default password, one chosen on somebody's behalf) are
        all worse than not doing it.
      */}
      <p className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
        <strong className="text-ink">Account linking is a separate step.</strong> Creating
        the employment record does not create a CRM login. Create the account by the
        normal route in User Management, then link it from the employee profile — the
        Account task on the checklist tracks it.
      </p>

      {!open ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            Create employment record
          </Button>
        </div>
      ) : (
        <form action={submit} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="workEmail">
                Work email<span className="text-critical"> *</span>
              </Label>
              <Input
                id="workEmail"
                name="workEmail"
                type="email"
                aria-invalid={Boolean(fieldErrors.workEmail)}
              />
              {fieldErrors.workEmail && (
                <span className="text-xs text-critical">{fieldErrors.workEmail}</span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="phone">Work phone</Label>
              <Input id="phone" name="phone" />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="location">Location</Label>
              <Input id="location" name="location" />
            </div>
          </div>

          {message && (
            <p role="alert" className="text-sm text-critical">
              {message}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create employment record'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * The checklist.
 *
 * Grouped by nothing and ordered by `sortOrder`, which is the sequence the business
 * works through — creation order would scatter a task added later into the middle of a
 * finished section.
 */
export function TaskList({
  tasks,
  onboardingId,
  canAct,
  todayKey,
  trainingPrograms,
}: {
  tasks: OnboardingTaskView[];
  onboardingId: string;
  canAct: boolean;
  todayKey: string;
  /**
   * Published training programs, for linking a TRAINING task to a real course.
   *
   * Optional, so a caller that does not supply them keeps the Phase 3 behaviour
   * exactly — the link control simply does not appear. Phase 4 is additive here,
   * not a rewrite of the checklist.
   */
  trainingPrograms?: TrainingProgramSummary[];
}) {
  if (tasks.length === 0) {
    return <p className="text-sm text-muted">No tasks on this checklist.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onboardingId={onboardingId}
          canAct={canAct}
          todayKey={todayKey}
          trainingPrograms={trainingPrograms}
        />
      ))}
    </ul>
  );
}

function TaskRow({
  task,
  onboardingId,
  canAct,
  todayKey,
  trainingPrograms,
}: {
  task: OnboardingTaskView;
  onboardingId: string;
  canAct: boolean;
  todayKey: string;
  trainingPrograms?: TrainingProgramSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [settling, setSettling] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const settled = task.status === 'COMPLETED' || task.status === 'SKIPPED';
  const overdue = !settled && isOverdue(task.dueOn, todayKey);

  function settle(status: string): void {
    // SKIPPED and BLOCKED need a note — required here, by Zod, by the service and by a
    // CHECK, because "skipped" is otherwise the quiet way to close a checklist nobody
    // worked through.
    if ((status === 'SKIPPED' || status === 'BLOCKED') && notes.trim().length < 5) {
      setMessage(
        status === 'SKIPPED'
          ? 'Say why this task is being skipped.'
          : 'Say what this task is waiting on.',
      );
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await completeOnboardingTaskAction(
        task.id,
        onboardingId,
        status,
        notes.trim() || undefined,
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setSettling(null);
      setNotes('');
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{task.title}</span>
          {task.detail && <span className="text-xs text-ink-2">{task.detail}</span>}
          <span className="text-xs text-muted">
            {ONBOARDING_TASK_CATEGORY_LABELS[task.category]}
            {task.assignee ? ` · ${task.assignee.displayName}` : ' · unassigned'}
            {task.dueOn ? ` · due ${formatDay(task.dueOn)}` : ''}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={ONBOARDING_TASK_STATUS_TONES[task.status]}>
            {ONBOARDING_TASK_STATUS_LABELS[task.status]}
          </Badge>
          {overdue && <span className="text-xs text-critical">Overdue</span>}
        </div>
      </div>

      {task.notes && <p className="text-xs text-ink-2">{task.notes}</p>}

      {/*
        The Phase 4 training link, on TRAINING tasks only.
        
        Shown whether or not the task is settled: a completed task that was never
        linked is exactly the case worth seeing, because it means somebody ticked
        off training that nothing recorded.
      */}
      {task.category === 'TRAINING' && trainingPrograms !== undefined && (
        <OnboardingTrainingLink
          taskId={task.id}
          onboardingId={onboardingId}
          trainingEnrollmentId={task.trainingEnrollmentId}
          programs={trainingPrograms}
        />
      )}

      {settled && task.completedBy && (
        <p className="text-xs text-muted">
          {task.status === 'COMPLETED' ? 'Done' : 'Skipped'} by {task.completedBy.name}
          {task.completedAt ? ` · ${formatMoment(task.completedAt)}` : ''}
        </p>
      )}

      {canAct && !settled && (
        <div className="flex flex-col gap-2">
          {settling !== null && (
            <Textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                settling === 'SKIPPED'
                  ? 'Why is this being skipped?'
                  : settling === 'BLOCKED'
                    ? 'What is it waiting on?'
                    : 'Note (optional)'
              }
              aria-label="Task note"
            />
          )}

          <div className="flex flex-wrap gap-2">
            {settling === null ? (
              <>
                {task.status === 'PENDING' && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => settle('IN_PROGRESS')}
                  >
                    Start
                  </Button>
                )}
                <Button size="sm" disabled={pending} onClick={() => settle('COMPLETED')}>
                  Done
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setSettling('BLOCKED')}
                >
                  Blocked
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setSettling('SKIPPED')}
                >
                  Skip
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => settle(settling)}
                >
                  {pending ? 'Saving…' : 'Confirm'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSettling(null);
                    setNotes('');
                  }}
                >
                  Back
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="text-ink-2">{value}</span>
    </div>
  );
}
