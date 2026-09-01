'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2, Loader2, Pencil, Truck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  compareAmount,
  isValidAmount,
  normaliseAmount,
  type SalesOrderDetail,
} from '@rs/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { formatCurrency, formatDate } from '@/lib/format';
import {
  closeOrderAction,
  dispatchOrderAction,
  recordPaymentAction,
  updateSalesOrderAction,
} from '@/app/(app)/sales/actions';
import { MoneySummary } from './money-summary';

type Props = {
  order: SalesOrderDetail;
  /** All resolved server-side from backend permissions + ownership. */
  canEdit: boolean;
  canDispatch: boolean;
  canClose: boolean;
};

/** The date inputs want yyyy-mm-dd, not an ISO instant. */
const asDateInput = (iso: string): string => iso.slice(0, 10);

/**
 * The action bar.
 *
 * Every button calls the real endpoint and then re-reads the order — no status
 * or balance is changed locally. Buttons are disabled where the backend would
 * refuse anyway, which is a courtesy; the API enforces all of it again.
 */
export function SalesOrderActions({ order, canEdit, canDispatch, canClose }: Props) {
  const [pending, startTransition] = useTransition();
  const [payOpen, setPayOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [confirm, setConfirm] = useState<'dispatch' | 'close' | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const [orderDate, setOrderDate] = useState(asDateInput(order.orderDate));
  const [dispatchBy, setDispatchBy] = useState(asDateInput(order.toBeDispatchedBy));

  const settled = order.money.fullyPaid;

  // Mirrors the backend ceiling so the button can explain itself before the
  // request; the API still decides.
  const amountUsable = isValidAmount(amount.trim()) && compareAmount(amount.trim(), '0.00') > 0;
  const overpaying =
    amountUsable && compareAmount(normaliseAmount(amount.trim()), order.money.pending) > 0;

  function relay(result: Awaited<ReturnType<typeof recordPaymentAction>>, success: string) {
    if (!result.ok) {
      // The backend is authoritative; surface exactly what it said.
      toast.error(result.message, {
        description: result.details?.map((d) => d.message).join(' '),
      });
      return false;
    }
    toast.success(success);
    return true;
  }

  function submitPayment() {
    if (!amountUsable || overpaying) return;
    startTransition(async () => {
      const result = await recordPaymentAction(order.id, normaliseAmount(amount.trim()));
      if (relay(result, 'Payment recorded')) {
        setPayOpen(false);
        setAmount('');
      }
    });
  }

  function runTransition(kind: 'dispatch' | 'close') {
    startTransition(async () => {
      const result =
        kind === 'dispatch'
          ? await dispatchOrderAction(order.id)
          : await closeOrderAction(order.id);
      setConfirm(null);
      relay(result, kind === 'dispatch' ? 'Order dispatched' : 'Order closed');
    });
  }

  function saveEdit() {
    startTransition(async () => {
      const result = await updateSalesOrderAction(order.id, {
        orderDate: new Date(orderDate),
        toBeDispatchedBy: new Date(dispatchBy),
      });
      if (relay(result, 'Dates updated')) setEditOpen(false);
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button variant="outline" onClick={() => setEditOpen(true)} disabled={pending}>
            <Pencil className="size-4" />
            Edit date
          </Button>
        )}

        {canEdit && (
          <Button
            variant="outline"
            onClick={() => setPayOpen(true)}
            disabled={pending || settled}
            title={settled ? 'This order is already paid in full' : undefined}
          >
            <Wallet className="size-4" />
            Record payment
          </Button>
        )}

        {canDispatch && (
          <Button onClick={() => setConfirm('dispatch')} disabled={pending}>
            <Truck className="size-4" />
            Mark dispatched
          </Button>
        )}

        {canClose && (
          <Button
            onClick={() => setConfirm('close')}
            disabled={pending || !settled}
            title={
              settled
                ? undefined
                : `${formatCurrency(order.money.pending, order.money.currency)} is still outstanding — an order can only be closed once it is paid in full.`
            }
          >
            <CheckCircle2 className="size-4" />
            Close order
          </Button>
        )}

        {canClose && !settled && (
          <span className="text-xs text-muted">
            Close unlocks once the {formatCurrency(order.money.pending, order.money.currency)}{' '}
            balance is settled.
          </span>
        )}
      </div>

      {/* ---------------- Record payment ---------------- */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              Partial payments are welcome. The amount is added to what has already been paid, and
              cannot take the order past its total.
            </DialogDescription>
          </DialogHeader>

          <MoneySummary money={order.money} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="paymentAmount">Amount received</Label>
            <Input
              id="paymentAmount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={order.money.pending}
              className="tabular"
              autoFocus
            />
            {overpaying ? (
              <p className="text-xs text-critical">
                That is more than the {formatCurrency(order.money.pending, order.money.currency)}{' '}
                outstanding.
              </p>
            ) : (
              <p className="text-xs text-muted">
                {formatCurrency(order.money.pending, order.money.currency)} outstanding.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitPayment} disabled={pending || !amountUsable || overpaying}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Record payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Dispatch / close confirmation ---------------- */}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'dispatch' ? 'Mark this order dispatched?' : 'Close this order?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'dispatch'
                ? `The dispatch is timed against the ${formatDate(order.toBeDispatchedBy)} deadline, and the on-time verdict is recorded once and never recalculated.`
                : 'Closing records who closed it and when. The order becomes read-only, and there is no reopen.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {confirm === 'close' && (
            <MoneySummary money={order.money} />
          )}

          {/* The button that opens this is already disabled while a balance
              stands; this is the second guard, and the API is the third. */}
          {confirm === 'close' && !settled && (
            <p className="rounded-md border border-critical/30 bg-critical-soft px-3 py-2.5 text-sm text-critical">
              {formatCurrency(order.money.pending, order.money.currency)} is still outstanding. An
              order can only be closed once it is paid in full.
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirm) runTransition(confirm);
              }}
              disabled={pending || (confirm === 'close' && !settled)}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {confirm === 'dispatch' ? 'Mark dispatched' : 'Close order'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---------------- Edit ---------------- */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit dates</DialogTitle>
            <DialogDescription>
              Only the order date and the dispatch deadline can be changed here. The order ID and
              customer are fixed once recorded, and products are changed through a request in the
              list below.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editOrderDate">Order date</Label>
                <Input
                  id="editOrderDate"
                  type="date"
                  value={orderDate}
                  onChange={(e) => setOrderDate(e.target.value)}
                  className="tabular"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editDispatchBy">To be dispatched by</Label>
                <Input
                  id="editDispatchBy"
                  type="date"
                  value={dispatchBy}
                  onChange={(e) => setDispatchBy(e.target.value)}
                  className="tabular"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save dates
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
