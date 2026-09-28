'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorMessage } from '@/components/common/error-message';
import { ContentRegion, ContentScrollArea } from '@/components/common/content-page';
import {
  reviewProcurementDelayAction,
  reviewPurchaseDelayAction,
} from '@/app/(app)/procurement/actions';
import { formatDateTime } from '@/lib/format';
import type {
  ProcurementDelayQueueRow,
  PurchaseDelayQueueRow,
} from '@/lib/procurement-api';

/**
 * The two approval queues, kept visibly apart.
 *
 * They look alike and are not: the first is a purchase person explaining one
 * line to procurement, the second is procurement explaining a whole order to an
 * administrator. Rendering them as one list would put two different decisions,
 * made by two different people, under one heading.
 *
 * Each is shown only to somebody who can actually decide it. That is a
 * convenience, not the control — the API refuses both without the right
 * capability, and refuses them again inside the service.
 */

/** Rejection stays available even when approval is not: see the note below. */
function DecisionRow({
  reason,
  requestedBy,
  requestedAt,
  context,
  onDecide,
}: {
  reason: string;
  requestedBy: string;
  requestedAt: string;
  context: string;
  onDecide: (decision: 'approve' | 'reject', note: string) => void;
}) {
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  return (
    <li className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-xs text-muted">{context}</p>
      <p className="mt-1 text-sm text-ink">{reason}</p>
      <p className="mt-1 text-xs text-muted">
        {requestedBy} · {formatDateTime(requestedAt)}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional on approval, expected on rejection)"
          maxLength={1000}
          className="min-w-52 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => onDecide('reject', note))}
        >
          Reject
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => onDecide('approve', note))}
        >
          Approve
        </Button>
      </div>
    </li>
  );
}

/** Item-level reasons awaiting a procurement decision. PROCUREMENT ASSIGN. */
export function PurchaseDelayQueue({ reasons }: { reasons: PurchaseDelayQueueRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  if (reasons.length === 0) return null;

  function decide(id: string, decision: 'approve' | 'reject', note: string): void {
    setError(null);
    void (async () => {
      const result = await reviewPurchaseDelayAction(
        id,
        decision,
        note.trim() ? { note: note.trim() } : {},
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Reason approved.' : 'Reason rejected.');
      router.refresh();
    })();
  }

  return (
    <ContentRegion fill={false}>
      <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wider text-muted">
        Purchase delays awaiting your approval
      </h2>
      <Card>
        <CardContent className="p-4">
          {error && <ErrorMessage message={error} />}
          <ContentScrollArea>
            <ul className="flex flex-col gap-2">
              {reasons.map((row) => (
                <DecisionRow
                  key={row.id}
                  reason={row.reason}
                  requestedBy={row.requestedBy.name}
                  requestedAt={row.requestedAt}
                  context={`${row.orderNumber} · ${row.customerName} · ${row.productName}`}
                  onDecide={(decision, note) => decide(row.id, decision, note)}
                />
              ))}
            </ul>
          </ContentScrollArea>
        </CardContent>
      </Card>
    </ContentRegion>
  );
}

/**
 * Order-level reasons awaiting an administrator.
 *
 * Deciding one records that the explanation was accepted. It does not change when
 * the order was covered, and the order goes on reading "covered late".
 */
export function ProcurementDelayQueue({ reasons }: { reasons: ProcurementDelayQueueRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  if (reasons.length === 0) return null;

  function decide(id: string, decision: 'approve' | 'reject', note: string): void {
    setError(null);
    void (async () => {
      const result = await reviewProcurementDelayAction(
        id,
        decision,
        note.trim() ? { note: note.trim() } : {},
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Reason approved.' : 'Reason rejected.');
      router.refresh();
    })();
  }

  return (
    <ContentRegion fill={false}>
      <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wider text-muted">
        Procurement delays awaiting your decision
      </h2>
      <Card>
        <CardContent className="p-4">
          <p className="mb-3 text-xs text-muted">
            These orders were covered after their deadline. Approving an explanation accepts it — the
            order still reads “covered late”.
          </p>
          {error && <ErrorMessage message={error} />}
          <ContentScrollArea>
            <ul className="flex flex-col gap-2">
              {reasons.map((row) => (
                <DecisionRow
                  key={row.id}
                  reason={row.reason}
                  requestedBy={row.requestedBy.name}
                  requestedAt={row.requestedAt}
                  context={`${row.orderNumber} · ${row.customerName}`}
                  onDecide={(decision, note) => decide(row.id, decision, note)}
                />
              ))}
            </ul>
          </ContentScrollArea>
        </CardContent>
      </Card>
    </ContentRegion>
  );
}
