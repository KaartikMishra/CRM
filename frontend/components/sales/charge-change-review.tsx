'use client';

import { useTransition, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SalesChargeChangeRequestView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDateTime, label } from '@/lib/format';
import {
  approveChargeChangeAction,
  rejectChargeChangeAction,
} from '@/app/(app)/sales/actions';

/**
 * A proposed change to an order's charges, and the decision on it.
 *
 * Deliberately the same card as the item change requests in `sales-item-list`:
 * the same status badge, the same current → proposed pair, the same footer, the
 * same two buttons on the right. It is the same workflow, so it should not look
 * like a different one.
 *
 * The banner this replaces showed the request to everybody and offered nobody
 * anything to do about it — an approver opening the order saw exactly what the
 * requester saw. `canReview` is resolved server-side from SALES ASSIGN, and the
 * API checks it again along with self-review, so hiding the buttons is a
 * courtesy and never the control.
 */

const STATUS_VARIANT = {
  PENDING: 'warning',
  APPROVED: 'positive',
  REJECTED: 'neutral',
} as const;

export function ChargeChangeReview({
  orderId,
  requests,
  currency,
  canReview,
  currentUserId,
}: {
  orderId: string;
  requests: SalesChargeChangeRequestView[];
  currency: string;
  /** Resolved from SALES ASSIGN on the server; the API enforces it again. */
  canReview: boolean;
  /** So somebody is never offered a decision on their own request. */
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (requests.length === 0) return null;

  // Pending first, because those are the ones needing something done.
  const open = requests.filter((r) => r.status === 'PENDING');
  const decided = requests.filter((r) => r.status !== 'PENDING');

  function decide(request: SalesChargeChangeRequestView, approve: boolean): void {
    setBusyId(request.id);
    startTransition(async () => {
      const result = approve
        ? await approveChargeChangeAction(orderId, request.id)
        : await rejectChargeChangeAction(orderId, request.id);
      setBusyId(null);

      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      toast.success(
        approve ? 'Charges approved and applied' : 'Charge change rejected',
      );
      router.refresh();
    });
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      {[...open, ...decided].map((request) => {
        const awaiting = request.status === 'PENDING';
        const isOwnRequest = request.requestedBy.id === currentUserId;
        // Nobody decides their own request, whatever they hold.
        const mayDecide = canReview && awaiting && !isOwnRequest;
        const busy = busyId === request.id;

        return (
          <div
            key={request.id}
            className={`rounded-md border p-3 ${
              awaiting ? 'border-warning/40 bg-warning/5' : 'border-line bg-surface-2'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_VARIANT[request.status]}>{label(request.status)}</Badge>
                  <span className="text-sm font-medium text-ink">Charge change</span>
                </div>

                {/* CURRENT -> PROPOSED, so the difference reads at a glance. */}
                <div className="mt-2.5 grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-line bg-surface px-3 py-2">
                    <span className="text-[11px] uppercase tracking-wider text-muted">
                      Currently charged
                    </span>
                    <p className="mt-0.5 font-mono text-ink tabular">
                      {formatCurrency(request.currentTotal, currency)}
                    </p>
                  </div>

                  <div className="rounded-md border border-line bg-surface px-3 py-2">
                    <span className="text-[11px] uppercase tracking-wider text-muted">
                      Proposed
                    </span>
                    <p className="mt-0.5 font-mono text-ink tabular">
                      {formatCurrency(request.proposedTotal, currency)}
                    </p>
                  </div>
                </div>

                <p className="mt-2 text-xs text-muted tabular">
                  Requested by {request.requestedBy.name} · {formatDateTime(request.requestedAt)}
                  {request.reviewedBy && request.reviewedAt && (
                    <>
                      {' · '}
                      {request.status === 'APPROVED' ? 'Approved' : 'Rejected'} by{' '}
                      {request.reviewedBy.name} · {formatDateTime(request.reviewedAt)}
                    </>
                  )}
                </p>

                {request.reviewNote && (
                  <p className="mt-1.5 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2">
                    {request.reviewNote}
                  </p>
                )}

                {awaiting && (
                  <p className="mt-2 text-xs text-muted">
                    The order charges what is shown above until this is approved.
                    {isOwnRequest && ' Someone else has to decide it.'}
                  </p>
                )}
              </div>

              {mayDecide && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => decide(request, false)}
                  >
                    {busy && pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                    Reject
                  </Button>
                  <Button size="sm" disabled={pending} onClick={() => decide(request, true)}>
                    {busy && pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                    Approve
                  </Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
