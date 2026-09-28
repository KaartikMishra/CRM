'use client';

import { useEffect, useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import type { ClockItemView, ProcurementClockDetail } from '@rs/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { ClockStateBadge, DelayReasonBadge, FulfillmentBadge } from './procurement-badges';
import { completionLine } from './clock-board';
import {
  clockDetailAction,
  reviewProcurementDelayAction,
  submitProcurementDelayAction,
  submitPurchaseDelayAction,
} from '@/app/(app)/procurement/actions';
import { formatDate, formatDateTime } from '@/lib/format';
import { toast } from 'sonner';

/**
 * One order's clock, line by line.
 *
 * The whole point of opening this is the per-line breakdown: an order is not
 * fulfilled because some of it was procured, and the only way to see which parts
 * are still owed is to look at them. Four quantities per line, and they are four
 * different facts — ordered, cancelled, required, and what is still short.
 *
 * Every number comes from the API. There is no arithmetic in this file.
 */
export function ClockDetailDialog({
  orderId,
  open,
  onOpenChange,
  canEdit,
  canReview,
  isAdmin,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  canReview: boolean;
  isAdmin: boolean;
}) {
  const [order, setOrder] = useState<ProcurementClockDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (!open || !orderId) return;
    setOrder(null);
    setError(null);
    startLoading(async () => {
      const result = await clockDetailAction(orderId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOrder(result.data.order);
    });
  }, [open, orderId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{order ? order.orderNumber : 'Procurement clock'}</DialogTitle>
          <DialogDescription>
            {order
              ? `${order.customerName} · due by ${formatDate(order.deadline)}`
              : 'Loading this order’s lines…'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {error && <ErrorMessage message={error} />}

        {order && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <ClockStateBadge state={order.state} />
              {order.orderStatus === 'CANCELLED' && <Badge variant="neutral">Cancelled</Badge>}
              {order.readyForDispatch && <Badge variant="positive">Ready to pack</Badge>}
            </div>

            {completionLine(order) && (
              <p className="text-xs text-muted">{completionLine(order)}</p>
            )}

            <div className="scroll-x">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Ordered</TableHead>
                    <TableHead className="text-right">Cancelled</TableHead>
                    <TableHead className="text-right">To cover</TableHead>
                    <TableHead className="text-right">By hand</TableHead>
                    <TableHead className="text-right">Purchased</TableHead>
                    <TableHead className="text-right">Short</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.items.map((item) => (
                    <ItemRow
                      key={item.salesOrderItemId}
                      item={item}
                      canEdit={canEdit}
                      cancelled={order.orderStatus === 'CANCELLED'}
                      onChanged={setOrder}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            {/*
              Procurement's own account of a late order. Offered only once the
              verdict is DELAYED — an order still waiting for goods is explained
              line by line above, not here, which is the rule that keeps the two
              workflows from overlapping.
            */}
            {order.verdict === 'DELAYED' && (
              <ProcurementDelaySection
                order={order}
                canSubmit={canReview}
                canDecide={isAdmin}
                onChanged={setOrder}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ItemRow({
  item,
  canEdit,
  cancelled,
  onChanged,
}: {
  item: ClockItemView;
  canEdit: boolean;
  cancelled: boolean;
  onChanged: (order: ProcurementClockDetail) => void;
}) {
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A covered line has nothing to explain, and a cancelled order needs nothing
  // procured. The API refuses both; this only avoids offering the button.
  const explainable = canEdit && !cancelled && item.outstandingQty > 0 && !item.pendingDelayReason;

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const result = await submitPurchaseDelayAction(item.salesOrderItemId, {
        reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Delay reason submitted for approval.');
      setExplaining(false);
      setReason('');
      onChanged(result.data.order);
    });
  }

  return (
    <>
      <TableRow>
        <TableCell className="text-muted tabular">{item.lineNo}</TableCell>
        <TableCell className="text-ink">
          {item.productName}
          {!item.linked && (
            <span className="ml-2 text-xs text-faint">unmapped</span>
          )}
        </TableCell>
        <TableCell className="text-right font-mono text-ink-2 tabular">{item.orderedQty}</TableCell>
        <TableCell className="text-right font-mono text-muted tabular">
          {item.cancelledQty}
        </TableCell>
        <TableCell className="text-right font-mono text-ink tabular">{item.requiredQty}</TableCell>
        <TableCell className="text-right font-mono text-muted tabular">
          {item.alreadyFulfilled}
        </TableCell>
        <TableCell className="text-right font-mono text-muted tabular">
          {item.allocatedQty}
        </TableCell>
        <TableCell className="text-right font-mono text-ink tabular">
          {item.outstandingQty}
        </TableCell>
        <TableCell>
          <FulfillmentBadge status={item.status} />
        </TableCell>
        <TableCell className="text-right">
          {explainable && (
            <Button variant="outline" size="sm" onClick={() => setExplaining((v) => !v)}>
              Explain delay
            </Button>
          )}
        </TableCell>
      </TableRow>

      {item.delayReasons.length > 0 && (
        <TableRow>
          <TableCell colSpan={10} className="bg-surface-2">
            <ul className="flex flex-col gap-1.5">
              {item.delayReasons.map((delay) => (
                <li key={delay.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <DelayReasonBadge status={delay.status} />
                  <span className="text-ink-2">{delay.reason}</span>
                  <span className="text-muted">
                    {delay.requestedBy.name} · {formatDateTime(delay.requestedAt)}
                  </span>
                  {delay.reviewNote && <span className="text-muted">“{delay.reviewNote}”</span>}
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}

      {explaining && (
        <TableRow>
          <TableCell colSpan={10}>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`reason-${item.salesOrderItemId}`}>
                Why can this line not be covered?
              </Label>
              <Textarea
                id={`reason-${item.salesOrderItemId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="A sentence at least — procurement is being asked to accept this."
              />
              {error && <ErrorMessage message={error} />}
              <div className="flex gap-2">
                <Button size="sm" onClick={submit} disabled={pending || reason.trim().length < 10}>
                  Submit for approval
                </Button>
                <Button variant="outline" size="sm" onClick={() => setExplaining(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The order-level chain: procurement submits, an administrator decides.
 *
 * Nothing in here can change the verdict. Approving the reason records that the
 * explanation was accepted — the order was still covered late, and the badge
 * above goes on saying so.
 */
function ProcurementDelaySection({
  order,
  canSubmit,
  canDecide,
  onChanged,
}: {
  order: ProcurementClockDetail;
  canSubmit: boolean;
  canDecide: boolean;
  onChanged: (order: ProcurementClockDetail) => void;
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = order.procurementDelay;

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const result = await submitProcurementDelayAction(order.orderId, { reason: reason.trim() });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Reason submitted for the administrator to decide.');
      setReason('');
      onChanged(result.data.order);
    });
  }

  function decide(decision: 'approve' | 'reject'): void {
    if (!open) return;
    setError(null);
    startTransition(async () => {
      const result = await reviewProcurementDelayAction(
        open.id,
        decision,
        note.trim() ? { note: note.trim() } : {},
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(decision === 'approve' ? 'Reason approved.' : 'Reason rejected.');
      setNote('');
      onChanged(result.data.order);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Procurement’s account of the delay
        </h3>
        {order.procurementDelayRequired && <Badge variant="critical">Still needed</Badge>}
      </div>

      <p className="text-xs text-muted">
        This order was covered after its deadline. Approving an explanation records that it was
        accepted — it does not change when the order was covered, and the result stays “covered
        late”.
      </p>

      {order.procurementDelays.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {order.procurementDelays.map((delay) => (
            <li key={delay.id} className="flex flex-wrap items-baseline gap-2 text-xs">
              <DelayReasonBadge status={delay.status} />
              <span className="text-ink-2">{delay.reason}</span>
              <span className="text-muted">
                {delay.requestedBy.name} · {formatDateTime(delay.requestedAt)}
              </span>
              {delay.reviewedBy && (
                <span className="text-muted">
                  decided by {delay.reviewedBy.name}
                  {delay.reviewNote ? ` · “${delay.reviewNote}”` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <ErrorMessage message={error} />}

      {!open && canSubmit && (
        <div className="flex flex-col gap-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Why was this order covered late?"
            aria-label="Procurement delay reason"
          />
          <Button size="sm" onClick={submit} disabled={pending || reason.trim().length < 10}>
            Submit to the administrator
          </Button>
        </div>
      )}

      {open && canDecide && (
        <div className="flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="Note (optional on approval, expected on rejection)"
            aria-label="Decision note"
          />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => decide('reject')} disabled={pending}>
              Reject
            </Button>
            <Button size="sm" onClick={() => decide('approve')} disabled={pending}>
              Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
