'use client';

import { useMemo, useState, useTransition } from 'react';
import { Loader2, Scissors } from 'lucide-react';
import { toast } from 'sonner';
import { addAmount, lineTotal, type SalesOrderDetail } from '@rs/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/format';
import { cancelSalesItemsAction } from '@/app/(app)/sales/actions';

/**
 * Calling off some units, line by line.
 *
 * The distinction this screen exists to make unmistakable:
 *
 *     Ordered 3   Cancelled 1   Remaining 2
 *
 * `quantity` on a line always means what was ORDERED and is never reduced — so
 * the three numbers are shown as three numbers rather than one that quietly
 * shrinks. Somebody reading the order next month can still see what was agreed.
 *
 * The amount shown beside each row is the goods value of the units being called
 * off — quantity × price, the same `lineTotal` the table uses. It is
 * deliberately NOT presented as the refund: tax, charges and what has actually
 * been paid all sit between the two, and the order's own `refundable` figure is
 * what answers that question after the API has recomputed it.
 */
export function CancelItemsDialog({ order }: { order: SalesOrderDetail }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  /** itemId → how many MORE units to cancel, as typed. */
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  // Only lines with something left to call off can be cancelled, so a line
  // already fully cancelled is shown as such rather than offered again.
  const lines = order.items.filter((item) => item.status === 'ACTIVE');

  const chosen = useMemo(
    () =>
      lines
        .map((item) => ({ item, quantity: Number.parseInt(amounts[item.id] ?? '', 10) }))
        .filter((row) => Number.isInteger(row.quantity) && row.quantity > 0),
    [lines, amounts],
  );

  /** A line asked to give up more than it has left. The API refuses it too. */
  const overCancelled = chosen.filter((row) => row.quantity > row.item.remainingQty);

  const goodsValue = useMemo(
    () =>
      chosen
        .filter((row) => row.quantity <= row.item.remainingQty)
        .reduce((running, row) => addAmount(running, lineTotal(row.item.price, row.quantity)), '0.00'),
    [chosen],
  );

  const usable = chosen.length > 0 && overCancelled.length === 0 && reason.trim().length > 0;

  /* Every remaining unit on every line — the API cancels the order itself when
     nothing is left to send, and saying so here avoids a surprise. */
  const cancellingEverything =
    chosen.length === lines.filter((item) => item.remainingQty > 0).length &&
    chosen.every((row) => row.quantity === row.item.remainingQty);

  function setQuantity(itemId: string, value: string): void {
    setAmounts((previous) => ({ ...previous, [itemId]: value }));
  }

  function cancelAllRemaining(): void {
    setAmounts(
      Object.fromEntries(
        lines.filter((item) => item.remainingQty > 0).map((item) => [item.id, String(item.remainingQty)]),
      ),
    );
  }

  function submit(): void {
    if (!usable) return;

    startTransition(async () => {
      const result = await cancelSalesItemsAction(order.id, {
        reason: reason.trim(),
        lines: chosen.map((row) => ({ itemId: row.item.id, quantity: row.quantity })),
      });

      if (!result.ok) {
        /*
          Relayed verbatim. The one worth reading is
          ORDER_LINE_HAS_ALLOCATIONS: purchased stock is committed to that line,
          and only Procurement can release it — Sales must not touch the stock
          ledger, so the message names the step rather than offering a way round
          it.
        */
        toast.error(result.message, {
          description: result.details?.map((d) => d.message).join(' '),
        });
        return;
      }

      toast.success(
        result.data.order.status === 'CANCELLED'
          ? 'Every remaining unit cancelled — the order is now cancelled'
          : 'Units cancelled',
      );
      setOpen(false);
      setAmounts({});
      setReason('');
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={pending}>
        <Scissors className="size-4" />
        Cancel items
      </Button>

      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Cancel individual units</DialogTitle>
            <DialogDescription>
              The ordered quantity is kept as it is. What you cancel is recorded beside it, so the
              order still shows what was agreed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {/* Column headings, so the three quantities are never ambiguous. */}
            <div className="grid grid-cols-[1fr_repeat(3,3.5rem)_6rem] items-center gap-2 px-1 text-[11px] uppercase tracking-wider text-muted">
              <span>Product</span>
              <span className="text-right">Ordered</span>
              <span className="text-right">Cancelled</span>
              <span className="text-right">Left</span>
              <span className="text-right">Cancel</span>
            </div>

            {lines.map((item) => {
              const typed = amounts[item.id] ?? '';
              const asked = Number.parseInt(typed, 10);
              const tooMany = Number.isInteger(asked) && asked > item.remainingQty;
              const spent = item.remainingQty === 0;

              return (
                <div
                  key={item.id}
                  className="grid grid-cols-[1fr_repeat(3,3.5rem)_6rem] items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm text-ink" title={item.productName}>
                    {item.productName}
                  </span>
                  <span className="text-right font-mono text-sm text-ink tabular">
                    {item.quantity}
                  </span>
                  <span
                    className={`text-right font-mono text-sm tabular ${
                      item.cancelledQty > 0 ? 'text-critical' : 'text-muted'
                    }`}
                  >
                    {item.cancelledQty}
                  </span>
                  <span className="text-right font-mono text-sm text-ink-2 tabular">
                    {item.remainingQty}
                  </span>

                  {spent ? (
                    <span className="text-right text-xs text-muted">All cancelled</span>
                  ) : (
                    <Input
                      inputMode="numeric"
                      value={typed}
                      onChange={(event) => setQuantity(item.id, event.target.value)}
                      placeholder="0"
                      aria-label={`Units of ${item.productName} to cancel`}
                      aria-invalid={tooMany}
                      className={`h-9 text-right tabular ${tooMany ? 'border-critical' : ''}`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {lines.some((item) => item.remainingQty > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={cancelAllRemaining} disabled={pending}>
                Cancel everything remaining
              </Button>

              {chosen.length > 0 && overCancelled.length === 0 && (
                <span className="text-xs text-muted">
                  Goods value being called off:{' '}
                  <span className="font-mono text-ink-2 tabular">
                    {formatCurrency(goodsValue, order.money.currency)}
                  </span>
                </span>
              )}
            </div>
          )}

          {overCancelled.length > 0 && (
            <p className="text-xs text-critical">
              {overCancelled
                .map((row) => `${row.item.productName} has only ${row.item.remainingQty} left`)
                .join('; ')}
              .
            </p>
          )}

          {cancellingEverything && (
            <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
              That is every remaining unit, so the order itself will be cancelled. Money already
              paid becomes refundable — it is not sent back automatically.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cancelItemsReason">Why are these being cancelled?</Label>
            <Textarea
              id="cancelItemsReason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Customer reduced the order, item unavailable…"
              rows={2}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Close
            </Button>
            <Button variant="destructive" onClick={submit} disabled={pending || !usable}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Cancel selected units
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
