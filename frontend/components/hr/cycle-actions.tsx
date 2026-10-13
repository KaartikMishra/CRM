'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ReviewCycleView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  activateCycleAction,
  archiveCycleAction,
  closeCycleAction,
} from '@/app/(app)/hr/performance-actions';

/**
 * Opening, closing and archiving a cycle.
 *
 * Each is a named act rather than a status field, so each carries a timestamp and a
 * record of who did it — a cycle that became live with nothing saying how is a cycle
 * nobody can audit.
 *
 * All three need HR_PERFORMANCE:APPROVE: opening makes every employee in scope owe a
 * self-assessment with a deadline, and closing stops submissions. Both commit the
 * organisation, which is the line APPROVE marks everywhere else in HR.
 *
 * The API decides regardless of what renders here.
 */
export function CycleLifecycleActions({
  cycle,
  canApprove,
}: {
  cycle: ReviewCycleView;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');

  if (!canApprove) return null;

  function activate(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await activateCycleAction(cycle.id);
      if (!res.ok) {
        // The API's message names the real obstacle — a cycle with no competencies,
        // say — which is more useful than anything invented here.
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  function close(): void {
    if (reason.trim().length < 5) {
      setMessage('Say why this cycle is being closed.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const res = await closeCycleAction(cycle.id, reason.trim());
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      setClosing(false);
      setReason('');
      router.refresh();
    });
  }

  function archive(): void {
    setMessage(null);
    startTransition(async () => {
      const res = await archiveCycleAction(cycle.id);
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  const hasCompetencies = cycle.competencies.length > 0;

  return (
    <Card className="flex flex-col gap-2 p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Cycle controls
      </h2>

      {cycle.status === 'DRAFT' && (
        <>
          <p className="text-xs text-muted">
            A draft cycle has no reviews and nobody can see it. Opening it makes
            everybody in scope owe a self-assessment.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending || !hasCompetencies} onClick={activate}>
              {pending ? 'Opening…' : 'Open this cycle'}
            </Button>
          </div>
          {/*
            Stated before the attempt rather than after the 400. The API refuses it
            too — but discovering the obstacle by pressing the button is worse than
            being told.
          */}
          {!hasCompetencies && (
            <p className="text-xs text-critical">
              Add at least one competency first — otherwise this cycle&apos;s reviews
              cannot be rated.
            </p>
          )}
        </>
      )}

      {cycle.status === 'ACTIVE' && (
        <div className="flex flex-col gap-2">
          {closing ? (
            <>
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this cycle being closed?"
                aria-label="Closure reason"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={close}>
                  {pending ? 'Closing…' : 'Confirm'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
                Close this cycle
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">
            Closing stops new submissions. Everything stays readable.
          </p>
        </div>
      )}

      {cycle.status === 'CLOSED' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={archive}>
            {pending ? 'Archiving…' : 'Archive this cycle'}
          </Button>
        </div>
      )}

      {cycle.status === 'ARCHIVED' && (
        <p className="text-xs text-muted">
          Archived. Kept as history and no longer editable.
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      )}
    </Card>
  );
}
