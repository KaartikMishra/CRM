'use client';

import type { PurchaseBillItemView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import type { ProductView } from '@rs/shared';
import { AllocationPanel } from './allocation-panel';
import { ReceiveDialog } from './receive-dialog';
import { StandingQty } from './procurement-badges';

/**
 * The bill's product lines, each with its own allocation state.
 *
 * Standing quantity leads on every line because it is the number that decides
 * what can happen next: nothing else on the row changes whether stock is
 * available to assign.
 */
export function BillItemList({
  billId,
  items,
  products,
  canEdit,
  isAdmin,
}: {
  billId: string;
  items: PurchaseBillItemView[];
  /** The catalogue, for reconciling a vendor's wording with an entry. */
  products: ProductView[];
  canEdit: boolean;
  isAdmin: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <Card key={item.id}>
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                {item.productImage && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={item.productImage.secureUrl}
                    alt=""
                    className="size-12 rounded-md border border-line object-cover"
                  />
                )}
                <div className="min-w-0">
                  {/* The vendor's own wording leads: this is a record of their
                      bill. The catalogue link, when present, is shown beneath. */}
                  <p className="font-medium text-ink">{item.productName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Line {item.lineNo} · {formatCurrency(item.rate)} per unit
                    {item.product
                      ? ` · ${item.product.name} · ${item.product.onHand} on hand`
                      : ' · not linked to the catalogue'}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {canEdit && <ReceiveDialog billId={billId} item={item} />}
                <AllocationPanel
                  billId={billId}
                  item={item}
                  products={products}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                />
              </div>
            </div>

            <Separator className="my-4" />

            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Figure label="Ordered" value={item.orderedQty} />
              <Figure label="Received" value={item.receivedQty} />
              <Figure label="Allocated" value={item.allocatedQty} />
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">Standing</dt>
                <dd className="mt-1 text-sm"><StandingQty qty={item.standingQty} /></dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">Line value</dt>
                <dd className="mt-1 text-sm text-ink tabular">{formatCurrency(item.lineTotal)}</dd>
              </div>
            </dl>

            {item.allocations.length > 0 && (
              <>
                <Separator className="my-4" />
                <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">
                  Allocated to
                </p>
                <ul className="flex flex-col gap-1.5">
                  {item.allocations.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-ink-2">
                        <span className="font-mono text-xs text-muted">{a.order.orderId}</span>
                        {' · '}
                        {a.order.customerName}
                      </span>
                      <span className="flex items-center gap-2">
                        {a.frozen && <Badge variant="positive">Fulfilled</Badge>}
                        <span className="tabular font-medium text-ink">{a.quantity}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-ink tabular">{value}</dd>
    </div>
  );
}
