'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { APPLICATION_STAGES, type ApplicationStage, type ApplicationView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  moveApplicationStageAction,
  rejectApplicationAction,
  withdrawApplicationAction,
} from '@/app/(app)/hr/recruitment-actions';
import {
  APPLICATION_STAGE_LABELS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  formatMoment,
  isCommittingStage,
} from './recruitment-labels';

/**
 * The ATS pipeline, and the controls for moving through it.
 *
 * ### There is no drag-and-drop here, deliberately
 *
 * A board you drag cards across implies every column is reachable from every other.
 * This pipeline has three points — SELECTED, OFFER_ACCEPTED, JOINED — where a human
 * commits the business to something, and those are precisely the moves that must not
 * happen by a slip of the mouse. So the move is an explicit choice from a list the
 * server supplied, with a confirmation on the committing ones.
 *
 * ### The list of moves comes from the server
 *
 * `application.availableStages` is computed by the backend's own transition map. This
 * component holds **no** copy of that map: no "is this forward", no skip rules, no
 * ordering logic beyond laying the stages out in their declared order. A second copy
 * would eventually disagree with the first, and the disagreement would show up as
 * either a button that silently fails or — worse — a commit point quietly skipped.
 *
 * When the server refuses anyway (somebody else moved it first), the error is shown
 * verbatim rather than swallowed, because "reload and try again" is the only honest
 * answer to a concurrent edit.
 */
export function AtsPipeline({
  application,
  canMove,
  canDecide,
}: {
  application: ApplicationView;
  /** Whether the viewer may move this application at all. The API decides again. */
  canMove: boolean;
  /** Whether they hold APPROVE — needed for selection and rejection. */
  canDecide: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [target, setTarget] = useState<ApplicationStage | null>(null);
  const [reason, setReason] = useState('');
  const [ending, setEnding] = useState<'reject' | 'withdraw' | null>(null);

  const currentIndex = APPLICATION_STAGES.indexOf(application.currentStage);
  const live = application.status === 'ACTIVE';

  function move(toStage: ApplicationStage): void {
    setMessage(null);
    startTransition(async () => {
      const result = await moveApplicationStageAction(
        application.id,
        toStage,
        reason.trim() || undefined,
      );
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setTarget(null);
      setReason('');
      router.refresh();
    });
  }

  function end(kind: 'reject' | 'withdraw'): void {
    if (reason.trim().length < 5) {
      setMessage('Say why — a decision with no reason cannot be explained later.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const result =
        kind === 'reject'
          ? await rejectApplicationAction(application.id, reason.trim())
          : await withdrawApplicationAction(application.id, reason.trim());
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setEnding(null);
      setReason('');
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Pipeline
        </h2>
        <Badge variant={APPLICATION_STATUS_TONES[application.status]}>
          {APPLICATION_STATUS_LABELS[application.status]}
        </Badge>
      </div>

      {/*
        The whole pipeline, with everything up to the current stage marked as passed.
        Showing the stages still ahead — rather than only the ones reached — is what
        makes the position meaningful: "Shortlisted" means little without seeing that
        four rounds and an offer lie between it and joining.
      */}
      <ol className="flex flex-wrap gap-1.5">
        {APPLICATION_STAGES.map((stage, index) => {
          const passed = index < currentIndex;
          const here = index === currentIndex;
          return (
            <li key={stage}>
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
                {APPLICATION_STAGE_LABELS[stage]}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Where it may go next — the server's list, not ours. */}
      {canMove && live && application.availableStages.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Move to
          </span>

          <div className="flex flex-wrap gap-2">
            {application.availableStages.map((stage) => (
              <Button
                key={stage}
                size="sm"
                variant={isCommittingStage(stage) ? 'default' : 'outline'}
                disabled={pending}
                onClick={() => {
                  /*
                    A committing stage asks first; an assessment move does not. The
                    difference is that one of them binds the business — and a
                    confirmation on every step would train people to click through it,
                    costing the three that matter their whole protection.
                  */
                  if (isCommittingStage(stage)) setTarget(stage);
                  else move(stage);
                }}
              >
                {APPLICATION_STAGE_LABELS[stage]}
              </Button>
            ))}
          </div>

          {target && (
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
              <p className="text-sm text-ink">
                Move this application to{' '}
                <strong>{APPLICATION_STAGE_LABELS[target]}</strong>?
              </p>
              <p className="text-xs text-muted">
                {target === 'SELECTED'
                  ? 'Selecting records a decision to hire this candidate, attributed to you.'
                  : target === 'OFFER_ACCEPTED'
                    ? 'This records that the candidate accepted. There is no route back from here.'
                    : 'This records that the candidate has joined.'}
              </p>
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Note (optional)"
                aria-label="Reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={pending} onClick={() => move(target)}>
                  {pending ? 'Saving…' : 'Confirm'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setTarget(null);
                    setReason('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/*
        Ending an application. Both need a reason, required here, by Zod and by a
        CHECK — "we decided not to proceed" with nothing recorded is the single
        commonest complaint about any hiring process, and it is unanswerable months
        later.

        Rejection needs APPROVE; a withdrawal does not, because the business is not
        deciding anything — it is writing down what the candidate told it.
      */}
      {canMove && live && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {ending === null ? (
            <div className="flex flex-wrap gap-2">
              {canDecide && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setEnding('reject')}
                >
                  Reject
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setEnding('withdraw')}
              >
                Candidate withdrew
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  ending === 'reject'
                    ? 'Why is this application being rejected?'
                    : 'What did the candidate say?'
                }
                aria-label="Reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => end(ending)}
                >
                  {pending ? 'Saving…' : ending === 'reject' ? 'Confirm rejection' : 'Record withdrawal'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEnding(null);
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

      {!live && application.rejectionReason && (
        <p className="border-t border-line pt-3 text-xs text-ink-2">
          <span className="font-medium">
            {application.status === 'WITHDRAWN' ? 'Withdrawn' : 'Not proceeding'}:
          </span>{' '}
          {application.rejectionReason}
        </p>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}

/**
 * The stage history — every move, append-only.
 *
 * This is what makes the pipeline auditable: the application's current stage is one
 * number, and this is the record of how it got there and who moved it. Rows are never
 * updated, so the timeline is what happened rather than what somebody later decided
 * it should say.
 */
export function StageHistory({ application }: { application: ApplicationView }) {
  if (application.stageHistory.length === 0) {
    return <p className="text-sm text-muted">No stage changes recorded yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {application.stageHistory.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 rounded-md border border-line p-2.5">
          <span className="text-sm text-ink">
            {entry.fromStage
              ? `${APPLICATION_STAGE_LABELS[entry.fromStage]} → ${APPLICATION_STAGE_LABELS[entry.toStage]}`
              : APPLICATION_STAGE_LABELS[entry.toStage]}
          </span>
          <span className="text-xs text-muted">
            {formatMoment(entry.createdAt)}
            {entry.performedBy ? ` · ${entry.performedBy.name}` : ''}
          </span>
          {entry.reason && <span className="text-xs text-ink-2">{entry.reason}</span>}
        </li>
      ))}
    </ol>
  );
}
