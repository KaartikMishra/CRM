'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import {
  COMPETENCY_RATINGS,
  type CompetencyRatingView,
  type PerformanceReviewView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  cancelReviewAction,
  finalizeReviewAction,
  saveManagerAssessmentAction,
  saveSelfAssessmentAction,
  submitManagerAssessmentAction,
  submitSelfAssessmentAction,
} from '@/app/(app)/hr/performance-actions';
import {
  COMPETENCY_CATEGORY_LABELS,
  RATING_LABELS,
  RATING_SHORT_LABELS,
  REVIEW_NEXT_STEP_FOR_EMPLOYEE,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  describeRatingGap,
  formatAttainment,
  formatPerfMoment,
  formatRating,
} from './performance-labels';

/**
 * The review surface: self-assessment, manager assessment, finalisation.
 *
 * ### Every control here is gated on `review.viewerCan`, computed server-side
 *
 * Not on the status, not on a local comparison of ids. The rules are not derivable
 * from the status alone — whether somebody may write the manager assessment depends
 * on who they are relative to this employee — so the server answers and these
 * components render the answer.
 *
 * **And the API enforces it again regardless.** Hiding a button is a courtesy; the
 * 403 is the control. An ADMIN holding APPROVE who is the subject of this review
 * sees no finalise button *and* gets 403 if they call the endpoint anyway — the
 * second is what the HTTP integration suite verifies.
 *
 * ### Rule 1 is not implemented here
 *
 * `review.managerAssessment` is **already null** for an employee whose manager has
 * not submitted, and so are that manager's per-competency ratings. The server nulls
 * them. This file renders a waiting state when they are absent and never asks for
 * them a second way — there is no endpoint in `performance-api.ts` that would
 * return them, which is what makes the rule hold rather than being remembered.
 *
 * ### A finalized review renders as a record, not a form
 *
 * Every `viewerCan` flag is false once finalised, so no control appears. The panel
 * says so explicitly rather than simply showing nothing, because "no buttons" and
 * "something failed to load" look identical otherwise.
 */

type Draft = Record<string, { rating: number; comments: string }>;

/** Builds the initial rating draft from whichever ratings this reader may see. */
function draftFrom(
  ratings: CompetencyRatingView[],
  source: 'self' | 'manager',
): Draft {
  const draft: Draft = {};
  for (const row of ratings) {
    const existing = source === 'self' ? row.self : row.manager;
    if (existing) {
      draft[row.competency.id] = {
        rating: existing.rating,
        comments: existing.comments ?? '',
      };
    }
  }
  return draft;
}

// ---------------------------------------------------------------------------
//  Shared: the rating sheet
// ---------------------------------------------------------------------------

/**
 * A rating sheet, for whichever side is writing.
 *
 * Native radios rather than a popover select: five options per competency, and a
 * radio group is keyboard-navigable for nothing and submits with the form.
 */
function RatingSheet({
  ratings,
  draft,
  onChange,
  disabled,
}: {
  ratings: CompetencyRatingView[];
  draft: Draft;
  onChange: (competencyId: string, patch: { rating?: number; comments?: string }) => void;
  disabled: boolean;
}) {
  if (ratings.length === 0) {
    return (
      <p className="text-sm text-muted">
        This cycle has no competencies to rate.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {ratings.map((row) => {
        const current = draft[row.competency.id];
        return (
          <div
            key={row.competency.id}
            className="flex flex-col gap-2 rounded-md border border-line p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">{row.competency.name}</span>
                <span className="text-xs text-muted">
                  {COMPETENCY_CATEGORY_LABELS[row.competency.category]} · weight{' '}
                  {row.competency.weight}
                </span>
              </div>
            </div>

            {row.competency.description && (
              <p className="text-xs text-ink-2">{row.competency.description}</p>
            )}

            <div className="flex flex-wrap gap-3">
              {COMPETENCY_RATINGS.map((level) => (
                <label
                  key={level}
                  className="flex items-center gap-1.5 text-xs text-ink-2"
                >
                  <input
                    type="radio"
                    name={`rating-${row.competency.id}`}
                    checked={current?.rating === level}
                    disabled={disabled}
                    onChange={() => onChange(row.competency.id, { rating: level })}
                  />
                  <span>
                    {level} — {RATING_SHORT_LABELS[level]}
                  </span>
                </label>
              ))}
            </div>

            <Textarea
              rows={2}
              value={current?.comments ?? ''}
              disabled={disabled}
              onChange={(event) =>
                onChange(row.competency.id, { comments: event.target.value })
              }
              placeholder="Why this rating? (optional)"
              aria-label={`Comments on ${row.competency.name}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Self-assessment
// ---------------------------------------------------------------------------

/**
 * The employee's own account of the period.
 *
 * Rendered only when `viewerCan.editSelfAssessment` is true, which the server sets
 * for the subject alone — not their manager, not HR, not an administrator holding
 * every grant. Once submitted it becomes read-only, because the manager has read it
 * and may already have written against it.
 */
export function SelfAssessmentPanel({ review }: { review: PerformanceReviewView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const existing = review.selfAssessment;
  const [achievements, setAchievements] = useState(existing?.achievements ?? '');
  const [challenges, setChallenges] = useState(existing?.challenges ?? '');
  const [wishes, setWishes] = useState(existing?.developmentWishes ?? '');
  const [overall, setOverall] = useState(existing?.overallRating ?? '');
  const [draft, setDraft] = useState<Draft>(() => draftFrom(review.competencyRatings, 'self'));

  const editable = review.viewerCan.editSelfAssessment;
  const submitted = existing?.submittedAt !== null && existing?.submittedAt !== undefined;

  function change(
    competencyId: string,
    patch: { rating?: number; comments?: string },
  ): void {
    setDraft((current) => ({
      ...current,
      [competencyId]: {
        rating: patch.rating ?? current[competencyId]?.rating ?? 0,
        comments: patch.comments ?? current[competencyId]?.comments ?? '',
      },
    }));
  }

  function payload(): Record<string, unknown> {
    const competencyRatings = Object.entries(draft)
      .filter(([, value]) => value.rating > 0)
      .map(([competencyId, value]) => ({
        competencyId,
        rating: value.rating,
        ...(value.comments.trim() ? { comments: value.comments.trim() } : {}),
      }));

    return {
      achievements: achievements.trim() || null,
      challenges: challenges.trim() || null,
      developmentWishes: wishes.trim() || null,
      ...(overall.trim() ? { overallRating: Number(overall) } : {}),
      ...(competencyRatings.length > 0 ? { competencyRatings } : {}),
    };
  }

  function save(): void {
    setMessage(null);
    setNotice(null);
    setFieldErrors({});

    startTransition(async () => {
      const res = await saveSelfAssessmentAction(review.id, payload());
      if (!res.ok) {
        setMessage(res.message);
        setFieldErrors(
          Object.fromEntries((res.details ?? []).map((d) => [d.path, d.message])),
        );
        return;
      }
      setNotice('Saved. You can come back to this before submitting.');
      router.refresh();
    });
  }

  function submit(): void {
    if (achievements.trim().length < 5) {
      setFieldErrors({ achievements: 'Say what you did before submitting.' });
      return;
    }

    setMessage(null);
    setNotice(null);
    setFieldErrors({});

    startTransition(async () => {
      // Saved first, so nothing typed since the last save is lost on submit.
      const saved = await saveSelfAssessmentAction(review.id, payload());
      if (!saved.ok) {
        setMessage(saved.message);
        return;
      }

      const res = await submitSelfAssessmentAction(review.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Your self-assessment
        </h2>
        {submitted && (
          <Badge variant="positive">
            Submitted {formatPerfMoment(existing?.submittedAt ?? null)}
          </Badge>
        )}
      </div>

      {!editable && !submitted && (
        <p className="text-sm text-muted">
          Only the employee being reviewed writes this.
        </p>
      )}

      {submitted && (
        <p className="text-xs text-muted">
          Submitted and read-only. Your manager has this and may already have written
          against it — ask HR if it genuinely needs reopening.
        </p>
      )}

      {/* Shown read-only once submitted, so the employee can still see what they said. */}
      {(editable || submitted) && (
        <>
          <Field
            label="What you achieved"
            value={achievements}
            onChange={setAchievements}
            disabled={!editable}
            error={fieldErrors.achievements}
            rows={4}
          />
          <Field
            label="What was difficult"
            value={challenges}
            onChange={setChallenges}
            disabled={!editable}
            rows={3}
          />
          <Field
            label="What you want next"
            value={wishes}
            onChange={setWishes}
            disabled={!editable}
            rows={3}
          />

          <div className="flex flex-col gap-1">
            <Label htmlFor="self-overall">Your overall rating (1–5, optional)</Label>
            <Input
              id="self-overall"
              type="number"
              step="0.01"
              min={1}
              max={5}
              value={overall}
              disabled={!editable}
              onChange={(event) => setOverall(event.target.value)}
              className="w-32"
            />
            <span className="text-xs text-muted">
              Left blank, the average of your competency ratings is used.
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Competencies
            </span>
            <RatingSheet
              ratings={review.competencyRatings}
              draft={draft}
              onChange={change}
              disabled={!editable}
            />
          </div>
        </>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
      {notice && <p className="text-sm text-positive">{notice}</p>}

      {editable && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
          {review.viewerCan.submitSelfAssessment && (
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending ? 'Submitting…' : 'Submit'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Manager assessment
// ---------------------------------------------------------------------------

/**
 * The manager's assessment.
 *
 * ### The waiting state is Rule 1 made visible
 *
 * When `review.managerAssessment` is null and the viewer cannot write it, this is
 * either an employee whose manager has not submitted, or somebody who may not see
 * it. Both render the same waiting message — and deliberately so: distinguishing
 * them would tell the employee that a draft exists, which is the thing being
 * withheld.
 *
 * The server decides. This component has no way to ask again.
 */
export function ManagerAssessmentPanel({
  review,
  isSubject,
}: {
  review: PerformanceReviewView;
  /** Whether the viewer is the employee being reviewed. Changes only the wording. */
  isSubject: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const existing = review.managerAssessment;
  const [strengths, setStrengths] = useState(existing?.strengths ?? '');
  const [improvements, setImprovements] = useState(existing?.improvementAreas ?? '');
  const [comments, setComments] = useState(existing?.comments ?? '');
  const [overall, setOverall] = useState(existing?.overallRating ?? '');
  const [promotion, setPromotion] = useState<string>(
    existing?.promotionRecommended === null || existing?.promotionRecommended === undefined
      ? ''
      : existing.promotionRecommended
        ? 'yes'
        : 'no',
  );
  const [draft, setDraft] = useState<Draft>(() =>
    draftFrom(review.competencyRatings, 'manager'),
  );

  const editable = review.viewerCan.editManagerAssessment;
  const submitted = existing?.submittedAt !== null && existing?.submittedAt !== undefined;

  // Not readable and not writable: either the manager has not submitted, or this
  // viewer is not entitled. Deliberately indistinguishable — see the file note.
  if (!editable && !existing) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Manager assessment
        </h2>
        <p className="text-sm text-muted">
          {isSubject
            ? 'Your manager has not shared their review yet. It appears here once they submit it.'
            : 'Not available.'}
        </p>
        {isSubject && review.status === 'MANAGER_REVIEW' && (
          <p className="text-xs text-muted">
            A manager&apos;s draft stays private until they submit it, so what you read
            is what they meant to say.
          </p>
        )}
      </Card>
    );
  }

  function change(
    competencyId: string,
    patch: { rating?: number; comments?: string },
  ): void {
    setDraft((current) => ({
      ...current,
      [competencyId]: {
        rating: patch.rating ?? current[competencyId]?.rating ?? 0,
        comments: patch.comments ?? current[competencyId]?.comments ?? '',
      },
    }));
  }

  function payload(): Record<string, unknown> {
    const competencyRatings = Object.entries(draft)
      .filter(([, value]) => value.rating > 0)
      .map(([competencyId, value]) => ({
        competencyId,
        rating: value.rating,
        ...(value.comments.trim() ? { comments: value.comments.trim() } : {}),
      }));

    return {
      strengths: strengths.trim() || null,
      improvementAreas: improvements.trim() || null,
      comments: comments.trim() || null,
      ...(overall.trim() ? { overallRating: Number(overall) } : {}),
      ...(promotion === '' ? {} : { promotionRecommended: promotion === 'yes' }),
      ...(competencyRatings.length > 0 ? { competencyRatings } : {}),
    };
  }

  function save(): void {
    setMessage(null);
    setNotice(null);
    startTransition(async () => {
      const res = await saveManagerAssessmentAction(review.id, payload());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setNotice('Saved as a draft. The employee cannot see it until you submit.');
      router.refresh();
    });
  }

  function submit(): void {
    if (strengths.trim().length < 5 && comments.trim().length < 5) {
      setMessage('Write the review before submitting it.');
      return;
    }

    setMessage(null);
    setNotice(null);
    startTransition(async () => {
      const saved = await saveManagerAssessmentAction(review.id, payload());
      if (!saved.ok) {
        setMessage(saved.message);
        return;
      }
      const res = await submitManagerAssessmentAction(review.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Manager assessment
        </h2>
        {submitted ? (
          <Badge variant="positive">
            Submitted {formatPerfMoment(existing?.submittedAt ?? null)}
          </Badge>
        ) : editable ? (
          <Badge variant="outline">Draft — not visible to the employee</Badge>
        ) : null}
      </div>

      {editable && !submitted && (
        <p className="rounded-md border border-brass-line bg-brass-soft p-2.5 text-xs text-ink-2">
          This stays private until you submit it. The employee sees nothing of it —
          not the narrative, not the ratings — so you can draft honestly.
        </p>
      )}

      <Field
        label="Strengths"
        value={strengths}
        onChange={setStrengths}
        disabled={!editable}
        rows={4}
      />
      <Field
        label="Areas to improve"
        value={improvements}
        onChange={setImprovements}
        disabled={!editable}
        rows={3}
      />
      <Field
        label="Other comments"
        value={comments}
        onChange={setComments}
        disabled={!editable}
        rows={3}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mgr-overall">Overall rating (1–5, optional)</Label>
          <Input
            id="mgr-overall"
            type="number"
            step="0.01"
            min={1}
            max={5}
            value={overall}
            disabled={!editable}
            onChange={(event) => setOverall(event.target.value)}
            className="w-32"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mgr-promotion">Recommend for promotion?</Label>
          <select
            id="mgr-promotion"
            value={promotion}
            disabled={!editable}
            onChange={(event) => setPromotion(event.target.value)}
            className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            {/* Blank is "not stated", which is different from "no" — a screen must
                not read an unanswered question as a negative recommendation. */}
            <option value="">Not stated</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Competencies
        </span>
        <RatingSheet
          ratings={review.competencyRatings}
          draft={draft}
          onChange={change}
          disabled={!editable}
        />
      </div>

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
      {notice && <p className="text-sm text-positive">{notice}</p>}

      {editable && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
          {review.viewerCan.submitManagerAssessment && (
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending ? 'Submitting…' : 'Submit for approval'}
            </Button>
          )}
        </div>
      )}

      {editable && !review.viewerCan.submitManagerAssessment && !submitted && (
        <p className="text-xs text-muted">
          The employee has not submitted their self-assessment yet, so this cannot be
          sent for approval.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Side-by-side comparison
// ---------------------------------------------------------------------------

/**
 * Both sides' ratings, together.
 *
 * The appraisal conversation is largely about disagreement, so the gap is named
 * rather than left for somebody to compute by eye.
 *
 * A manager column that is null here is a withheld rating, not a missing one — the
 * server filtered it. The header says so, because an empty cell otherwise reads as
 * "your manager did not rate this".
 */
export function RatingComparison({
  ratings,
  managerVisible,
}: {
  ratings: CompetencyRatingView[];
  /** Whether the manager's half has been shared. From the server's own filtering. */
  managerVisible: boolean;
}) {
  if (ratings.length === 0) return null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Ratings side by side
      </h2>

      {!managerVisible && (
        <p className="text-xs text-muted">
          Your manager&apos;s ratings appear here once they submit their review.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {ratings.map((row) => {
          const gap = managerVisible
            ? describeRatingGap(row.self?.rating ?? null, row.manager?.rating ?? null)
            : null;

          return (
            <li
              key={row.competency.id}
              className="flex flex-col gap-1 rounded-md border border-line p-3"
            >
              <span className="text-sm font-medium text-ink">{row.competency.name}</span>
              <div className="flex flex-wrap gap-6">
                <Figure
                  label="You"
                  value={
                    row.self ? `${row.self.rating} — ${RATING_LABELS[row.self.rating]}` : '—'
                  }
                />
                <Figure
                  label="Manager"
                  value={
                    row.manager
                      ? `${row.manager.rating} — ${RATING_LABELS[row.manager.rating]}`
                      : managerVisible
                        ? '—'
                        : 'Not shared yet'
                  }
                />
              </div>
              {gap && <span className="text-xs text-accent">{gap}</span>}
              {row.self?.comments && (
                <p className="text-xs text-ink-2">
                  <span className="font-medium">You: </span>
                  {row.self.comments}
                </p>
              )}
              {row.manager?.comments && (
                <p className="text-xs text-ink-2">
                  <span className="font-medium">Manager: </span>
                  {row.manager.comments}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Finalisation
// ---------------------------------------------------------------------------

/**
 * Approving a review, and the record once approved.
 *
 * ### The button appears only when the server says so
 *
 * `review.viewerCan.finalize` is false for the subject — whatever grants they hold,
 * including an ADMIN with APPROVE. The API refuses it too, before consulting the
 * grant. Both, deliberately: the hidden button is the courtesy and the 403 is the
 * control.
 *
 * ### A finalized review says it is locked
 *
 * Rather than simply showing no controls, which is indistinguishable from a page
 * that failed to load. The record of who approved it and when is the point of the
 * panel at that stage.
 */
export function FinalizationPanel({
  review,
  isSubject,
}: {
  review: PerformanceReviewView;
  isSubject: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [rating, setRating] = useState('');
  const [comments, setComments] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const finalized = review.status === 'FINALIZED';

  function finalize(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await finalizeReviewAction(review.id, {
        ...(rating.trim() ? { finalRating: Number(rating) } : {}),
        ...(comments.trim() ? { finalComments: comments.trim() } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function cancel(): void {
    if (reason.trim().length < 5) {
      setMessage('Say why this review is being withdrawn.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const res = await cancelReviewAction(review.id, reason.trim());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setCancelling(false);
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Outcome
        </h2>
        <Badge variant={REVIEW_STATUS_TONES[review.status]}>
          {REVIEW_STATUS_LABELS[review.status]}
        </Badge>
      </div>

      {finalized && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted" aria-hidden="true" />
            <span className="text-sm font-medium text-ink">
              Finalised and locked — nobody can change this
            </span>
          </div>
          <div className="flex flex-wrap gap-6">
            <Figure label="Final rating" value={formatRating(review.finalRating)} />
            <Figure
              label="Goal attainment"
              value={formatAttainment(review.goalAttainment)}
            />
            <Figure label="Approved by" value={review.finalizedBy?.name ?? '—'} />
            <Figure label="Approved" value={formatPerfMoment(review.finalizedAt)} />
          </div>
          {review.finalComments && (
            <p className="whitespace-pre-line text-sm text-ink-2">{review.finalComments}</p>
          )}
        </div>
      )}

      {review.status === 'CANCELLED' && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
          <span className="text-sm text-ink">
            Withdrawn {formatPerfMoment(review.cancelledAt)}
          </span>
          {review.cancellationReason && (
            <span className="text-xs text-ink-2">{review.cancellationReason}</span>
          )}
        </div>
      )}

      {/*
        The subject is told plainly why they cannot approve, rather than being shown
        nothing. An ADMIN who is the subject of this review holds APPROVE and would
        otherwise reasonably wonder where the button went.
      */}
      {isSubject && review.status === 'PENDING_APPROVAL' && (
        <p className="text-sm text-muted">
          Your review is waiting on approval. Nobody approves their own review —
          somebody else signs this off.
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      {review.viewerCan.finalize && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="final-rating">Final rating (1–5, optional)</Label>
              <Input
                id="final-rating"
                type="number"
                step="0.01"
                min={1}
                max={5}
                value={rating}
                onChange={(event) => setRating(event.target.value)}
                className="w-32"
              />
            </div>
          </div>
          <span className="text-xs text-muted">
            Left blank, the manager&apos;s rating of{' '}
            {formatRating(review.managerOverallRating)} is used.
          </span>
          <Textarea
            rows={2}
            value={comments}
            onChange={(event) => setComments(event.target.value)}
            placeholder="Note on the outcome (optional)"
            aria-label="Final comments"
          />
          <div>
            <Button size="sm" disabled={pending} onClick={finalize}>
              {pending ? 'Finalising…' : 'Finalise review'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            Finalising locks the record. It cannot be reopened afterwards.
          </p>
        </div>
      )}

      {review.viewerCan.cancel && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {cancelling ? (
            <>
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this review being withdrawn?"
                aria-label="Withdrawal reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={cancel}>
                  {pending ? 'Saving…' : 'Confirm withdrawal'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCancelling(false)}>
                  Back
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>
                Withdraw this review
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** What the employee should do next, in one line. */
export function NextStepBanner({ review }: { review: PerformanceReviewView }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-ink-2">{REVIEW_NEXT_STEP_FOR_EMPLOYEE[review.status]}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Primitives
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  disabled,
  error,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  error?: string;
  rows?: number;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
      />
      {error && <span className="text-xs text-critical">{error}</span>}
    </div>
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
