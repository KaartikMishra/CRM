'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  INTERVIEW_RECOMMENDATIONS,
  PROBATION_DECISIONS,
  type ProbationReviewView,
  type ProbationView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  decideProbationAction,
  recordProbationReviewAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  PROBATION_DECISION_LABELS,
  PROBATION_REVIEW_STATUS_LABELS,
  PROBATION_REVIEW_STATUS_TONES,
  PROBATION_REVIEW_TYPE_LABELS,
  PROBATION_STATUS_LABELS,
  PROBATION_STATUS_TONES,
  RECOMMENDATION_LABELS,
  RECOMMENDATION_TONES,
  formatDay,
  formatMoment,
} from './recruitment-labels';

/**
 * One probation — its four reviews and the decision.
 *
 * ### Terminating a probation does not end an employment
 *
 * The most important restraint in this component, and it is deliberate. A TERMINATE
 * decision records the decision; it does not set `Employee.status` to EXITED. That is a
 * Phase 1 operation with its own exit-date requirement and its own EmployeeHistory
 * entry, and doing it as a side effect here would end somebody's employment with no
 * leaving date and nothing in their timeline saying so.
 *
 * The notice below says that plainly, where the person making the decision will read
 * it — rather than leaving them to discover later that the employment record still says
 * ACTIVE.
 *
 * ### Nobody decides or reviews their own
 *
 * Enforced by the service, which refuses it regardless of what this renders. The same
 * principle `decidesOwnAction` encodes for approvals: a self-assessment recorded as a
 * manager's review is not a review.
 *
 * ### Probation is not performance management
 *
 * Four scheduled reviews and one decision. No goals, no competencies, no calibration —
 * those are Phase 4, and guessing at a framework here would mean migrating away from
 * the guess.
 */
export function ProbationDetail({
  probation,
  canReview,
  canDecide,
}: {
  probation: ProbationView;
  /** Whether the viewer may record reviews. The API decides again. */
  canReview: boolean;
  /** Whether they may make the decision. The API refuses self-decisions regardless. */
  canDecide: boolean;
}) {
  const decided = probation.decision !== null && probation.status !== 'EXTENDED';
  const open = probation.status === 'ACTIVE' || probation.status === 'EXTENDED';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink">
              {probation.employee.displayName}
            </span>
            <span className="text-xs text-muted">{probation.employee.employeeId}</span>
          </div>
          <Badge variant={PROBATION_STATUS_TONES[probation.status]}>
            {PROBATION_STATUS_LABELS[probation.status]}
          </Badge>
        </div>

        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <Field label="Started" value={formatDay(probation.startDate)} />
          <Field label="Ends" value={formatDay(probation.endDate)} />
          {/*
            Shown only on an extension. The original term is kept rather than lost to an
            UPDATE, so "this was extended from the 1st of June" survives.
          */}
          {probation.originalEndDate && (
            <Field label="Originally ended" value={formatDay(probation.originalEndDate)} />
          )}
          <Field label="Reviewing manager" value={probation.manager?.displayName ?? 'Not set'} />
          <Field
            label="Reviews"
            value={`${probation.completedReviewCount} of ${probation.reviewCount} done`}
          />
        </div>

        {probation.decision && (
          <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
            <span className="text-sm font-medium text-ink">
              {PROBATION_DECISION_LABELS[probation.decision]}
              {probation.decidedBy ? ` by ${probation.decidedBy.name}` : ''}
            </span>
            {probation.decidedAt && (
              <span className="text-xs text-muted">{formatMoment(probation.decidedAt)}</span>
            )}
            {probation.decisionReason && (
              <p className="text-xs text-ink-2">{probation.decisionReason}</p>
            )}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Review timeline
        </h2>
        <ReviewTimeline
          reviews={probation.reviews}
          probationId={probation.id}
          canReview={canReview && open}
        />
      </Card>

      {canDecide && open && <DecisionCard probation={probation} />}
    </div>
  );
}

/**
 * The four reviews, in schedule order.
 *
 * All four are created when probation starts, so the timeline is complete from day one
 * rather than filling in as somebody remembers — which is the point of a schedule.
 */
function ReviewTimeline({
  reviews,
  probationId,
  canReview,
}: {
  reviews: ProbationReviewView[];
  probationId: string;
  canReview: boolean;
}) {
  if (reviews.length === 0) {
    return <p className="text-sm text-muted">No reviews scheduled.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {reviews.map((review) => (
        <ReviewRow
          key={review.id}
          review={review}
          probationId={probationId}
          canReview={canReview}
        />
      ))}
    </ol>
  );
}

function ReviewRow({
  review,
  probationId,
  canReview,
}: {
  review: ProbationReviewView;
  probationId: string;
  canReview: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const recordable = canReview && review.status !== 'COMPLETED';

  function submit(formData: FormData): void {
    setMessage(null);

    const comments = String(formData.get('comments') ?? '').trim();
    // A rating with no comment is a number somebody is expected to act on with no
    // explanation — and this record is what a later confirmation or termination rests
    // on. Required here, by Zod and by a CHECK.
    if (comments.length < 5) {
      setMessage('Say what this review found.');
      return;
    }

    const ratingRaw = String(formData.get('rating') ?? '');
    const recommendation = String(formData.get('recommendation') ?? '');

    startTransition(async () => {
      const result = await recordProbationReviewAction(review.id, probationId, {
        comments,
        ...(ratingRaw ? { rating: Number(ratingRaw) } : {}),
        ...(recommendation ? { recommendation } : {}),
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">
            {PROBATION_REVIEW_TYPE_LABELS[review.reviewType]}
          </span>
          <span className="text-xs text-muted">Due {formatDay(review.scheduledOn)}</span>
          {review.reviewer && (
            <span className="text-xs text-muted">Reviewed by {review.reviewer.displayName}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {review.rating !== null && <Badge variant="outline">{review.rating} / 5</Badge>}
          {review.recommendation && (
            <Badge variant={RECOMMENDATION_TONES[review.recommendation]}>
              {RECOMMENDATION_LABELS[review.recommendation]}
            </Badge>
          )}
          <Badge variant={PROBATION_REVIEW_STATUS_TONES[review.status]}>
            {PROBATION_REVIEW_STATUS_LABELS[review.status]}
          </Badge>
        </div>
      </div>

      {review.comments && <p className="text-xs text-ink-2">{review.comments}</p>}

      {recordable && !open && (
        <div>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Record this review
          </Button>
        </div>
      )}

      {open && (
        <form action={submit} className="flex flex-col gap-3 rounded-md border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rating-${review.id}`}>Rating (1–5)</Label>
              <select
                id={`rating-${review.id}`}
                name="rating"
                defaultValue=""
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Not scored</option>
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor={`recommendation-${review.id}`}>Recommendation</Label>
              <select
                id={`recommendation-${review.id}`}
                name="recommendation"
                defaultValue=""
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Not stated</option>
                {INTERVIEW_RECOMMENDATIONS.map((value) => (
                  <option key={value} value={value}>
                    {RECOMMENDATION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`comments-${review.id}`}>
              What did this review find?<span className="text-critical"> *</span>
            </Label>
            <Textarea id={`comments-${review.id}`} name="comments" rows={3} />
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
              {pending ? 'Saving…' : 'Record review'}
            </Button>
          </div>
        </form>
      )}

      {message && !open && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * The probation decision.
 *
 * All three need a reason — required here, by Zod, by the service and by a CHECK,
 * because this is the record an employment dispute turns on. An extension additionally
 * needs a new end date, and the original is kept.
 */
function DecisionCard({ probation }: { probation: ProbationView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState<string>('');
  const [reason, setReason] = useState('');
  const [newEndDate, setNewEndDate] = useState('');

  function submit(): void {
    setMessage(null);

    if (!decision) {
      setMessage('Choose a decision.');
      return;
    }
    if (reason.trim().length < 5) {
      setMessage('Say why — this is the record an appeal would rest on.');
      return;
    }
    if (decision === 'EXTEND' && !newEndDate) {
      setMessage('An extension needs a new end date.');
      return;
    }
    if (decision === 'EXTEND' && newEndDate <= probation.endDate) {
      setMessage('The new end date has to be later than the current one.');
      return;
    }

    startTransition(async () => {
      const result = await decideProbationAction(probation.id, {
        decision,
        reason: reason.trim(),
        ...(decision === 'EXTEND' ? { newEndDate: `${newEndDate}T00:00:00.000Z` } : {}),
      });

      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setDecision('');
      setReason('');
      setNewEndDate('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Probation decision
      </h2>

      <div className="flex flex-wrap gap-2">
        {PROBATION_DECISIONS.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={decision === value ? 'default' : 'outline'}
            disabled={pending}
            onClick={() => setDecision(value)}
          >
            {PROBATION_DECISION_LABELS[value]}
          </Button>
        ))}
      </div>

      {/*
        The restraint, stated where the decision is made. Without this notice somebody
        terminating a probation would reasonably assume the employment had ended, and
        discover weeks later that the directory still lists the person as active.
      */}
      {decision === 'TERMINATE' && (
        <p className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
          <strong className="text-ink">This records the decision only.</strong> It does not
          end the employment — marking somebody as left, with their last working day, is a
          separate step on their employee profile.
        </p>
      )}

      {decision === 'EXTEND' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="newEndDate">
            New end date<span className="text-critical"> *</span>
          </Label>
          <Input
            id="newEndDate"
            type="date"
            value={newEndDate}
            onChange={(event) => setNewEndDate(event.target.value)}
          />
          <span className="text-xs text-muted">
            Currently ends {formatDay(probation.endDate)}. The original date is kept on the
            record.
          </span>
        </div>
      )}

      {decision && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="decisionReason">
            Reason<span className="text-critical"> *</span>
          </Label>
          <Textarea
            id="decisionReason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      {decision && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setDecision('');
              setReason('');
              setNewEndDate('');
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : `Confirm ${PROBATION_DECISION_LABELS[decision as 'CONFIRM']}`}
          </Button>
        </div>
      )}
    </Card>
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
