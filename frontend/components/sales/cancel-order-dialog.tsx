'use client';

import { useState, useTransition } from 'react';
import { Ban, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SalesOrderDetail } from '@rs/shared';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';
import { cancelOrderAction } from '@/app/(app)/sales/actions';

/**
 * Calling off a whole order.
 *
 * Two things this has to say plainly, because getting either wrong costs
 * somebody money:
 *
 *   NOTHING IS DELETED. The order, its lines and its payments stay exactly as
 *   they are. Cancelling changes what the order *is*, not what it records.
 *
 *   CANCELLING IS NOT REFUNDING. Money already paid becomes refundable, and
 *   stays owed until somebody records a refund and then settles it. A screen
 *   that let a person believe the customer had been paid back would be worse
 *   than no screen at all — so the amount is named here, before the button.
 *
 * An AlertDialog rather than a Dialog: this is a decision with a consequence,
 * and it is the primitive the dispatch and close confirmations already use.
 */
export function CancelOrderDialog({ order }: { order: SalesOrderDetail }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  // The API requires it, and so does a database constraint — a cancellation
  // with no stated reason is unauditable six months later.
  const usable = reason.trim().length > 0;

  /* What the customer will be owed. Straight from the API: the order already
     derived it, and a second sum here could only ever disagree. */
  const paid = order.money.paid;
  const willBeOwed = order.money.paid !== '0.00';

  function submit(): void {
    if (!usable) return;
    startTransition(async () => {
      const result = await cancelOrderAction(order.id, reason.trim());

      if (!result.ok) {
        // Surface exactly what the backend said — including the allocation
        // refusal, which names the step somebody has to take in Procurement.
        toast.error(result.message, {
          description: result.details?.map((d) => d.message).join(' '),
        });
        return;
      }

      toast.success('Order cancelled');
      setOpen(false);
      setReason('');
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={pending}>
        <Ban className="size-4" />
        Cancel order
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Every remaining unit is called off. The order, its products and its payment history
              are kept exactly as they are — it stops being a live order rather than disappearing.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/*
            The financial consequence, named rather than implied. This is the
            sentence that stops somebody assuming the customer has their money
            back.
          */}
          {willBeOwed && (
            <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm">
              <p className="font-medium text-warning">
                {formatCurrency(paid, order.money.currency)} already paid becomes refundable.
              </p>
              <p className="mt-1 text-ink-2">
                Cancelling does not send any money back. Record a refund afterwards, and mark it
                sent once it has actually gone.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cancelReason">Why is it being cancelled?</Label>
            <Textarea
              id="cancelReason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Customer changed their mind, duplicate order, out of stock…"
              rows={3}
              maxLength={500}
              autoFocus
            />
            <p className="text-xs text-muted">
              Recorded against the order with your name and the time.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep the order</AlertDialogCancel>
            <Button variant="destructive" onClick={submit} disabled={pending || !usable}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Cancel order
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
