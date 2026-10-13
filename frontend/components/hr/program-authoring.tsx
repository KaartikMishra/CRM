'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ASSESSMENT_QUESTION_KINDS,
  type AssessmentQuestionKind,
  type TrainingModuleView,
  type TrainingProgramView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import {
  addQuestionAction,
  archiveProgramAction,
  createAssessmentAction,
  publishProgramAction,
  removeModuleAction,
  reorderModulesAction,
} from '@/app/(app)/hr/training-actions';
import { MODULE_KIND_LABELS, QUESTION_KIND_LABELS, formatDuration } from './training-labels';

/**
 * Program authoring: the sequence, and the question papers.
 *
 * ### Nothing here is an answer key
 *
 * The author *writes* correct options — that is what authoring is — but this component
 * never reads one back. A saved question is listed by its prompt and point value only.
 * Reviewing an existing key needs the backend's own authoring endpoint, which is gated
 * on HR_TRAINING:EDIT twice and is not wrapped by the learner-facing api module.
 *
 * ### Publishing and archiving are acts, not fields
 *
 * Neither is a PATCH on `status`: each has its own endpoint, so each carries a
 * timestamp and a record of who did it. A program whose status could be set by a form
 * would become assignable with nothing saying how.
 */

// ---------------------------------------------------------------------------
//  Lifecycle
// ---------------------------------------------------------------------------

export function ProgramLifecycleActions({
  program,
  canApprove,
}: {
  program: TrainingProgramView;
  /** HR_TRAINING:APPROVE. The API decides; this decides what to render. */
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState('');

  if (!canApprove) return null;

  function publish(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await publishProgramAction(program.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function archive(): void {
    if (reason.trim().length < 5) {
      setMessage('Say why this program is being retired.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const res = await archiveProgramAction(program.id, reason.trim());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setArchiving(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {program.status === 'DRAFT' && (
          <Button size="sm" disabled={pending} onClick={publish}>
            {pending ? 'Publishing…' : 'Publish'}
          </Button>
        )}
        {program.status === 'ACTIVE' && !archiving && (
          <Button size="sm" variant="ghost" onClick={() => setArchiving(true)}>
            Retire
          </Button>
        )}
      </div>

      {archiving && (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this program being retired?"
            aria-label="Retirement reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={archive}>
              {pending ? 'Saving…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setArchiving(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {program.status === 'DRAFT' && (
        <p className="text-xs text-muted">
          A draft cannot be assigned to anybody. Publish it when the sequence is right.
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  The sequence
// ---------------------------------------------------------------------------

/**
 * The module list, reorderable and prunable.
 *
 * Reordering sends the **whole** ordered list, not a single move: the backend writes
 * consecutive positions in one transaction, and a "move this one up" API would have to
 * reconcile two rows against a unique index and could fail halfway. Pressing up twice
 * quickly therefore cannot leave the sequence half-written.
 *
 * Buttons are disabled while a reorder is in flight, because a second move computed
 * from the pre-move order would send a list that no longer describes anything.
 */
export function ModuleSequence({
  program,
  canEdit,
}: {
  program: TrainingProgramView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState<string | null>(null);

  const modules = program.modules;

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= modules.length) return;

    const order = modules.map((module) => module.id);
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(target, 0, moved);

    setMessage(null);
    startTransition(async () => {
      const res = await reorderModulesAction(program.id, order);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function remove(moduleId: string): void {
    setMessage(null);
    startTransition(async () => {
      const res = await removeModuleAction(moduleId, program.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  if (modules.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted">
          No steps yet. A program with no steps cannot be published.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {modules.map((module, index) => (
          <li key={module.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">
                  <span className="text-muted">{index + 1}. </span>
                  {module.title}
                </span>
                <span className="text-xs text-muted">
                  {MODULE_KIND_LABELS[module.kind]}
                  {module.isRequired ? ' · required' : ' · optional'}
                  {module.estimatedMinutes
                    ? ` · ${formatDuration(module.estimatedMinutes)}`
                    : ''}
                </span>
              </div>

              {canEdit && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${module.title} earlier`}
                  >
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || index === modules.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${module.title} later`}
                  >
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => remove(module.id)}
                    aria-label={`Remove ${module.title}`}
                  >
                    <Trash2 className="size-4 text-critical" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>

            {module.instructions && (
              <p className="whitespace-pre-line text-xs text-ink-2">{module.instructions}</p>
            )}

            {/*
              An assessment step with no paper cannot be sat, so it is called out here
              rather than discovered by the first learner who reaches it.
            */}
            {module.kind === 'ASSESSMENT' && (
              <AssessmentSlot
                program={program}
                module={module}
                canEdit={canEdit}
                authoring={authoring === module.id}
                onToggle={() => setAuthoring(authoring === module.id ? null : module.id)}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function AssessmentSlot({
  program,
  module,
  canEdit,
  authoring,
  onToggle,
}: {
  program: TrainingProgramView;
  module: TrainingModuleView;
  canEdit: boolean;
  authoring: boolean;
  onToggle: () => void;
}) {
  const assessment = program.assessments.find((a) => a.moduleId === module.id) ?? null;

  if (assessment === null) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-brass-line bg-brass-soft p-2.5">
        <span className="text-xs text-ink-2">
          This test has no question paper. Nobody can sit it yet.
        </span>
        {canEdit && (
          <CreateAssessmentForm programId={program.id} moduleId={module.id} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-2">
          {assessment.title} · {assessment.questionCount}{' '}
          {assessment.questionCount === 1 ? 'question' : 'questions'} ·{' '}
          {assessment.totalPoints} points
        </span>
        <div className="flex items-center gap-1.5">
          {assessment.isFinal && <Badge variant="accent">Final</Badge>}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={onToggle}>
              {authoring ? 'Done' : 'Add questions'}
            </Button>
          )}
        </div>
      </div>

      {assessment.questionCount === 0 && (
        <span className="text-xs text-critical">
          No questions yet — this test cannot be sat.
        </span>
      )}

      {authoring && <QuestionForm assessmentId={assessment.id} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Assessment creation
// ---------------------------------------------------------------------------

/**
 * Attaching a question paper to a test step.
 *
 * `passingScore` is left out deliberately: omitted, the assessment inherits the
 * program's threshold rather than copying it, so changing the program's pass mark
 * moves every inheriting test with it. An assessment that genuinely needs its own
 * threshold is the exception and belongs in a dedicated edit screen, not in the
 * creation form where it would be set by accident.
 */
function CreateAssessmentForm({
  programId,
  moduleId,
}: {
  programId: string;
  moduleId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [isFinal, setIsFinal] = useState(false);
  const [timeLimit, setTimeLimit] = useState('');

  function create(): void {
    if (title.trim().length < 2) {
      setMessage('Name the test.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const limit = timeLimit.trim() === '' ? undefined : Number(timeLimit);
      const res = await createAssessmentAction(
        {
          programId,
          moduleId,
          title: title.trim(),
          isFinal,
          ...(limit !== undefined && Number.isFinite(limit)
            ? { timeLimitMinutes: limit }
            : {}),
        },
        programId,
      );
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setTitle('');
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`a-title-${moduleId}`} className="text-xs">
            Test name
          </Label>
          <Input
            id={`a-title-${moduleId}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Knowledge Test"
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`a-limit-${moduleId}`} className="text-xs">
            Time limit (minutes)
          </Label>
          <Input
            id={`a-limit-${moduleId}`}
            type="number"
            value={timeLimit}
            onChange={(event) => setTimeLimit(event.target.value)}
            className="w-32"
          />
        </div>
        <Button size="sm" disabled={pending} onClick={create}>
          {pending ? 'Saving…' : 'Create test'}
        </Button>
      </div>

      <label className="flex items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={isFinal}
          onChange={(event) => setIsFinal(event.target.checked)}
        />
        This is the final assessment — the one that gates live work
      </label>
      <p className="text-xs text-muted">
        Left alone, the test uses the program&apos;s pass mark. One program has one final
        assessment.
      </p>

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Question authoring
// ---------------------------------------------------------------------------

type DraftOption = { label: string; isCorrect: boolean };

/**
 * Writing one question and its options.
 *
 * The per-kind rules are checked here so the author is told before submitting, and
 * enforced by Zod and again by the service:
 *
 *   - single choice: exactly one correct
 *   - true/false: exactly two options, exactly one correct
 *   - multiple choice: at least one correct, and not all of them
 *
 * None of them can be a database CHECK — each spans sibling rows, and a row-local
 * constraint cannot count its siblings.
 *
 * Switching to TRUE_FALSE replaces the draft options with True and False, because a
 * true/false question with four options is not a true/false question and silently
 * trimming the author's work would be worse than replacing it visibly.
 */
function QuestionForm({ assessmentId }: { assessmentId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [kind, setKind] = useState<AssessmentQuestionKind>('SINGLE_CHOICE');
  const [prompt, setPrompt] = useState('');
  const [explanation, setExplanation] = useState('');
  const [points, setPoints] = useState('');
  const [options, setOptions] = useState<DraftOption[]>([
    { label: '', isCorrect: false },
    { label: '', isCorrect: false },
  ]);

  function changeKind(next: AssessmentQuestionKind): void {
    setKind(next);
    setMessage(null);
    if (next === 'TRUE_FALSE') {
      setOptions([
        { label: 'True', isCorrect: false },
        { label: 'False', isCorrect: false },
      ]);
    }
  }

  function setOption(index: number, patch: Partial<DraftOption>): void {
    setOptions((current) =>
      current.map((option, i) => {
        if (i !== index) {
          // A single-answer question has one correct option, so marking one
          // unmarks the rest rather than letting the author save something the
          // service will refuse.
          if (patch.isCorrect === true && kind !== 'MULTIPLE_CHOICE') {
            return { ...option, isCorrect: false };
          }
          return option;
        }
        return { ...option, ...patch };
      }),
    );
  }

  function save(): void {
    const filled = options
      .map((option) => ({ ...option, label: option.label.trim() }))
      .filter((option) => option.label.length > 0);

    if (prompt.trim().length < 2) {
      setMessage('Ask something.');
      return;
    }
    if (filled.length < 2) {
      setMessage('A question needs at least two options.');
      return;
    }

    const correct = filled.filter((option) => option.isCorrect).length;
    if (correct === 0) {
      setMessage('Mark at least one option correct.');
      return;
    }
    if (kind !== 'MULTIPLE_CHOICE' && correct !== 1) {
      setMessage('This kind of question has exactly one correct option.');
      return;
    }
    if (kind === 'TRUE_FALSE' && filled.length !== 2) {
      setMessage('A true/false question has exactly two options.');
      return;
    }
    if (kind === 'MULTIPLE_CHOICE' && correct === filled.length) {
      setMessage('If every option is correct the question tests nothing.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const weight = points.trim() === '' ? undefined : Number(points);
      const res = await addQuestionAction(assessmentId, {
        kind,
        prompt: prompt.trim(),
        ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
        ...(weight !== undefined && Number.isFinite(weight) ? { points: weight } : {}),
        options: filled.map((option) => ({
          label: option.label,
          isCorrect: option.isCorrect,
        })),
      });

      if (!res.ok) {
        setMessage(res.message);
        return;
      }

      setPrompt('');
      setExplanation('');
      setPoints('');
      setOptions(
        kind === 'TRUE_FALSE'
          ? [
              { label: 'True', isCorrect: false },
              { label: 'False', isCorrect: false },
            ]
          : [
              { label: '', isCorrect: false },
              { label: '', isCorrect: false },
            ],
      );
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`q-kind-${assessmentId}`} className="text-xs">
            Kind
          </Label>
          <select
            id={`q-kind-${assessmentId}`}
            value={kind}
            onChange={(event) => changeKind(event.target.value as AssessmentQuestionKind)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            {ASSESSMENT_QUESTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {QUESTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`q-points-${assessmentId}`} className="text-xs">
            Points
          </Label>
          <Input
            id={`q-points-${assessmentId}`}
            type="number"
            step="0.01"
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            placeholder="1"
            className="w-24"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`q-prompt-${assessmentId}`} className="text-xs">
          Question
        </Label>
        <Textarea
          id={`q-prompt-${assessmentId}`}
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink">Options</span>
        {options.map((option, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={option.isCorrect}
              onChange={(event) => setOption(index, { isCorrect: event.target.checked })}
              aria-label={`Option ${index + 1} is correct`}
            />
            <Input
              value={option.label}
              onChange={(event) => setOption(index, { label: event.target.value })}
              placeholder={`Option ${index + 1}`}
              readOnly={kind === 'TRUE_FALSE'}
              aria-label={`Option ${index + 1}`}
            />
            {kind !== 'TRUE_FALSE' && options.length > 2 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setOptions((current) => current.filter((_, i) => i !== index))
                }
                aria-label={`Remove option ${index + 1}`}
              >
                <Trash2 className="size-4 text-critical" aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}

        {kind !== 'TRUE_FALSE' && options.length < 10 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setOptions((current) => [...current, { label: '', isCorrect: false }])
            }
          >
            Add an option
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`q-expl-${assessmentId}`} className="text-xs">
          Explanation (shown after submission)
        </Label>
        <Textarea
          id={`q-expl-${assessmentId}`}
          rows={2}
          value={explanation}
          onChange={(event) => setExplanation(event.target.value)}
        />
      </div>

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}

      <div>
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Add question'}
        </Button>
      </div>
    </div>
  );
}
