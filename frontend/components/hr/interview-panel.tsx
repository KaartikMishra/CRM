'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { INTERVIEW_RECOMMENDATIONS, type InterviewSummary, type InterviewView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  closeInterviewAction,
  completeInterviewAction,
  submitInterviewFeedbackAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_STATUS_TONES,
  INTERVIEW_TYPE_LABELS,
  RECOMMENDATION_LABELS,
  RECOMMENDATION_TONES,
  formatMoment,
} from './recruitment-labels';

/**
 * One interview, its panel, and the feedback this viewer is entitled to see.
 *
 * ### The rule this component is built around
 *
 * An interviewer must not read the panel's other feedback before giving their own.
 * That is not politeness — it is why structured interviewing works at all. Somebody
 * who has read "the last two said no" has been told the answer, and the panel becomes
 * one opinion wearing four hats.
 *
 * **The filtering happens server-side.** `interview.feedback` arrives already narrowed
 * by the backend's panel rule, so this component renders whatever it was given. There
 * is deliberately no client-side filter: a filter here would mean the restricted
 * entries had already been sent to the browser, where anybody can read them in a
 * network tab. The empty-looking list is the protection working.
 *
 * `feedbackPending` tells the viewer they still owe their own — which is also the
 * explanation for why the panel's views are not shown yet.
 */
export function InterviewDetail({
  interview,
  canManage,
}: {
  interview: InterviewView;
  /** Whether the viewer may complete or cancel it. The API decides again. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState<'CANCELLED' | 'NO_SHOW' | null>(null);
  const [reason, setReason] = useState('');

  function complete(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await completeInterviewAction(interview.id);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.refresh();
    });
  }

  function close(status: 'CANCELLED' | 'NO_SHOW'): void {
    if (reason.trim().length < 5) {
      setMessage('Say why — this is a recorded fact about somebody.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result = await closeInterviewAction(interview.id, status, reason.trim());
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setClosing(null);
      setReason('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">
            {INTERVIEW_TYPE_LABELS[interview.interviewType]} interview
            {interview.round > 1 ? ` · round ${interview.round}` : ''}
          </span>
          <span className="text-xs text-muted">{formatMoment(interview.scheduledAt)}</span>
          <span className="text-xs text-muted">{interview.durationMinutes} minutes</span>
        </div>
        <Badge variant={INTERVIEW_STATUS_TONES[interview.status]}>
          {INTERVIEW_STATUS_LABELS[interview.status]}
        </Badge>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <Field label="Candidate" value={interview.candidate.displayName} />
        <Field label="Role" value={`${interview.job.title} (${interview.job.code})`} />
        <Field label="Lead interviewer" value={interview.interviewer?.displayName ?? '—'} />
        <Field
          label="Panel"
          value={
            interview.participants.length > 0
              ? interview.participants.map((p) => p.displayName).join(', ')
              : '—'
          }
        />
        {interview.location && <Field label="Where" value={interview.location} />}
        {interview.meetingUrl && <Field label="Link" value={interview.meetingUrl} />}
      </div>

      {canManage && interview.status === 'SCHEDULED' && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {closing === null ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={complete}>
                Mark held
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setClosing('NO_SHOW')}
              >
                No show
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setClosing('CANCELLED')}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  closing === 'NO_SHOW'
                    ? 'What happened? This is recorded about the candidate.'
                    : 'Why is this interview being cancelled?'
                }
                aria-label="Reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => close(closing)}
                >
                  {pending ? 'Saving…' : 'Confirm'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setClosing(null);
                    setReason('');
                  }}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <FeedbackSection interview={interview} />

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

/**
 * The panel's feedback, and the form for adding yours.
 *
 * The notice explaining *why* the panel's views may be hidden matters as much as the
 * hiding: without it, an interviewer sees an empty section and assumes nobody has
 * reported yet, which is a different and misleading fact.
 */
function FeedbackSection({ interview }: { interview: InterviewView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function submit(formData: FormData): void {
    setMessage(null);

    const recommendation = String(formData.get('recommendation') ?? '');
    const ratingRaw = String(formData.get('rating') ?? '');

    if (!recommendation) {
      setMessage('Say whether you would hire them. A rating alone is not a view.');
      return;
    }

    startTransition(async () => {
      const result = await submitInterviewFeedbackAction(interview.id, {
        recommendation,
        ...(ratingRaw ? { rating: Number(ratingRaw) } : {}),
        strengths: String(formData.get('strengths') ?? '').trim() || undefined,
        concerns: String(formData.get('concerns') ?? '').trim() || undefined,
        notes: String(formData.get('notes') ?? '').trim() || undefined,
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
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Panel feedback
        </h3>
        {interview.feedbackPending && !open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Give your feedback
          </Button>
        )}
      </div>

      {/*
        The explanation. Shown whenever the viewer still owes feedback, because an
        empty list without it reads as "nobody has reported" rather than "you have not
        reported".
      */}
      {interview.feedbackPending && (
        <p className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
          Other panel members’ feedback stays hidden until you submit your own, so that
          each view is formed independently.
        </p>
      )}

      {open && (
        <form action={submit} className="flex flex-col gap-3 rounded-md border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="recommendation">
                Would you hire them?<span className="text-critical"> *</span>
              </Label>
              <select
                id="recommendation"
                name="recommendation"
                defaultValue=""
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Choose…</option>
                {INTERVIEW_RECOMMENDATIONS.map((value) => (
                  <option key={value} value={value}>
                    {RECOMMENDATION_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="rating">Rating (1–5)</Label>
              <select
                id="rating"
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
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="strengths">Strengths</Label>
            <Textarea id="strengths" name="strengths" rows={2} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="concerns">Concerns</Label>
            <Textarea id="concerns" name="concerns" rows={2} />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="notes">Other notes</Label>
            <Textarea id="notes" name="notes" rows={2} />
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
              {pending ? 'Submitting…' : 'Submit feedback'}
            </Button>
          </div>
        </form>
      )}

      {interview.feedback.length === 0 ? (
        <p className="text-sm text-muted">
          {interview.feedbackPending
            ? 'Nothing visible to you yet.'
            : 'No feedback has been recorded.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {interview.feedback.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1 rounded-md border border-line p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{entry.employee.displayName}</span>
                <div className="flex items-center gap-1.5">
                  {entry.rating !== null && (
                    <Badge variant="outline">{entry.rating} / 5</Badge>
                  )}
                  <Badge variant={RECOMMENDATION_TONES[entry.recommendation]}>
                    {RECOMMENDATION_LABELS[entry.recommendation]}
                  </Badge>
                </div>
              </div>
              {entry.strengths && (
                <p className="text-xs text-ink-2">
                  <span className="text-muted">Strengths: </span>
                  {entry.strengths}
                </p>
              )}
              {entry.concerns && (
                <p className="text-xs text-ink-2">
                  <span className="text-muted">Concerns: </span>
                  {entry.concerns}
                </p>
              )}
              {entry.notes && <p className="text-xs text-ink-2">{entry.notes}</p>}
              <span className="text-xs text-muted">{formatMoment(entry.submittedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The interview list — a schedule, for a board or one application. */
export function InterviewList({ interviews }: { interviews: InterviewSummary[] }) {
  if (interviews.length === 0) {
    return <p className="text-sm text-muted">No interviews scheduled.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {interviews.map((interview) => (
        <li key={interview.id} className="flex flex-col gap-1 rounded-md border border-line p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-ink">
                {interview.candidate.displayName}
              </span>
              <span className="text-xs text-ink-2">
                {INTERVIEW_TYPE_LABELS[interview.interviewType]}
                {interview.round > 1 ? ` · round ${interview.round}` : ''} ·{' '}
                {interview.job.title}
              </span>
              <span className="text-xs text-muted">{formatMoment(interview.scheduledAt)}</span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge variant={INTERVIEW_STATUS_TONES[interview.status]}>
                {INTERVIEW_STATUS_LABELS[interview.status]}
              </Badge>
              {interview.feedbackPending && (
                <span className="text-xs text-warning">Your feedback is owed</span>
              )}
            </div>
          </div>
          <span className="text-xs text-muted">
            {interview.interviewer
              ? `Led by ${interview.interviewer.displayName}`
              : 'No lead interviewer set'}
            {interview.participants.length > 0
              ? ` · ${interview.participants.length} on the panel`
              : ''}
          </span>
        </li>
      ))}
    </ul>
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
