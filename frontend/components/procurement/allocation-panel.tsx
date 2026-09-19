'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Link2, Loader2, Lock, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { OrderRequirementView, PurchaseBillItemView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ErrorMessage } from '@/components/common/error-message';
import { RsProductPicker, type PickedProduct } from '@/components/products/rs-product-picker';
import { FulfillmentBadge, PendingQty } from './procurement-badges';
import {
  allocateAction,
  linkOrderLineAction,
  lookupOrderAction,
} from '@/app/(app)/procurement/actions';

/**
 * Mapping purchased stock onto a customer order.
 *
 * The flow starts from the order number, because that is how the work actually
 * arrives: someone is chasing a customer who is still waiting. Asking which
 * product the goods correspond to *before* knowing which order they are for is
 * a question out of order — it interrupts the task with bookkeeping.
 *
 * So the product is settled only where it genuinely blocks progress: at the
 * moment a specific order line is chosen and one of the two sides turns out not
 * to be mapped. Allocation matches on `RsProduct.id` and never on spelling, so
 * both sides must name a product before stock can move — but the user is asked
 * about it against a concrete line, not upfront and in the abstract.
 *
 * One identity, on both sides. This panel used to carry a second catalogue: the
 * legacy Product master, which Sales and Procurement each linked to separately
 * and which Procurement could create entries in. Both sides name an RsProduct
 * now, so there is one picker, one comparison, and no catalogue to maintain
 * here — a product that does not exist is created in RS Products.
 *
 * Nothing here decides business outcomes. Every rule — mismatched products,
 * over-allocation, standing limits, the freeze on fulfilled lines, permissions
 * — is enforced again by the API on its own authority.
 */
export function AllocationPanel({
  billId,
  item,
  canEdit,
  isAdmin,
}: {
  billId: string;
  item: PurchaseBillItemView;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [orderNumber, setOrderNumber] = useState('');
  const [order, setOrder] = useState<OrderRequirementView | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  /** The order line the user is choosing a product for, if any. */
  const [mappingLineId, setMappingLineId] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedProduct | null>(null);

  const rsProduct = item.rsProduct;

  function findOrder(): void {
    setError(null);
    setOrder(null);
    setMappingLineId(null);
    startTransition(async () => {
      const result = await lookupOrderAction(orderNumber.trim());
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOrder(result.data.order);
    });
  }

  /** Re-reads the order so pending and allocated figures stay truthful. */
  async function refreshOrder(): Promise<void> {
    if (!order) return;
    const refreshed = await lookupOrderAction(order.orderId);
    if (refreshed.ok) setOrder(refreshed.data.order);
  }

  /**
   * Says which RS Product an *order* line is for.
   *
   * Chosen explicitly, never inferred. Two products can share a title and RS
   * SKUs legitimately repeat, so anything derived from the line's wording would
   * be a guess — and an allocation that lands on the wrong goods cannot be
   * undone once its stock is spent.
   */
  function mapOrderLine(salesOrderItemId: string, rsProductId: string): void {
    setError(null);
    startTransition(async () => {
      const result = await linkOrderLineAction({ salesOrderItemId, rsProductId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Order line mapped.');
      setMappingLineId(null);
      setPicked(null);
      setOrder(result.data.order);
      router.refresh();
    });
  }

  function allocate(salesOrderItemId: string): void {
    const raw = quantities[salesOrderItemId];
    const quantity = Number(raw);
    if (!raw || !Number.isInteger(quantity) || quantity < 1) {
      setError('Enter a whole quantity of at least 1.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await allocateAction(billId, item.id, { salesOrderItemId, quantity });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(`${quantity} allocated.`);
      await refreshOrder();
      setQuantities((q) => ({ ...q, [salesOrderItemId]: '' }));
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!canEdit || item.standingQty === 0}
        onClick={() => setOpen(true)}
        title={item.standingQty === 0 ? 'Nothing unallocated on this line' : undefined}
      >
        Map Quantity
      </Button>

      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Map {rsProduct?.title ?? item.productName}</DialogTitle>
            <DialogDescription>
              {item.standingQty} unit{item.standingQty === 1 ? '' : 's'} unallocated on this
              purchase line. Find the order waiting for them.
            </DialogDescription>
          </DialogHeader>

          {/*
            The purchase side, stated before anything else. Stock cannot move
            from a line nobody has said the product of, so saying so here saves
            the user working through an order only to be refused at the end.
          */}
          {!rsProduct && (
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
              <Badge variant="warning">Not mapped to RS Products</Badge>
              <p className="mt-1.5 text-xs text-muted">
                This purchase line has no product, so its stock cannot be allocated. Close this and
                use <span className="text-ink">Map product</span> on the line first.
              </p>
            </div>
          )}

          {/* Step one, always: which order is this for? */}
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={`order-lookup-${item.id}`}>Order ID</Label>
              <Input
                id={`order-lookup-${item.id}`}
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    findOrder();
                  }
                }}
                placeholder="e.g. rs900"
              />
            </div>
            <Button type="button" onClick={findOrder} disabled={pending || !orderNumber.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              Find Order
            </Button>
          </div>

          {error && <ErrorMessage message={error} />}

          {order && (
            <div className="flex flex-col gap-3">
              <Separator />

              <div className="flex items-baseline justify-between">
                <div>
                  <p className="font-medium text-ink">{order.customer.name}</p>
                  <p className="font-mono text-xs text-muted">{order.orderId}</p>
                </div>
                <Badge variant="outline">{order.status}</Badge>
              </div>

              <div className="flex flex-col gap-2">
                {order.lines.map((line) => {
                  // Both sides need a product before stock can move. Which side
                  // is missing decides what to ask for.
                  const bothMapped = line.linked && rsProduct !== null;
                  const sameProduct = bothMapped && line.rsProductId === rsProduct!.id;
                  const cap = Math.min(line.pendingQty, item.standingQty);
                  const isMapping = mappingLineId === line.salesOrderItemId;

                  return (
                    <div
                      key={line.salesOrderItemId}
                      className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {line.productName}
                          </p>
                          {/*
                            Ordered, not "required": the board's Required column
                            carries outstanding demand, and reusing the word for
                            gross quantity made 5 and 3 look like a disagreement
                            when they are the same line seen before and after
                            fulfilment. Naming each term shows the subtraction.
                          */}
                          <p className="text-xs text-muted">
                            {line.requiredQty} ordered · {line.alreadyFulfilled} already fulfilled ·{' '}
                            {line.allocatedQty} allocated ·{' '}
                            <PendingQty qty={line.pendingQty} /> still needed
                          </p>
                        </div>

                        <FulfillmentBadge status={line.status} />

                        {line.frozen ? (
                          <span className="flex items-center gap-1 text-xs text-muted">
                            <Lock className="size-3" />
                            {isAdmin ? 'Fulfilled' : 'Fulfilled — locked'}
                          </span>
                        ) : !line.linked ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              setMappingLineId(isMapping ? null : line.salesOrderItemId);
                              setPicked(null);
                            }}
                          >
                            <Link2 className="size-3.5" />
                            Map product
                          </Button>
                        ) : !rsProduct ? (
                          <span className="text-xs text-muted">Purchase line not mapped</span>
                        ) : !sameProduct ? (
                          <span className="text-xs text-muted">Different product</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              className="w-20"
                              inputMode="numeric"
                              // Advisory only — the server checks the same cap
                              // against locked rows before any stock moves.
                              max={cap}
                              placeholder={String(cap)}
                              value={quantities[line.salesOrderItemId] ?? ''}
                              onChange={(e) =>
                                setQuantities((q) => ({
                                  ...q,
                                  [line.salesOrderItemId]: e.target.value,
                                }))
                              }
                            />
                            <Button
                              size="sm"
                              disabled={pending || cap === 0}
                              onClick={() => allocate(line.salesOrderItemId)}
                            >
                              Map
                            </Button>
                          </div>
                        )}
                      </div>

                      {/*
                        The product step, asked only about the line the user
                        actually picked — and never answered for them. A name
                        match would be a guess presented as a fact, and
                        "brassdinnerset" is not evidence of anything.
                      */}
                      {isMapping && (
                        <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
                          <p className="text-xs text-muted">
                            This order line is not mapped to RS Products. Choose the product it
                            refers to — search by name or SKU.
                          </p>

                          <RsProductPicker
                            value={picked}
                            onChange={setPicked}
                            disabled={pending}
                            triggerLabel={line.productName}
                          />

                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => {
                                setMappingLineId(null);
                                setPicked(null);
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={pending || !picked}
                              onClick={() => mapOrderLine(line.salesOrderItemId, picked!.id)}
                            >
                              {pending && <Loader2 className="size-3.5 animate-spin" />}
                              Map to this product
                            </Button>
                          </div>

                          <p className="text-[11px] text-muted">
                            A SKU can belong to more than one product, so the search may return
                            several. Nothing is matched for you.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
