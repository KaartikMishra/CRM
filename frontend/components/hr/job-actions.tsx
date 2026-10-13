'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { JobRequisitionView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  closeJobAction,
  pauseJobAction,
  publishJobAction,
} from '@/app/(app)/hr/recruitment-actions';

/**
 * The lifecycle controls on a requisition.
 *
 * ### Why publishing and closing need APPROVE, and pausing does not
 *
 * Publishing starts accepting applications from real people; closing ends a hiring
 * effort that candidates are waiting on. Pausing is reversible and visible only
 * internally — it holds the role without telling anybody it is over.
 *
 * `canPublish` and `canEdit` arrive from the page, which asks the server what the viewer
 * holds. The API refuses regardless, so this decides what is worth rendering rather than
 * what is permitted.
 *
 * ### Closing does not reject the applications on the role
 *
 * Deliberately. Closing a requisition is administrative; rejecting somebody is a
 * decision addressed to them and needs its own reason. Mass-rejecting on close would
 * produce a dozen rejections nobody wrote and nobody could explain — so the notice below
 * says the applications stay live and need deciding individually.
 */
export function JobActions({
  job,
  canPublish,
  canEdit,
}: {
  job: JobRequisitionView;
  /** HR_RECRUITMENT:APPROVE — publishing and closing. */
  canPublish: boolean;
  /** HR_RECRUITMENT:EDIT — pausing. */
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');

  const finished = job.status === 'CLOSED' || job.status === 'CANCELLED';
  const publishable = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAUSED'].includes(job.status);

  function run(action: () => Promise<{ ok: boolean; message?: string }>): void {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setMessage(result.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  }

  if (finished) {
    return (
      <Card className="flex flex-col gap-1 p-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          This role is closed
        </span>
        <p className="text-sm text-ink-2">
          Closed roles cannot be reopened or amended. Raise a new requisition instead — the
          applications on this one stay readable.
        </p>
      </Card>
    );
  }

  if (!canPublish && !canEdit) return null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Actions</h2>

      {!closing ? (
        <div className="flex flex-wrap gap-2">
          {canPublish && publishable && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => publishJobAction(job.id))}
            >
              {job.status === 'PAUSED' ? 'Resume and publish' : 'Publish'}
            </Button>
          )}

          {canEdit && job.status === 'PUBLISHED' && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => pauseJobAction(job.id))}
            >
              Pause
            </Button>
          )}

          {canPublish && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setClosing(true)}>
              Close this role
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink">Why is this role being closed?</p>
          <p className="text-xs text-muted">
            Filled, abandoned and re-scoped are different facts, and whoever reads this
            later will want to know which. Applications already on the role stay live — each
            still needs deciding individually.
          </p>
          <Textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-label="Reason for closing"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (reason.trim().length < 5) {
                  setMessage('Say why this role is being closed.');
                  return;
                }
                run(() => closeJobAction(job.id, reason.trim()));
              }}
            >
              {pending ? 'Closing…' : 'Confirm close'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setClosing(false);
                setReason('');
              }}
            >
              Back
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}
