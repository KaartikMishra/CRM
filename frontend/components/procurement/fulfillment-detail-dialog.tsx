'use client';

import { useEffect, useState } from 'react';
import { Loader2, PackageX } from 'lucide-react';
import type { SalesFulfillmentDetail } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { FulfillmentBadge } from './procurement-badges';
import { fulfillmentDetailAction } from '@/app/(app)/procurement/actions';

/** A label above its value, the shape every field in this dialog takes. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <div className="mt-0.5 truncate text-sm text-ink">{value}</div>
    </div>
  );
}

/** A section heading, so the dialog reads as a document rather than a form. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h3>
  );
}

const day = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(iso));

/**
 * Where one order line's fulfilment came from.
 *
 * The History table answers "how much", and stops there. Someone chasing a
 * customer then has to ask the question this dialog exists for: which vendor
 * actually supplied those units, off which bill, and what is left on it.
 *
 * Every number here is the server's own — the dialog renders what the API
 * computed and does no arithmetic of its own, so it cannot disagree with the
 * row that opened it. Fetched on open rather than with the table, because a
 * page of twenty rows should not drag twenty vendors along with it.
 */
export function FulfillmentDetailDialog({
  salesOrderItemId,
  open,
  onOpenChange,
}: {
  salesOrderItemId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [detail, setDetail] = useState<SalesFulfillmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !salesOrderItemId) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setDetail(null);

    void fulfillmentDetailAction(salesOrderItemId).then((result) => {
      // The dialog may have closed while the request was in flight.
      if (cancelled) return;
      if (!result.ok) setError(result.message);
      else setDetail(result.data.detail);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, salesOrderItemId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sales fulfilment details</DialogTitle>
          <DialogDescription>
            {detail
              ? `How ${detail.order.orderId} was supplied, and from where.`
              : 'Loading this order line’s fulfilment record.'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        )}

        {error && <ErrorMessage message={error} />}

        {detail && (
          <div className="flex flex-col gap-4">
            {/* Who and what. */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Order" value={<span className="font-mono text-xs">{detail.order.orderId}</span>} />
              <Field label="Customer" value={detail.customer.name} />
              <Field label="Order date" value={day(detail.order.orderDate)} />
              <Field label="Status" value={<FulfillmentBadge status={detail.status} />} />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/*
                The order's own wording and the catalogue entry are shown
                separately and never merged: the order says what the customer
                asked for, the catalogue says what it was matched to, and a
                reader chasing a discrepancy needs both.
              */}
              <Field label="Product (as ordered)" value={detail.productName} />
              <Field
                label="Catalogue product"
                value={
                  detail.product ? (
                    detail.product.name
                  ) : (
                    <Badge variant="warning">Not in catalogue</Badge>
                  )
                }
              />
              {(detail.customer.phone ?? detail.customer.email) && (
                <Field
                  label="Customer contact"
                  value={[detail.customer.phone, detail.customer.email].filter(Boolean).join(' · ')}
                />
              )}
            </div>

            <Separator />

            <SectionTitle>Fulfilment summary</SectionTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Field label="Required" value={<span className="tabular">{detail.requiredQty}</span>} />
              <Field label="Already fulfilled" value={<span className="tabular">{detail.alreadyFulfilled}</span>} />
              <Field label="Procurement" value={<span className="tabular">{detail.procurementFulfilled}</span>} />
              <Field label="Total fulfilled" value={<span className="tabular font-medium">{detail.totalFulfilled}</span>} />
              <Field
                label="Unfulfilled"
                value={
                  <span className={detail.unfulfilledQty > 0 ? 'tabular font-medium text-critical' : 'tabular text-muted'}>
                    {detail.unfulfilledQty}
                  </span>
                }
              />
            </div>

            {detail.alreadyFulfilled > 0 && (
              /*
                Stated plainly, because the sources below cannot account for
                it: "already fulfilled" is stock supplied outside procurement,
                with no bill and no vendor behind it.
              */
              <p className="text-xs text-muted">
                {detail.alreadyFulfilled} unit{detail.alreadyFulfilled === 1 ? '' : 's'} recorded as
                supplied outside procurement — no purchase bill is associated with those.
              </p>
            )}

            <Separator />

            <SectionTitle>Procurement sources</SectionTitle>
            {detail.sources.length === 0 ? (
              <div className="flex items-center gap-3 rounded-md border border-line px-3 py-4 text-sm text-muted">
                <PackageX className="size-4 shrink-0" />
                Nothing has been allocated to this line from a purchase bill.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/*
                  One card per allocation. Two bills from two vendors stay two
                  cards — pooling them would answer "how many" while losing
                  "from whom", which is the question being asked.
                */}
                {detail.sources.map((s) => (
                  <div key={s.allocationId} className="flex flex-col gap-3 rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-sm font-medium text-ink">{s.bill.billNumber}</span>
                        <Badge variant="outline">{s.bill.status}</Badge>
                        <Badge variant="outline">{s.bill.billType === 'PAID_UP' ? 'Paid up' : 'Credit'}</Badge>
                      </div>
                      <span className="text-sm">
                        <span className="font-medium text-ink tabular">{s.allocatedQty}</span>
                        <span className="text-muted"> allocated</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label="Purchase line" value={s.purchaseLine.productName} />
                      <Field label="Ordered" value={<span className="tabular">{s.purchaseLine.orderedQty}</span>} />
                      <Field label="Received" value={<span className="tabular">{s.purchaseLine.receivedQty}</span>} />
                      <Field
                        label="Standing on line"
                        value={<span className="tabular">{s.purchaseLine.standingQty}</span>}
                      />
                      <Field label="Rate" value={<span className="tabular">{s.purchaseLine.rate}</span>} />
                      <Field label="Line value" value={<span className="tabular">{s.purchaseLine.lineTotal}</span>} />
                      <Field label="Bill date" value={day(s.bill.billDate)} />
                      {s.bill.expectedBy && <Field label="Expected by" value={day(s.bill.expectedBy)} />}
                    </div>

                    <Separator />

                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field
                        label="Vendor"
                        value={
                          <span className="flex items-center gap-1.5">
                            {s.vendor.name}
                            {!s.vendor.isActive && <Badge variant="warning">Inactive</Badge>}
                          </span>
                        }
                      />
                      {s.vendor.contactPerson && <Field label="Contact" value={s.vendor.contactPerson} />}
                      {s.vendor.phone && <Field label="Phone" value={s.vendor.phone} />}
                      {s.vendor.email && <Field label="Email" value={s.vendor.email} />}
                      {s.vendor.city && <Field label="City" value={s.vendor.city} />}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {detail.activity.length > 0 && (
              <>
                <Separator />
                <SectionTitle>Activity</SectionTitle>
                {/*
                  Only events that carry a real timestamp. "Already fulfilled"
                  has none — it is a quantity someone typed, with no record of
                  when the goods moved — so it is summarised above rather than
                  given an invented date here.
                */}
                <ol className="flex flex-col gap-2">
                  {detail.activity.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="flex items-baseline gap-3 text-sm">
                      <span className="w-24 shrink-0 text-xs text-muted">{day(e.at)}</span>
                      <span className="text-ink">{e.label}</span>
                      {e.detail && <span className="truncate text-xs text-muted">{e.detail}</span>}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
