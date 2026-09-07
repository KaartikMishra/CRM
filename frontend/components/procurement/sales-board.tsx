'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pencil, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import type { SalesRequirementRow } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorMessage } from '@/components/common/error-message';
import { FulfillmentBadge, PendingQty } from './procurement-badges';
import { recordFulfillmentAction } from '@/app/(app)/procurement/actions';
import { FulfillmentDetailDialog } from './fulfillment-detail-dialog';

/**
 * Which tab a line belongs to, decided by its derived status alone.
 *
 * Nothing is stored, moved or copied to place a row here: the same
 * SalesOrderItem appears under Active or History according to the arithmetic
 * the server already returns. Record a fulfilment and the row changes tab on
 * the next read — there is no second store to keep in step, and no row ever
 * leaves the database.
 */
const isActive = (row: SalesRequirementRow): boolean =>
  row.unfulfilledQty > 0 && row.status === 'UNFULFILLED';

/**
 * Today in Asia/Kolkata, as YYYY-MM-DD.
 *
 * `en-CA` because it formats as YYYY-MM-DD, which is what the API expects and
 * what `fulfilledOn` already carries. Taking the browser's local day would put
 * a user outside India on the wrong date.
 */
export function todayInIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shifts a YYYY-MM-DD day by whole days, staying on the calendar. */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Outstanding customer demand, line by line.
 *
 * Two columns are stored and the rest are arithmetic:
 *
 *   Requirement           the quantity ordered
 *   Already Fulfilled     supplied outside procurement, recorded by hand
 *   Procurement Fulfilled the sum of this line's allocations
 *   Total Fulfilled       the two added
 *   Unfulfilled           requirement minus total, floored at zero
 *
 * Only "Already Fulfilled" is editable. Total and Unfulfilled are derived on
 * the server every time they are read, so there is no second copy of the truth
 * to fall out of step — map stock to an order and these move on their own.
 *
 * Active shows only work not yet started; anything part-supplied or finished
 * moves to History, which keeps every line reachable rather than hiding it.
 * The split is per line, so one fulfilled line never takes its order's other
 * lines with it.
 */
export function SalesBoard({
  rows,
  canEdit,
}: {
  rows: SalesRequirementRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [historyDate, setHistoryDate] = useState<string>(() => todayInIST());
  /** The line whose fulfilment record is open, if any. */
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<SalesRequirementRow | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(): void {
    if (!editing) return;
    const alreadyFulfilled = Number(value);
    if (!Number.isInteger(alreadyFulfilled) || alreadyFulfilled < 0) {
      setError('Enter a whole number of units, zero or more.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await recordFulfillmentAction(editing.salesOrderItemId, { alreadyFulfilled });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Fulfilment recorded.');
      setEditing(null);
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Sales</h2>
        <Card>
          <CardContent className="flex items-center gap-3 p-5 text-sm text-muted">
            <ShoppingCart className="size-4 shrink-0" />
            No open sales orders — nothing is waiting on procurement.
          </CardContent>
        </Card>
      </section>
    );
  }

  // One pass, so a row is in exactly one tab and the counts cannot disagree
  // with what is rendered.
  const active = rows.filter(isActive);
  const history = rows.filter((r) => !isActive(r));
  // History is one IST day at a time. A row with no fulfilment date can never
  // match a day, so it drops out on its own rather than needing a special case.
  const historyOnDate = history.filter((r) => r.fulfilledOn === historyDate);
  const visible = tab === 'active' ? active : historyOnDate;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Sales</h2>
        <div className="flex items-center gap-1">
          {(
            [
              ['active', 'Active', active.length],
              ['history', 'History', historyOnDate.length],
            ] as const
          ).map(([key, label, count]) => (
            <Button
              key={key}
              type="button"
              variant={tab === key ? 'subtle' : 'ghost'}
              size="sm"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
              <span className="ml-1.5 tabular text-muted">{count}</span>
            </Button>
          ))}
        </div>
      </div>

      {/*
        The picker belongs to History alone: Active is "what is still owed",
        which no date narrows sensibly.
      */}
      {tab === 'history' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous day"
            onClick={() => setHistoryDate((d) => shiftDay(d, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>

          <Label htmlFor="history-date" className="sr-only">
            History date
          </Label>
          <Input
            id="history-date"
            type="date"
            value={historyDate}
            onChange={(e) => e.target.value && setHistoryDate(e.target.value)}
            className="w-auto"
          />

          <Button
            variant="ghost"
            size="sm"
            aria-label="Next day"
            onClick={() => setHistoryDate((d) => shiftDay(d, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>

          {historyDate !== todayInIST() && (
            <Button variant="ghost" size="sm" onClick={() => setHistoryDate(todayInIST())}>
              Today
            </Button>
          )}

          <span className="text-xs text-muted">
            {history.length} line{history.length === 1 ? '' : 's'} in history overall
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-5 text-sm text-muted">
            <ShoppingCart className="size-4 shrink-0" />
            {tab === 'active'
              ? 'Nothing outstanding — every open line has been supplied in full or in part.'
              : history.length === 0
                ? 'Nothing here yet — no line has been supplied against.'
                : `Nothing was supplied on ${historyDate}. Pick another date to see earlier activity.`}
          </CardContent>
        </Card>
      ) : (
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Order ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Requirement</TableHead>
              <TableHead className="text-right">Already</TableHead>
              <TableHead className="text-right">Procurement</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Unfulfilled</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>

          <TableBody>
            {visible.map((row) => (
              <TableRow
                key={row.salesOrderItemId}
                /*
                  A History row opens its fulfilment record — which bill and
                  which vendor supplied the units, and what is left on that
                  line. Active rows carry no such record: nothing has been
                  supplied against them, so there would be nothing to show.

                  The Already button inside the row stops propagation, so
                  editing a hand-recorded quantity does not also open this.
                */
                {...(tab === 'history'
                  ? {
                      onClick: () => setDetailFor(row.salesOrderItemId),
                      className: 'cursor-pointer',
                      title: 'View fulfilment details',
                    }
                  : {})}
              >
                <TableCell className="font-mono text-xs text-ink">{row.orderNumber}</TableCell>
                <TableCell className="text-ink-2">{row.customerName}</TableCell>
                <TableCell>
                  <span className="text-ink">{row.productName}</span>
                  {!row.linked && (
                    <span className="mt-0.5 block text-[11px] text-muted">Not in the catalogue</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular text-ink">{row.requiredQty}</TableCell>
                <TableCell className="text-right tabular text-ink-2">{row.alreadyFulfilled}</TableCell>
                <TableCell className="text-right tabular text-ink-2">
                  {row.procurementFulfilled}
                </TableCell>
                <TableCell className="text-right tabular font-medium text-ink">
                  {row.totalFulfilled}
                </TableCell>
                <TableCell className="text-right">
                  <PendingQty qty={row.unfulfilledQty} />
                </TableCell>
                <TableCell><FulfillmentBadge status={row.status} /></TableCell>
                {canEdit && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        // The row itself opens the detail view; this button
                        // edits, so it must not do both.
                        e.stopPropagation();
                        setEditing(row);
                        setValue(String(row.alreadyFulfilled));
                        setError(null);
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Already
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      )}

      <FulfillmentDetailDialog
        salesOrderItemId={detailFor}
        open={detailFor !== null}
        onOpenChange={(next) => !next && setDetailFor(null)}
      />

      <Dialog open={editing !== null} onOpenChange={(next) => !pending && !next && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Already fulfilled</DialogTitle>
            <DialogDescription>
              Units supplied to {editing?.customerName} outside procurement. Stock mapped from a
              purchase bill is counted separately and must not be entered here.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm">
                <p className="font-mono text-xs text-muted">{editing.orderNumber}</p>
                <p className="mt-0.5 text-ink">{editing.productName}</p>
                <p className="mt-1 text-xs text-muted">
                  {editing.requiredQty} required · {editing.procurementFulfilled} already mapped
                  from procurement
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="already-fulfilled">Already fulfilled</Label>
                <Input
                  id="already-fulfilled"
                  inputMode="numeric"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <p className="text-xs text-muted">
                  At most {editing.requiredQty - editing.procurementFulfilled}, since procurement
                  has already supplied {editing.procurementFulfilled}.
                </p>
              </div>

              {error && <ErrorMessage message={error} />}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
