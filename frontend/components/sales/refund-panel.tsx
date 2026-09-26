'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  compareAmount,
  isValidAmount,
  normaliseAmount,
  type SalesOrderDetail,
  type SalesRefundView,
} from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency, formatDateTime, label } from '@/lib/format';
import {
  createRefundAction,
  rejectRefundAction,
  settleRefundAction,
} from '@/app/(app)/sales/actions';

/**
 * Money owed back, and whether it has actually gone.
 *
 * The three states are kept visibly apart because conflating them is how a
 * business tells a customer they have been paid when they have not:
 *
 *   PENDING    agreed. The customer is still owed this.
 *   COMPLETED  sent, with the reference it went out with.
 *   REJECTED   decided against. The amount is refundable again.
 *
 * Every figure here — refundable, promised, returned — comes from the order's
 * own money view. Nothing is summed in this file: the API derives them from the
 * remaining quantities, the charges and the refunds already recorded, and a
 * second sum on the screen could only ever disagree with the record.
 *
 * The card follows the item and charge change-request pattern in this module:
 * the same status badge, the same footer attribution, the same two buttons on
 * the right of a row that still needs a decision.
 */

const STATUS_VARIANT = {
  PENDING: 'warning',
  COMPLETED: 'positive',
  REJECTED: 'neutral',
} as const;

export function RefundPanel({
  order,
  canRefund,
}: {
  order: SalesOrderDetail;
  /** Resolved server-side from SALES EDIT and the order's state. */
  canRefund: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const [settling, setSettling] = useState<SalesRefundView | null>(null);
  const [reference, setReference] = useState('');

  const { currency, refundable, refunded, refundPending } = order.money;
  const hasRefunds = order.refunds.length > 0;
  const anythingRefundable = compareAmount(refundable, '0.00') > 0;

  /* Mirrors the API ceiling so the form can explain itself before the request.
     The API checks it again, against the same figure. */
  const typed = amount.trim();
  const amountUsable = isValidAmount(typed) && compareAmount(typed, '0.00') > 0;
  const overRefunding = amountUsable && compareAmount(normaliseAmount(typed), refundable) > 0;
  const createUsable = amountUsable && !overRefunding && reason.trim().length > 0;

  function relay(result: { ok: boolean; message?: string }, success: string): boolean {
    if (!result.ok) {
      toast.error(result.message ?? 'That did not work.');
      return false;
    }
    toast.success(success);
    router.refresh();
    return true;
  }

  function submitCreate(): void {
    if (!createUsable) return;
    startTransition(async () => {
      const result = await createRefundAction(order.id, {
        amount: normaliseAmount(typed),
        reason: reason.trim(),
      });
      if (relay(result, 'Refund recorded as owed')) {
        setCreateOpen(false);
        setAmount('');
        setReason('');
      }
    });
  }

  function submitSettle(): void {
    if (!settling || reference.trim().length === 0) return;
    setBusyId(settling.id);
    startTransition(async () => {
      const result = await settleRefundAction(order.id, settling.id, {
        reference: reference.trim(),
      });
      setBusyId(null);
      if (relay(result, 'Refund marked as sent')) {
        setSettling(null);
        setReference('');
      }
    });
  }

  function submitReject(refund: SalesRefundView): void {
    setBusyId(refund.id);
    startTransition(async () => {
      const result = await rejectRefundAction(order.id, refund.id);
      setBusyId(null);
      relay(result, 'Refund rejected — the amount is refundable again');
    });
  }

  // Nothing owed and nothing ever recorded: say nothing rather than show an
  // empty section on the great majority of orders.
  if (!hasRefunds && !anythingRefundable) return null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Refunds</h3>
        {canRefund && anythingRefundable && (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)} disabled={pending}>
            <RotateCcw className="size-4" />
            Record a refund
          </Button>
        )}
      </div>

      {/*
        The three figures, kept apart. "Refundable" is what nobody has promised
        yet; "owed" is agreed and unsent; "returned" is gone, with a reference
        behind each one.
      */}
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-line bg-surface-2 p-3 text-center">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted">Refundable</dt>
          <dd
            className={`mt-1 whitespace-nowrap font-mono text-sm tabular ${
              anythingRefundable ? 'text-warning' : 'text-muted'
            }`}
          >
            {formatCurrency(refundable, currency)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted">Owed</dt>
          <dd className="mt-1 whitespace-nowrap font-mono text-sm text-ink tabular">
            {formatCurrency(refundPending, currency)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted">Returned</dt>
          <dd className="mt-1 whitespace-nowrap font-mono text-sm text-positive tabular">
            {formatCurrency(refunded, currency)}
          </dd>
        </div>
      </dl>

      {compareAmount(refundPending, '0.00') > 0 && (
        <p className="mt-2 text-xs text-warning">
          {formatCurrency(refundPending, currency)} is agreed and has not been sent yet.
        </p>
      )}

      {/* ---------------- History ---------------- */}
      {hasRefunds && (
        <ul className="mt-3 flex flex-col gap-2">
          {order.refunds.map((refund) => {
            const awaiting = refund.status === 'PENDING';
            const busy = busyId === refund.id;

            return (
              <li
                key={refund.id}
                className={`rounded-md border p-3 ${
                  awaiting ? 'border-warning/40 bg-warning/5' : 'border-line bg-surface-2'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[refund.status]}>{label(refund.status)}</Badge>
                      <span className="font-mono text-sm text-ink tabular">
                        {formatCurrency(refund.amount, currency)}
                      </span>
                    </div>

                    <p className="mt-1.5 text-sm text-ink-2">{refund.reason}</p>

                    {refund.reference && (
                      <p className="mt-1 text-xs text-muted">
                        Reference{' '}
                        <span className="font-mono text-ink-2">{refund.reference}</span>
                      </p>
                    )}

                    <p className="mt-1.5 text-xs text-muted tabular">
                      Recorded by {refund.requestedBy.name} · {formatDateTime(refund.requestedAt)}
                      {refund.settledBy && refund.settledAt && (
                        <>
                          {' · '}
                          {refund.status === 'COMPLETED' ? 'Sent' : 'Rejected'} by{' '}
                          {refund.settledBy.name} · {formatDateTime(refund.settledAt)}
                        </>
                      )}
                    </p>

                    {refund.note && (
                      <p className="mt-1.5 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2">
                        {refund.note}
                      </p>
                    )}

                    {awaiting && (
                      <p className="mt-2 text-xs text-muted">
                        Agreed, not sent. Mark it sent once the money has actually gone.
                      </p>
                    )}
                  </div>

                  {canRefund && awaiting && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setSettling(refund);
                          setReference('');
                        }}
                      >
                        {busy && pending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Check className="size-4" />
                        )}
                        Mark sent
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => submitReject(refund)}
                      >
                        <X className="size-4" />
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------------- Record a refund ---------------- */}
      <Dialog open={createOpen} onOpenChange={(next) => !pending && setCreateOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a refund</DialogTitle>
            <DialogDescription>
              This records that the customer is owed the money. It does not send anything — mark it
              sent once it has actually gone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refundAmount">Amount</Label>
            <Input
              id="refundAmount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={refundable}
              className="tabular"
              autoFocus
            />
            {overRefunding ? (
              <p className="text-xs text-critical">
                Only {formatCurrency(refundable, currency)} is refundable, counting refunds already
                recorded.
              </p>
            ) : (
              <p className="text-xs text-muted">
                {formatCurrency(refundable, currency)} refundable.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refundReason">Why is it being returned?</Label>
            <Textarea
              id="refundReason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Order cancelled, units returned…"
              rows={2}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitCreate} disabled={pending || !createUsable}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Record refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Mark sent ---------------- */}
      <Dialog open={settling !== null} onOpenChange={(next) => !pending && !next && setSettling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this refund as sent</DialogTitle>
            <DialogDescription>
              {settling && formatCurrency(settling.amount, currency)} going back to the customer.
              The reference is what makes this checkable against a statement later, so it is
              required.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refundReference">Reference</Label>
            <Input
              id="refundReference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="UTR, cheque number, cash receipt…"
              autoFocus
            />
            <p className="text-xs text-muted">
              However the money actually went back.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettling(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitSettle} disabled={pending || reference.trim().length === 0}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Mark sent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
