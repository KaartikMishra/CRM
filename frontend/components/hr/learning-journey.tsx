'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EnrollmentModuleView, TrainingEnrollmentView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  Lock,
} from 'lucide-react';
import {
  completeModuleAction,
  scheduleShadowingAction,
  submitPracticalAction,
} from '@/app/(app)/hr/training-actions';
import { AssessmentRunner } from './assessment-runner';
import {
  MODULE_COMPLETION_HINTS,
  MODULE_KIND_LABELS,
  PRACTICAL_STATUS_LABELS,
  PRACTICAL_STATUS_TONES,
  SHADOWING_STATUS_LABELS,
  SHADOWING_STATUS_TONES,
  formatDuration,
  formatPercent,
  formatTrainingDay,
  trainingProgress,
} from './training-labels';

/**
 * The learner's journey through a program.
 *
 * ### Every gate decision arrives from the server
 *
 * `isUnlocked` and `lockedReason` come computed on each module. This component does
 * not look at the previous step, does not count completions and does not decide what
 * is reachable — it renders the server's answer. That matters because the stage gate
 * is the feature: a failed assessment must leave the next step locked, and a browser
 * that worked that out for itself could be made to disagree.
 *
 * Likewise the progress numbers, the pass marks and the attempt allowances. Nothing
 * here does arithmetic on a score.
 *
 * ### What the learner can do themselves, and what they cannot
 *
 * A lesson they mark read. An assessment they sit. A practical they submit, and
 * somebody else approves. Shadowing a mentor signs off. The three kinds are visibly
 * different for that reason — telling somebody to "complete this step" when they
 * cannot is the most frustrating thing a learning tool does.
 */
export function LearningJourney({
  enrollment,
  isLearner,
}: {
  enrollment: TrainingEnrollmentView;
  /**
   * Whether this viewer is the learner.
   *
   * The API refuses everybody else — an administrator holding every grant included —
   * so this only decides whether the controls render. A manager reading a report's
   * progress sees the state and no buttons.
   */
  isLearner: boolean;
}) {
  const percent = trainingProgress(
    enrollment.completedModuleCount,
    enrollment.requiredModuleCount,
  );

  const settled =
    enrollment.status === 'EXEMPTED' ||
    enrollment.status === 'CANCELLED' ||
    enrollment.status === 'COMPLETED';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-medium text-ink">
              {enrollment.program.title}
            </span>
            <span className="text-xs text-muted">
              {enrollment.program.code} · pass mark{' '}
              {formatPercent(enrollment.program.passingScore)} ·{' '}
              {enrollment.program.maxAttempts} attempts
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-sm text-ink-2">
              {enrollment.completedModuleCount} of {enrollment.requiredModuleCount} required
              steps · {percent}%
            </span>
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-positive"
                style={{ width: `${percent}%` }}
              />
            </div>
            {enrollment.dueOn && (
              <span
                className={
                  enrollment.isOverdue ? 'text-xs text-critical' : 'text-xs text-muted'
                }
              >
                Due {formatTrainingDay(enrollment.dueOn)}
                {enrollment.isOverdue ? ' · overdue' : ''}
              </span>
            )}
          </div>
        </div>

        {enrollment.status === 'EXEMPTED' && (
          <p className="rounded-md border border-line bg-surface-2 p-2.5 text-sm text-ink-2">
            Excused
            {enrollment.exemptedBy ? ` by ${enrollment.exemptedBy.name}` : ''}
            {enrollment.exemptionReason ? ` — ${enrollment.exemptionReason}` : ''}
          </p>
        )}

        {enrollment.status === 'CANCELLED' && (
          <p className="rounded-md border border-line bg-surface-2 p-2.5 text-sm text-ink-2">
            Withdrawn
            {enrollment.cancellationReason ? ` — ${enrollment.cancellationReason}` : ''}
          </p>
        )}
      </Card>

      <ol className="flex flex-col gap-3">
        {enrollment.modules.map((module, index) => (
          <ModuleStep
            key={module.moduleId}
            step={index + 1}
            module={module}
            enrollmentId={enrollment.id}
            isLearner={isLearner && !settled}
          />
        ))}
      </ol>
    </div>
  );
}

function ModuleStep({
  step,
  module,
  enrollmentId,
  isLearner,
}: {
  step: number;
  module: EnrollmentModuleView;
  enrollmentId: string;
  isLearner: boolean;
}) {
  return (
    <li
      className={
        module.isUnlocked
          ? 'flex flex-col gap-2 rounded-md border border-line p-3'
          : 'flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3 opacity-80'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <StepIcon module={module} />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">
              <span className="text-muted">{step}. </span>
              {module.title}
            </span>
            <span className="text-xs text-muted">
              {MODULE_KIND_LABELS[module.kind]}
              {module.isRequired ? '' : ' · optional'}
              {module.estimatedMinutes
                ? ` · ${formatDuration(module.estimatedMinutes)}`
                : ''}
            </span>
          </div>
        </div>
        {module.isCompleted && <Badge variant="positive">Done</Badge>}
      </div>

      {/*
        The server's own sentence, not a generic "locked". A learner told only that a
        step is unavailable has no idea what to do next; told "pass Knowledge Test
        first", they do.
      */}
      {!module.isUnlocked && module.lockedReason && (
        <p className="text-xs text-muted">{module.lockedReason}</p>
      )}

      {module.isUnlocked && (
        <>
          {module.content && (
            <p className="whitespace-pre-line text-sm text-ink-2">{module.content}</p>
          )}

          {module.instructions && (
            <p className="whitespace-pre-line rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
              <span className="font-medium text-ink">What to do: </span>
              {module.instructions}
            </p>
          )}

          {/*
            A reference link, opened in a new tab with `noreferrer`. Nothing plays or
            tracks media here — the link is a link.
          */}
          {module.referenceUrl && (
            <a
              href={module.referenceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex w-fit items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              Open the reference material
            </a>
          )}

          {/* An attached file is named, never linked — links are minted per request. */}
          {module.secureDocumentId && (
            <p className="text-xs text-muted">A document is attached to this step.</p>
          )}

          {!module.isCompleted && (
            <p className="text-xs text-muted">{MODULE_COMPLETION_HINTS[module.kind]}</p>
          )}

          {module.kind === 'LESSON' && (
            <LessonControls
              enrollmentId={enrollmentId}
              module={module}
              isLearner={isLearner}
            />
          )}

          {module.kind === 'ASSESSMENT' && module.assessment && (
            <AssessmentRunner
              enrollmentId={enrollmentId}
              assessment={module.assessment}
              canSit={isLearner}
            />
          )}

          {module.kind === 'ASSESSMENT' && !module.assessment && (
            <p className="text-xs text-critical">
              This test has no question paper yet. Ask your trainer to finish building it.
            </p>
          )}

          {module.kind === 'PRACTICAL' && (
            <PracticalControls
              enrollmentId={enrollmentId}
              module={module}
              isLearner={isLearner}
            />
          )}

          {module.kind === 'SHADOWING' && (
            <ShadowingControls
              enrollmentId={enrollmentId}
              module={module}
              isLearner={isLearner}
            />
          )}
        </>
      )}
    </li>
  );
}

function StepIcon({ module }: { module: EnrollmentModuleView }) {
  if (module.isCompleted) {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden="true" />;
  }
  if (!module.isUnlocked) {
    return <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />;
  }
  return <Circle className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
//  Per-kind controls
// ---------------------------------------------------------------------------

/**
 * Marking a lesson read.
 *
 * The only step a learner completes by saying so. The backend refuses this route for
 * any module that is not a LESSON, which is what stops somebody self-certifying a
 * practical through it.
 */
function LessonControls({
  enrollmentId,
  module,
  isLearner,
}: {
  enrollmentId: string;
  module: EnrollmentModuleView;
  isLearner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('');

  if (module.isCompleted || !isLearner) return null;

  function complete(): void {
    setMessage(null);
    const spent = minutes.trim() === '' ? undefined : Number(minutes);
    startTransition(async () => {
      const res = await completeModuleAction(
        enrollmentId,
        module.moduleId,
        Number.isFinite(spent) ? spent : undefined,
      );
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`minutes-${module.moduleId}`} className="text-xs">
            Time spent (minutes, optional)
          </Label>
          <Input
            id={`minutes-${module.moduleId}`}
            type="number"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            className="w-36"
          />
        </div>
        <Button size="sm" disabled={pending} onClick={complete}>
          {pending ? 'Saving…' : 'Mark as read'}
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Submitting a practical, and seeing what came back.
 *
 * The learner submits; somebody else decides. A rejection is shown with its notes and
 * the submit form returns, because a rejection the learner cannot read is an
 * instruction they cannot follow.
 */
function PracticalControls({
  enrollmentId,
  module,
  isLearner,
}: {
  enrollmentId: string;
  module: EnrollmentModuleView;
  isLearner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const status = module.practicalStatus;
  // REJECTED means rework: the learner submits again. SUBMITTED is waiting on
  // somebody else, and APPROVED is finished.
  const canSubmit =
    isLearner && (status === null || status === 'NOT_STARTED' || status === 'REJECTED');

  function submit(): void {
    if (notes.trim().length < 5) {
      setMessage('Say what you did — your reviewer has only this to go on.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await submitPracticalAction(enrollmentId, module.moduleId, {
        submissionNotes: notes.trim(),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setNotes('');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {status !== null && (
        <div className="flex items-center gap-2">
          <Badge variant={PRACTICAL_STATUS_TONES[status]}>
            {PRACTICAL_STATUS_LABELS[status]}
          </Badge>
          {status === 'SUBMITTED' && (
            <span className="text-xs text-muted">Waiting on your reviewer.</span>
          )}
        </div>
      )}

      {canSubmit && (
        <>
          <Textarea
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="What did you do, and what happened?"
            aria-label="Practical submission"
          />
          <div>
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending
                ? 'Submitting…'
                : status === 'REJECTED'
                  ? 'Submit again'
                  : 'Submit for review'}
            </Button>
          </div>
        </>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Shadowing, from the learner's side.
 *
 * A learner can ask for a period to be scheduled; they cannot sign it off. The mentor
 * does that from the reviews queue, and the backend refuses the learner there
 * regardless of what grants they hold.
 */
function ShadowingControls({
  enrollmentId,
  module,
  isLearner,
}: {
  enrollmentId: string;
  module: EnrollmentModuleView;
  isLearner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const status = module.shadowingStatus;

  function schedule(): void {
    if (from !== '' && to !== '' && to < from) {
      setMessage('Shadowing cannot end before it starts.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await scheduleShadowingAction(enrollmentId, module.moduleId, {
        ...(from !== '' ? { scheduledFrom: from } : {}),
        ...(to !== '' ? { scheduledTo: to } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {status !== null && (
        <div className="flex items-center gap-2">
          <Badge variant={SHADOWING_STATUS_TONES[status]}>
            {SHADOWING_STATUS_LABELS[status]}
          </Badge>
        </div>
      )}

      {isLearner && status === null && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`from-${module.moduleId}`} className="text-xs">
                From
              </Label>
              <Input
                id={`from-${module.moduleId}`}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`to-${module.moduleId}`} className="text-xs">
                To
              </Label>
              <Input
                id={`to-${module.moduleId}`}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="w-40"
              />
            </div>
            <Button size="sm" variant="outline" disabled={pending} onClick={schedule}>
              {pending ? 'Saving…' : 'Request shadowing'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            Your mentor signs this off once they have observed you — you cannot sign off
            your own.
          </p>
        </>
      )}

      {status !== null && status !== 'COMPLETED' && status !== 'CANCELLED' && (
        <p className="text-xs text-muted">Your mentor signs this off.</p>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </div>
  );
}
