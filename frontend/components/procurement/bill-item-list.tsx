'use client';

import { useState } from 'react';
import { ImageOff, Link2 } from 'lucide-react';
import type { PurchaseBillItemView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import { AllocationPanel } from './allocation-panel';
import { ChangeRsProductDialog } from './change-rs-product-dialog';
import { MapRsProductDialog } from './map-rs-product-dialog';
import { ReceiveDialog } from './receive-dialog';
import { StandingQty } from './procurement-badges';

/**
 * The bill's product lines, each with its own mapping and allocation state.
 *
 * Standing quantity leads on every line because it is the number that decides
 * what can happen next: nothing else on the row changes whether stock is
 * available to assign.
 *
 * The RS Product is shown as the line's identity, and an unmapped line says so
 * plainly rather than looking like one whose product simply has no name. A
 * mapping is never inferred from the vendor's wording, so "not mapped" is a
 * real state someone has to resolve, not a rendering gap.
 */
export function BillItemList({
  billId,
  items,
  canEdit,
  isAdmin,
}: {
  billId: string;
  items: PurchaseBillItemView[];
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const [mapping, setMapping] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <Card key={item.id}>
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <LineThumb item={item} />
                <div className="min-w-0">
                  {/* The vendor's own wording leads: this is a record of their
                      bill. What it was mapped to is shown beneath. */}
                  <p className="font-medium text-ink">{item.productName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Line {item.lineNo} · {formatCurrency(item.rate)} per unit
                  </p>

                  {item.rsProduct ? (
                    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                      <span className="text-ink-2">{item.rsProduct.title}</span>
                      {/* Always shown, so a missing SKU reads as a fact about
                          the product rather than as a row that rendered wrong. */}
                      <span className="font-mono text-[11px] text-muted">
                        SKU: {item.rsProduct.sku ?? 'Not available'}
                      </span>
                    </p>
                  ) : (
                    /*
                      Said plainly, and never softened into a near-match. Nothing
                      suggests a similar RS Product here: an approximate mapping
                      cannot be untangled once stock is allocated through it, so
                      the resolution is to pick the right product — or to create
                      it in RS Products first — not to accept a close one.
                    */
                    <p className="mt-1">
                      <Badge variant="warning">Not mapped to RS Products</Badge>
                    </p>
                  )}

                  {item.pendingProductChange && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <Badge variant="warning">Change pending approval</Badge>
                      <span className="text-muted">
                        requested → {item.pendingProductChange.toRsProduct.title}
                      </span>
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {/*
                  One button, two different acts, and the label says which.

                  An unmapped line is mapped directly — ordinary work, no
                  approval. A mapped line can only be *requested* to change, and
                  the dialog that opens says so. While a request is undecided
                  there is nothing to press: a second request on the same line is
                  refused by the server, so offering the button would only
                  produce an error.
                */}
                {canEdit && !item.pendingProductChange && (
                  <Button
                    variant={item.rsProduct ? 'ghost' : 'outline'}
                    size="sm"
                    onClick={() => setMapping(item.id)}
                  >
                    <Link2 className="size-3.5" />
                    {item.rsProduct ? 'Change product' : 'Map product'}
                  </Button>
                )}
                {canEdit && <ReceiveDialog billId={billId} item={item} />}
                <AllocationPanel
                  billId={billId}
                  item={item}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                />
              </div>
            </div>

            {/*
              Which dialog opens is decided by the line's current state, exactly
              as the server decides which endpoint will accept the write. The UI
              choosing differently would not let anything through — the mapping
              endpoint refuses a change on a mapped line — it would only produce
              a confusing error.
            */}
            {canEdit && !item.rsProduct && (
              <MapRsProductDialog
                billId={billId}
                item={item}
                open={mapping === item.id}
                onOpenChange={(next) => setMapping(next ? item.id : null)}
              />
            )}
            {canEdit && item.rsProduct && (
              <ChangeRsProductDialog
                billId={billId}
                item={item}
                open={mapping === item.id}
                onOpenChange={(next) => setMapping(next ? item.id : null)}
              />
            )}

            <Separator className="my-4" />

            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-7">
              <Figure label="Ordered" value={item.orderedQty} />
              <Figure label="Received" value={item.receivedQty} />
              <Figure label="Allocated" value={item.allocatedQty} />
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">Standing</dt>
                <dd className="mt-1 text-sm"><StandingQty qty={item.standingQty} /></dd>
              </div>
              {/*
                TWO stock figures, separately labelled and separately sourced.

                  CRM stock  →  the count this business maintains by hand
                  RS stock   →  Shopify's sellable quantity

                They are different numbers about the same goods and routinely
                disagree; showing one under the other's name — which this panel
                used to do, captioning the CRM figure "RS stock" — hides exactly
                the discrepancy a buyer needs to see.

                Both are read and never written from here. Receiving goods
                changes neither: this maps and displays, and any stock-write path
                is a separate decision that has not been taken.
              */}
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">CRM stock</dt>
                <dd className="mt-1 text-sm text-ink tabular">
                  {item.rsProduct ? item.rsProduct.crmStockQty : <span className="text-faint">—</span>}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted">RS stock</dt>
                <dd className="mt-1 text-sm text-ink tabular">
                  {item.rsProduct ? item.rsProduct.rsStockQty : <span className="text-faint">—</span>}
                </dd>
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

/**
 * The line's picture: the photo taken when the bill was entered, else the RS
 * Product's own. The uploaded one wins — it is a record of these goods, where
 * the catalogue image is a record of the product in general.
 */
function LineThumb({ item }: { item: PurchaseBillItemView }) {
  const url = item.productImage?.secureUrl ?? item.rsProduct?.imageUrl ?? null;

  if (!url) {
    return (
      <span
        className="grid size-12 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-muted"
        aria-hidden="true"
      >
        <ImageOff className="size-4" />
      </span>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={url}
      alt=""
      className="size-12 shrink-0 rounded-md border border-line object-cover"
    />
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
