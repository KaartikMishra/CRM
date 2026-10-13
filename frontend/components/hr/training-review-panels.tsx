'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  PracticalSubmissionView,
  QualificationGap,
  ShadowingRecordView,
  TrainingQualificationView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/common/empty-state';
import { ClipboardCheck, Eye } from 'lucide-react';
import {
  qualifyAction,
  reviewPracticalAction,
  revokeQualificationAction,
  signOffShadowingAction,
} from '@/app/(app)/hr/training-actions';
import {
  PRACTICAL_STATUS_LABELS,
  PRACTICAL_STATUS_TONES,
  QUALIFICATION_GAP_LABELS,
  SHADOWING_STATUS_LABELS,
  SHADOWING_STATUS_TONES,
  formatPercent,
  formatTrainingDay,
  formatTrainingMoment,
} from './training-labels';

/**
 * The practical review queue.
 *
 * ### The controls are offered, and the API decides
 *
 * A reviewer is usually an ordinary colleague holding no training grant — being
 * assigned is a fact about rows, not a permission — so hiding the buttons behind a
 * permission check would break the feature for the people it exists for.
 *
 * So the panel renders them and the backend enforces the rule, refusing **the learner
 * first** before any permission check. A learner who reaches their own submission
 * here sees the buttons and gets a 403 with a sentence saying nobody reviews their
 * own work. That is the right trade: the alternative silently removes the controls
 * from every genuine reviewer.
 *
 * `viewerEmployeeCode` is still passed, for the one case worth suppressing — a viewer
 * looking at their *own* submission, where the button could only ever fail.
 */
export function PracticalReviewQueue({
  practicals,
  viewerEmployeeCode,
}: {
  practicals: PracticalSubmissionView[];
  /**
   * The viewer's own employee code, as `/api/auth/me` reports it.
   *
   * The code rather than the row id, because that is what the session carries — the
   * same comparison the probation page makes.
   */
  viewerEmployeeCode: string | null;
}) {
  if (practicals.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing waiting for review"
          description="Practical exercises appear here once a learner submits one."
        />
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {practicals.map((practical) => (
        <PracticalRow
          key={practical.id}
          practical={practical}
          isOwn={
            viewerEmployeeCode !== null &&
            practical.employee.employeeId === viewerEmployeeCode
          }
        />
      ))}
    </ul>
  );
}

function PracticalRow({
  practical,
  isOwn,
}: {
  practical: PracticalSubmissionView;
  isOwn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [notes, setNotes] = useState('');

  // Nobody reviews their own, whatever else they hold — so the buttons are not
  // offered on your own submission. The service refuses it regardless.
  const reviewable = practical.status === 'SUBMITTED' && !isOwn;

  function decide(decision: 'APPROVED' | 'REJECTED'): void {
    if (decision === 'REJECTED' && notes.trim().length < 5) {
      setMessage('Say what needs fixing — otherwise the learner cannot act on it.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await reviewPracticalAction(practical.id, {
        decision,
        ...(notes.trim() ? { reviewNotes: notes.trim() } : {}),
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setRejecting(false);
      setNotes('');
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">
            {practical.employee.displayName}
            <span className="ml-2 text-xs text-muted">{practical.employee.employeeId}</span>
          </span>
          <span className="text-sm text-ink-2">{practical.moduleTitle}</span>
          {practical.submittedAt && (
            <span className="text-xs text-muted">
              Submitted {formatTrainingMoment(practical.submittedAt)}
            </span>
          )}
        </div>
        <Badge variant={PRACTICAL_STATUS_TONES[practical.status]}>
          {PRACTICAL_STATUS_LABELS[practical.status]}
        </Badge>
      </div>

      {practical.instructions && (
        <p className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
          <span className="font-medium text-ink">What was asked: </span>
          {practical.instructions}
        </p>
      )}

      {practical.submissionNotes && (
        <p className="whitespace-pre-line text-sm text-ink-2">{practical.submissionNotes}</p>
      )}

      {/*
        An attached artefact is referenced, never linked. The bytes are in
        authenticated storage and links are minted per request — a stored link
        outlives every access check.
      */}
      {practical.secureDocumentId && (
        <p className="text-xs text-muted">A file is attached to this submission.</p>
      )}

      {practical.reviewedBy && (
        <p className="text-xs text-muted">
          {practical.status === 'APPROVED' ? 'Approved' : 'Returned'} by{' '}
          {practical.reviewedBy.displayName}
          {practical.reviewedAt ? ` · ${formatTrainingMoment(practical.reviewedAt)}` : ''}
          {practical.reviewNotes ? ` — ${practical.reviewNotes}` : ''}
        </p>
      )}

      {isOwn && practical.status === 'SUBMITTED' && (
        <p className="text-xs text-muted">
          This is your own submission — somebody else reviews it.
        </p>
      )}

      {reviewable && (
        <div className="flex flex-col gap-2">
          {rejecting && (
            <Textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="What does the learner need to change?"
              aria-label="Review notes"
            />
          )}

          <div className="flex flex-wrap gap-2">
            {!rejecting ? (
              <>
                <Button size="sm" disabled={pending} onClick={() => decide('APPROVED')}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setRejecting(true)}
                >
                  Return for rework
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => decide('REJECTED')}
                >
                  {pending ? 'Saving…' : 'Confirm return'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
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

/**
 * The shadowing sign-off queue.
 *
 * Same shape and the same rule as the practical: never the learner. Feedback is
 * required — a sign-off is a gate on live work, so "completed" with nothing observed
 * recorded is an approval nobody can defend.
 */
export function ShadowingQueue({
  shadowings,
  viewerEmployeeCode,
}: {
  shadowings: ShadowingRecordView[];
  /** The viewer's own employee code, as `/api/auth/me` reports it. */
  viewerEmployeeCode: string | null;
}) {
  if (shadowings.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Eye}
          title="No shadowing to sign off"
          description="Scheduled shadowing periods appear here for their mentor."
        />
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {shadowings.map((shadowing) => (
        <ShadowingRow
          key={shadowing.id}
          shadowing={shadowing}
          isOwn={
            viewerEmployeeCode !== null &&
            shadowing.employee.employeeId === viewerEmployeeCode
          }
        />
      ))}
    </ul>
  );
}

function ShadowingRow({
  shadowing,
  isOwn,
}: {
  shadowing: ShadowingRecordView;
  isOwn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  const signable = shadowing.signedOffAt === null && shadowing.status !== 'CANCELLED' && !isOwn;

  function signOff(): void {
    if (feedback.trim().length < 5) {
      setMessage('Say what you observed — a sign-off with no account of it is worth nothing.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await signOffShadowingAction(shadowing.id, feedback.trim());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setOpen(false);
      setFeedback('');
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">
            {shadowing.employee.displayName}
            <span className="ml-2 text-xs text-muted">{shadowing.employee.employeeId}</span>
          </span>
          <span className="text-sm text-ink-2">{shadowing.moduleTitle}</span>
          <span className="text-xs text-muted">
            {shadowing.mentor
              ? `Mentor: ${shadowing.mentor.displayName}`
              : 'No mentor assigned yet'}
            {shadowing.scheduledFrom
              ? ` · ${formatTrainingDay(shadowing.scheduledFrom)}`
              : ''}
            {shadowing.scheduledTo ? ` to ${formatTrainingDay(shadowing.scheduledTo)}` : ''}
          </span>
        </div>
        <Badge variant={SHADOWING_STATUS_TONES[shadowing.status]}>
          {SHADOWING_STATUS_LABELS[shadowing.status]}
        </Badge>
      </div>

      {shadowing.checklist && (
        <p className="whitespace-pre-line rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
          <span className="font-medium text-ink">To observe: </span>
          {shadowing.checklist}
        </p>
      )}

      {shadowing.feedback && (
        <p className="whitespace-pre-line text-sm text-ink-2">{shadowing.feedback}</p>
      )}

      {shadowing.signedOffBy && (
        <p className="text-xs text-muted">
          Signed off by {shadowing.signedOffBy.displayName}
          {shadowing.signedOffAt ? ` · ${formatTrainingMoment(shadowing.signedOffAt)}` : ''}
        </p>
      )}

      {isOwn && shadowing.signedOffAt === null && (
        <p className="text-xs text-muted">
          This is your own shadowing — your mentor signs it off.
        </p>
      )}

      {signable && (
        <div className="flex flex-col gap-2">
          {open && (
            <Textarea
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What did you observe?"
              aria-label="Shadowing feedback"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!open ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                Sign off
              </Button>
            ) : (
              <>
                <Button size="sm" disabled={pending} onClick={signOff}>
                  {pending ? 'Saving…' : 'Confirm sign-off'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
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

/**
 * Live-work readiness.
 *
 * ### The gaps are the server's list, not a local calculation
 *
 * `qualificationGaps` arrives computed from the program's requirement flags against
 * the learner's actual progress. This panel renders it and nothing more — it does not
 * count modules, check scores or decide eligibility, because the backend is the only
 * authority on whether somebody may do live customer work.
 *
 * An empty list means eligible. The grant button appears only then, and the API
 * recomputes the gaps again immediately before writing — so a stale page cannot clear
 * anybody.
 */
export function QualificationPanel({
  enrollmentId,
  learnerName,
  gaps,
  qualification,
  canGrant,
  isOwnRecord,
}: {
  enrollmentId: string;
  learnerName: string;
  gaps: QualificationGap[];
  qualification: TrainingQualificationView | null;
  /** HR_TRAINING:APPROVE. The API refuses a self-grant regardless. */
  canGrant: boolean;
  /** Whether the viewer is the learner — nobody clears themselves. */
  isOwnRecord: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [issueCertificate, setIssueCertificate] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');

  const eligible = gaps.length === 0;
  const live = qualification !== null && qualification.isActive;

  function grant(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await qualifyAction(enrollmentId, {
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        issueCertificate,
      });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setNotes('');
      router.refresh();
    });
  }

  function revoke(): void {
    if (!qualification) return;
    if (reason.trim().length < 5) {
      setMessage('Say why this clearance is being withdrawn.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await revokeQualificationAction(qualification.id, reason.trim());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setRevoking(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Live-work readiness
        </h2>
        {live ? (
          <Badge variant="positive">Cleared for live work</Badge>
        ) : eligible ? (
          <Badge variant="accent">Ready to be cleared</Badge>
        ) : (
          <Badge variant="outline">Not ready</Badge>
        )}
      </div>

      {live && qualification && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3">
          <span className="text-sm text-ink">
            Cleared by {qualification.grantedBy.name} ·{' '}
            {formatTrainingMoment(qualification.qualifiedAt)}
          </span>
          {qualification.finalScore && (
            <span className="text-xs text-muted">
              Final score {formatPercent(qualification.finalScore)}
            </span>
          )}
          {qualification.certificateCode && (
            <span className="text-xs text-muted">
              Certificate {qualification.certificateCode}
            </span>
          )}
          {qualification.notes && (
            <p className="text-xs text-ink-2">{qualification.notes}</p>
          )}
        </div>
      )}

      {qualification && !qualification.isActive && (
        <div className="flex flex-col gap-1 rounded-md border border-critical/30 bg-critical-soft p-3">
          <span className="text-sm text-critical">
            Clearance revoked
            {qualification.revokedAt ? ` · ${formatTrainingMoment(qualification.revokedAt)}` : ''}
          </span>
          {qualification.revocationReason && (
            <span className="text-xs text-ink-2">{qualification.revocationReason}</span>
          )}
        </div>
      )}

      {/*
        The gaps, each with the server's own sentence. Listed rather than summarised
        because "not ready" with no reason is useless to the manager who has to act,
        and because the list is what the learner needs to work through.
      */}
      {!live && gaps.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Still outstanding
          </span>
          <ul className="flex flex-col gap-1.5">
            {gaps.map((gap, index) => (
              <li
                key={`${gap.kind}-${gap.moduleId ?? index}`}
                className="flex flex-col gap-0.5 rounded-md border border-line p-2.5"
              >
                <span className="text-xs font-medium text-ink">
                  {QUALIFICATION_GAP_LABELS[gap.kind]}
                </span>
                <span className="text-xs text-ink-2">{gap.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}

      {/*
        The grant control, offered only when the server says eligible and the viewer
        is not the learner. Nobody clears themselves — the API refuses it too, and
        offering a button that always fails would be worse than hiding it.
      */}
      {canGrant && !live && eligible && !isOwnRecord && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <Textarea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={`Note on clearing ${learnerName} for live work (optional)`}
            aria-label="Qualification note"
          />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={issueCertificate}
              onChange={(event) => setIssueCertificate(event.target.checked)}
            />
            Issue a certificate reference
          </label>
          <div>
            <Button size="sm" disabled={pending} onClick={grant}>
              {pending ? 'Saving…' : 'Clear for live work'}
            </Button>
          </div>
        </div>
      )}

      {canGrant && isOwnRecord && eligible && !live && (
        <p className="border-t border-line pt-3 text-xs text-muted">
          You cannot clear yourself for live work — somebody else reviews the evidence.
        </p>
      )}

      {canGrant && live && qualification && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {revoking ? (
            <>
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this clearance being withdrawn?"
                aria-label="Revocation reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={revoke}>
                  {pending ? 'Saving…' : 'Confirm revocation'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRevoking(false)}>
                  Back
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setRevoking(true)}>
                Revoke clearance
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
