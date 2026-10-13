'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { QuestionPaperView, TrainingAttemptView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  startAttemptAction,
  submitAttemptAction,
} from '@/app/(app)/hr/training-actions';
import {
  ATTEMPT_STATUS_LABELS,
  ATTEMPT_STATUS_TONES,
  QUESTION_KIND_HINTS,
  QUESTION_KIND_LABELS,
  describeAttempts,
  formatPercent,
  formatScoreOf,
  formatTrainingMoment,
} from './training-labels';

/**
 * Sitting an assessment.
 *
 * ### The paper this component receives contains no answer key
 *
 * `QuestionPaperView` has no `isCorrect` field — not optional, absent — and the
 * backend builds it from a select that omits the column. So there is nothing here to
 * leak: this component could not render the key if it tried, because the data never
 * arrives.
 *
 * That is why the paper and the review are **two different shapes** rather than one
 * with optional fields. An optional `isCorrect` would be one careless spread away
 * from being populated on the paper, and a component that merely chose not to render
 * it would still be shipping it to a browser where anybody can read it.
 *
 * ### Nothing here is scored
 *
 * The submission sends which options were selected and nothing else. No running
 * total, no "you have 4 of 5 right", no optimistic pass indication — the component
 * does not know and must not guess. The server grades against the options' own
 * correctness and the program's threshold, and the result arrives from that call.
 *
 * ### The attempt is not restartable
 *
 * An open, unexpired attempt is resumed by the backend rather than replaced, so
 * reloading does not cost a retry. The component therefore has no "start over"
 * button: it would either do nothing or, worse, look like it had.
 */
export function AssessmentRunner({
  enrollmentId,
  assessment,
  canSit,
}: {
  enrollmentId: string;
  /** The module's assessment summary, as the enrollment view reports it. */
  assessment: {
    id: string;
    title: string;
    passingScore: string;
    maxAttempts: number;
    attemptsUsed: number;
    attemptsRemaining: number;
    bestPercentage: string | null;
    hasPassed: boolean;
    openAttemptId: string | null;
  };
  /**
   * Whether this viewer is the learner.
   *
   * The API refuses anybody else — including an administrator holding every grant —
   * so this only decides whether to render the controls. A manager reading a
   * report's progress sees the state and no buttons.
   */
  canSit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [paper, setPaper] = useState<QuestionPaperView | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<TrainingAttemptView | null>(null);

  function begin(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await startAttemptAction(enrollmentId, assessment.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setPaper(res.data.paper);
      setSelected({});
      setResult(null);
    });
  }

  function toggle(questionId: string, optionId: string, single: boolean): void {
    setSelected((current) => {
      const existing = current[questionId] ?? [];
      if (single) return { ...current, [questionId]: [optionId] };
      return {
        ...current,
        [questionId]: existing.includes(optionId)
          ? existing.filter((id) => id !== optionId)
          : [...existing, optionId],
      };
    });
  }

  function submit(): void {
    if (!paper) return;
    setMessage(null);

    startTransition(async () => {
      const res = await submitAttemptAction(
        paper.attemptId,
        enrollmentId,
        // Every question, including the ones left blank: a deliberately unanswered
        // question is a legitimate answer worth zero, and omitting it would leave the
        // grader guessing which were skipped.
        paper.questions.map((q) => ({
          questionId: q.id,
          selectedOptionIds: selected[q.id] ?? [],
        })),
      );

      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setResult(res.data.attempt);
      setPaper(null);
      router.refresh();
    });
  }

  // --- the result of a just-submitted attempt ------------------------------
  if (result) {
    return <AttemptResult attempt={result} onDone={() => setResult(null)} />;
  }

  // --- the paper ----------------------------------------------------------
  if (paper) {
    const answered = paper.questions.filter((q) => (selected[q.id] ?? []).length > 0).length;

    return (
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">{paper.title}</span>
            <span className="text-xs text-muted">
              Attempt {paper.attemptNumber} · pass mark {formatPercent(paper.passingScore)}
            </span>
          </div>
          {paper.expiresAt && (
            <Badge variant="warning">Due by {formatTrainingMoment(paper.expiresAt)}</Badge>
          )}
        </div>

        {paper.instructions && (
          <p className="whitespace-pre-line rounded-md border border-line bg-surface-2 p-3 text-sm text-ink-2">
            {paper.instructions}
          </p>
        )}

        <ol className="flex flex-col gap-4">
          {paper.questions.map((question, index) => {
            const single = question.kind !== 'MULTIPLE_CHOICE';
            const chosen = selected[question.id] ?? [];

            return (
              <li key={question.id} className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-ink">
                    {index + 1}. {question.prompt}
                  </span>
                  <span className="text-xs text-muted">
                    {QUESTION_KIND_LABELS[question.kind]} ·{' '}
                    {QUESTION_KIND_HINTS[question.kind]}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  {question.options.map((option) => (
                    <label
                      key={option.id}
                      className="flex items-start gap-2 rounded-md border border-line p-2.5 text-sm text-ink-2"
                    >
                      <input
                        type={single ? 'radio' : 'checkbox'}
                        name={question.id}
                        checked={chosen.includes(option.id)}
                        onChange={() => toggle(question.id, option.id, single)}
                        className="mt-0.5"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>

        {message && (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-xs text-muted">
            {answered} of {paper.questions.length} answered
          </span>
          <Button disabled={pending} onClick={submit}>
            {pending ? 'Submitting…' : 'Submit answers'}
          </Button>
        </div>

        {/*
          No "save draft" and no "start over". An attempt is open on the server from
          the moment it is issued; a draft button would imply it was not, and a
          restart would either do nothing or consume a retry.
        */}
        <p className="text-xs text-muted">
          This attempt is already open. Submitting records it — there is no draft.
        </p>
      </Card>
    );
  }

  // --- the state before sitting -------------------------------------------
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{assessment.title}</span>
          <span className="text-xs text-muted">
            Pass mark {formatPercent(assessment.passingScore)} ·{' '}
            {describeAttempts(
              assessment.attemptsUsed,
              assessment.attemptsRemaining,
              assessment.maxAttempts,
            )}
          </span>
        </div>
        {assessment.hasPassed ? (
          <Badge variant="positive">Passed</Badge>
        ) : assessment.attemptsUsed > 0 ? (
          <Badge variant="warning">Not passed yet</Badge>
        ) : (
          <Badge variant="outline">Not attempted</Badge>
        )}
      </div>

      {assessment.bestPercentage !== null && (
        <p className="text-sm text-ink-2">
          Best score so far: {formatPercent(assessment.bestPercentage)}
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      {canSit && !assessment.hasPassed && (
        <div className="flex flex-wrap items-center gap-2">
          {assessment.attemptsRemaining > 0 || assessment.openAttemptId !== null ? (
            <Button size="sm" disabled={pending} onClick={begin}>
              {pending
                ? 'Opening…'
                : assessment.openAttemptId !== null
                  ? 'Resume attempt'
                  : assessment.attemptsUsed > 0
                    ? 'Try again'
                    : 'Start the test'}
            </Button>
          ) : (
            /*
              Out of attempts. The message names the remedy rather than leaving a
              dead end: a trainer can review the situation, and the learner cannot
              fix it themselves.
            */
            <p className="text-sm text-ink-2">
              You have used all {assessment.maxAttempts} attempts. Speak to your trainer
              about a reset.
            </p>
          )}
        </div>
      )}

      {!canSit && (
        <p className="text-xs text-muted">
          Only the learner can sit their own assessment.
        </p>
      )}
    </Card>
  );
}

/**
 * The result of an attempt, with per-question review.
 *
 * This is where correctness and the explanation legitimately appear — **after**
 * submission, from the separate `QuestionReviewView` shape. An in-progress attempt
 * comes back with an empty `questions` array from the server, so there is no state in
 * which this renders a key for an unfinished paper.
 */
export function AttemptResult({
  attempt,
  onDone,
}: {
  attempt: TrainingAttemptView;
  onDone?: () => void;
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{attempt.assessmentTitle}</span>
          <span className="text-xs text-muted">
            Attempt {attempt.attemptNumber} · pass mark {formatPercent(attempt.passingScore)}
          </span>
        </div>
        <Badge variant={ATTEMPT_STATUS_TONES[attempt.status]}>
          {ATTEMPT_STATUS_LABELS[attempt.status]}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Figure label="Score" value={formatScoreOf(attempt.score, attempt.maxScore)} />
        <Figure label="Percentage" value={formatPercent(attempt.percentage)} />
        <Figure
          label="Submitted"
          value={attempt.submittedAt ? formatTrainingMoment(attempt.submittedAt) : '—'}
        />
      </div>

      {/*
        Whether another attempt is allowed is the server's answer, with its reason.
        The component does not count attempts itself — it would be a second tally free
        to disagree with the one the API enforces.
      */}
      {!attempt.canRetake && attempt.retakeBlockedReason && (
        <p className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
          {attempt.retakeBlockedReason}
        </p>
      )}

      {attempt.questions.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Your answers
          </h3>
          <ol className="flex flex-col gap-3">
            {attempt.questions.map((question, index) => (
              <li key={question.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="text-sm text-ink">
                    {index + 1}. {question.prompt}
                  </span>
                  <Badge variant={question.isCorrect ? 'positive' : 'critical'}>
                    {question.isCorrect ? 'Correct' : 'Incorrect'}
                  </Badge>
                </div>

                <ul className="flex flex-col gap-1">
                  {question.options.map((option) => (
                    <li
                      key={option.id}
                      className={
                        option.isCorrect
                          ? 'rounded-md border border-positive/30 bg-positive-soft px-2.5 py-1.5 text-xs text-positive'
                          : option.wasSelected
                            ? 'rounded-md border border-critical/30 bg-critical-soft px-2.5 py-1.5 text-xs text-critical'
                            : 'rounded-md border border-line px-2.5 py-1.5 text-xs text-muted'
                      }
                    >
                      {option.label}
                      {option.wasSelected && <span className="ml-1.5">· you chose this</span>}
                      {option.isCorrect && !option.wasSelected && (
                        <span className="ml-1.5">· correct answer</span>
                      )}
                    </li>
                  ))}
                </ul>

                {question.explanation && (
                  <p className="text-xs text-ink-2">{question.explanation}</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {onDone && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onDone}>
            Back to the course
          </Button>
        </div>
      )}
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}
