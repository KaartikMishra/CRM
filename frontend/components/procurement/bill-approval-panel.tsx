'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PurchaseBillDetail } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import { reviewPurchaseBillAction } from '@/app/(app)/procurement/actions';

/**
 * Signing a recorded bill off, and saying plainly what is blocked until then.
 *
 * Shown to everyone, not only to approvers, because the state matters to the
 * person who recorded the bill too — they need to know their stock cannot be
 * allocated yet, and why. Only the buttons are gated, and that gating is a
 * convenience: the API refuses approve and reject without PROCUREMENT ASSIGN
 * and refuses self-approval regardless, so this component hides nothing that
 * would otherwise be reachable.
 */
export function BillApprovalPanel({
  bill,
  canReview,
}: {
  bill: PurchaseBillDetail;
  canReview: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(decision: 'approve' | 'reject'): void {
    setError(null);
    startTransition(async () => {
      const result = await reviewPurchaseBillAction(
        bill.id,
        decision,
        note.trim() ? { note: note.trim() } : {},
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Bill approved.' : 'Bill rejected.');
      setNote('');
      router.refresh();
    });
  }

  if (bill.approvalStatus === 'APPROVED') {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1 p-4 text-sm text-muted sm:p-5">
          <Check className="size-4 shrink-0 text-positive" />
          <span className="text-ink">Approved</span>
          {/*
            Bills recorded before approval was required carry no reviewer — the
            migration approved them without inventing a decision nobody made —
            so the attribution is rendered only when there is one.
          */}
          {bill.reviewedBy && bill.reviewedAt && (
            <span>
              by {bill.reviewedBy.name} · {formatDateTime(bill.reviewedAt)}
            </span>
          )}
          {bill.reviewNote && <span className="w-full text-ink-2">“{bill.reviewNote}”</span>}
        </CardContent>
      </Card>
    );
  }

  const rejected = bill.approvalStatus === 'REJECTED';

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-start gap-2">
          <ShieldAlert
            className={`mt-0.5 size-4 shrink-0 ${rejected ? 'text-critical' : 'text-warning'}`}
          />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-ink">
              {rejected ? 'This bill was rejected' : 'Waiting for approval'}
            </p>
            <p className="mt-0.5 text-muted">
              {rejected
                ? 'Its stock cannot be allocated to any order.'
                : 'The bill is recorded and can be received against, but its stock cannot be allocated to an order until an administrator approves it.'}
            </p>
            {rejected && bill.reviewedBy && bill.reviewedAt && (
              <p className="mt-1 text-xs text-muted">
                Rejected by {bill.reviewedBy.name} · {formatDateTime(bill.reviewedAt)}
              </p>
            )}
            {rejected && bill.reviewNote && (
              <p className="mt-1 text-xs text-ink-2">“{bill.reviewNote}”</p>
            )}
          </div>
        </div>

        {error && <ErrorMessage message={error} />}

        {/*
          A decided bill is not re-decidable — the API refuses a second decision
          — so no buttons are offered once it has been rejected.
        */}
        {canReview && !rejected && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={pending}
              placeholder="Note (optional on approval, expected on rejection)"
              className="flex-1"
            />
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => decide('reject')}
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
                Reject
              </Button>
              <Button type="button" size="sm" disabled={pending} onClick={() => decide('approve')}>
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Approve
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
