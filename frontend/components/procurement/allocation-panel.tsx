'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Link2, Loader2, Lock, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { OrderRequirementView, ProductView, PurchaseBillItemView } from '@rs/shared';
import { normalizeProductName } from '@rs/shared';
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
import { FulfillmentBadge, PendingQty } from './procurement-badges';
import {
  allocateAction,
  linkOrderLineAction,
  linkPurchaseItemAction,
  lookupOrderAction,
  putInCatalogueAction,
} from '@/app/(app)/procurement/actions';


/**
 * Mapping purchased stock onto a customer order.
 *
 * The flow starts from the order number, because that is how the work actually
 * arrives: someone is chasing a customer who is still waiting. Asking which
 * catalogue entry the goods correspond to *before* knowing which order they are
 * for is a question out of order — it interrupts the task with bookkeeping.
 *
 * So the catalogue is settled only where it genuinely blocks progress: at the
 * moment a specific order line is chosen and one of the two sides turns out to
 * have no product identity. Allocation matches on product id and never on
 * spelling, so both sides must be linked before stock can move — but the user
 * is asked about it against a concrete line, not upfront and in the abstract.
 *
 * Nothing here decides business outcomes. Every rule — mismatched products,
 * over-allocation, standing limits, the freeze on fulfilled lines, permissions
 * — is enforced again by the API on its own authority.
 */
export function AllocationPanel({
  billId,
  item,
  products,
  canEdit,
  isAdmin,
}: {
  billId: string;
  item: PurchaseBillItemView;
  /** The catalogue, for the linking step when a line turns out to need it. */
  products: ProductView[];
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

  /** The order line the user is resolving a catalogue link for, if any. */
  const [linkingLineId, setLinkingLineId] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');

  const product = item.product;

  function findOrder(): void {
    setError(null);
    setOrder(null);
    setLinkingLineId(null);
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
   * Attaches this *purchase* line to a catalogue product.
   *
   * Needed when the bill was typed in the vendor's words and nobody has said
   * yet what those words refer to. Chosen explicitly: two products can share a
   * name, and inferring one would pool their stock silently.
   */
  function linkPurchaseLine(productId: string): void {
    setError(null);
    startTransition(async () => {
      const result = await linkPurchaseItemAction(billId, item.id, { productId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Purchase line linked.');
      setLinkingLineId(null);
      await refreshOrder();
      router.refresh();
    });
  }

  /** The same, for an *order* line that predates the product master. */
  function linkOrderLine(salesOrderItemId: string, productId: string): void {
    setError(null);
    startTransition(async () => {
      const result = await linkOrderLineAction({ salesOrderItemId, productId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Order line linked.');
      setLinkingLineId(null);
      setOrder(result.data.order);
      router.refresh();
    });
  }

  /**
   * Catalogues the order line's own wording, then links the line to it.
   *
   * Offered only when nothing in the catalogue already represents the product.
   * The server still decides — it re-checks the folded name and reuses an
   * existing entry if one appeared in the meantime — so this button cannot
   * create a duplicate even if the list here is a moment out of date.
   */
  function putInCatalogue(salesOrderItemId: string): void {
    setError(null);
    startTransition(async () => {
      const result = await putInCatalogueAction({ salesOrderItemId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success('Added to the catalogue and linked.');
      setLinkingLineId(null);
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

  /*
    Every matching active product, with no cap on how many are listed.

    A count that stops at six answers a question nobody asked: the picker has a
    search box, so the list's job is to be complete and let the reader scroll or
    type. Capping it meant an empty box showed six of thirteen products and read
    as the whole catalogue.

    Matching uses the shared fold — lowercase, every space removed — so the
    picker agrees with the catalogue's own uniqueness rule and can never offer
    to create a product the database would refuse. Product.name is never
    rewritten. Inactive products stay out of the list: they cannot be linked,
    so offering one would only invite a rejected click.
  */
  const term = normalizeProductName(productQuery);
  const catalogueMatches = products.filter(
    (p) => p.isActive && (term === '' || normalizeProductName(p.name).includes(term)),
  );

  /**
   * Whether the catalogue already holds the line's product, under any spelling.
   *
   * Exact on the folded name, not a substring: "thali" appearing inside "kansa
   * thali" is a different product, and offering to reuse it would pool two
   * things that only look alike. An inactive hit still counts — the unique
   * index would refuse a rival regardless, so the UI says so rather than
   * offering a button that cannot work.
   */
  function catalogueEntryFor(productName: string): ProductView | undefined {
    const key = normalizeProductName(productName);
    return products.find((p) => normalizeProductName(p.name) === key);
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
            <DialogTitle>Map {item.productName}</DialogTitle>
            <DialogDescription>
              {item.standingQty} unit{item.standingQty === 1 ? '' : 's'} unallocated on this
              purchase line. Find the order waiting for them.
            </DialogDescription>
          </DialogHeader>

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
                  // Both sides need an identity before stock can move. Which
                  // side is missing decides what to ask for.
                  const orderLineLinked = line.linked;
                  const bothLinked = orderLineLinked && product !== null;
                  const sameProduct = bothLinked && line.productId === product!.id;
                  const cap = Math.min(line.pendingQty, item.standingQty);
                  /*
                    The catalogue entry this purchase line plainly names, even
                    though nobody has linked it yet: "Brasscooker" on the bill
                    and "Brass Cooker" in the catalogue fold to one key. Offered
                    as a one-click link rather than applied silently — the write
                    stays a decision someone makes having seen both spellings.
                  */
                  const purchaseMatch = product ? null : catalogueEntryFor(item.productName);
                  const isLinking = linkingLineId === line.salesOrderItemId;

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
                        ) : !orderLineLinked ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              setLinkingLineId(isLinking ? null : line.salesOrderItemId);
                              // Opens on the whole catalogue: see the note at
                              // the purchase-line button below.
                              setProductQuery('');
                            }}
                          >
                            <Link2 className="size-3.5" />
                            Link to catalogue
                          </Button>
                        ) : purchaseMatch?.isActive ? (
                          /*
                            The bill's wording already names a catalogue
                            product, so the whole picker would be ceremony:
                            offer the link itself. One click, and the quantity
                            input below becomes reachable.
                          */
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => linkPurchaseLine(purchaseMatch.id)}
                            title={`Link this purchase line to “${purchaseMatch.name}”`}
                          >
                            {pending && <Loader2 className="size-3.5 animate-spin" />}
                            <Link2 className="size-3.5" />
                            Link to {purchaseMatch.name}
                          </Button>
                        ) : !product ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                              setLinkingLineId(isLinking ? null : line.salesOrderItemId);
                              /*
                                Opens empty, so the picker shows the whole
                                active catalogue.

                                It used to prefill the box with the line's own
                                free text. That looked helpful and was the
                                opposite: "ganesh iDol" matches no catalogue
                                name, so the list opened empty and the user had
                                to clear a field they never typed in before any
                                product appeared. The name is already shown in
                                the prompt above the box; searching for it is
                                the user's choice, not the default.
                              */
                              setProductQuery('');
                            }}
                          >
                            <Link2 className="size-3.5" />
                            Link purchase line
                          </Button>
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
                        The catalogue step, asked only about the line the user
                        actually picked — and never answered for them. A name
                        match would be a guess presented as a fact, and
                        "brassdinnerset" is not evidence of anything.
                      */}
                      {isLinking && (
                        <div className="flex flex-col gap-2 rounded-md bg-surface-2 p-3">
                          <p className="text-xs text-muted">
                            {!orderLineLinked
                              ? 'This order line is not linked to the catalogue. Choose the product it refers to.'
                              : `This purchase line is not linked. Choose the catalogue product for “${item.productName}”.`}
                          </p>

                          {/*
                            Three answers, decided by what the catalogue already
                            holds for this line's wording:

                              active match    → offer it, do not offer creation
                              inactive match  → say so; neither reuse nor rival
                              nothing         → offer Put in Catalogue

                            The button never appears beside a match, so the
                            obvious way to create a duplicate is simply absent.
                          */}
                          {!orderLineLinked &&
                            (() => {
                              const match = catalogueEntryFor(line.productName);
                              if (match?.isActive) {
                                return (
                                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
                                    <span className="text-xs text-muted">Already in the catalogue as</span>
                                    <span className="text-sm font-medium text-ink">{match.name}</span>
                                    <Button
                                      size="sm"
                                      disabled={pending}
                                      onClick={() => linkOrderLine(line.salesOrderItemId, match.id)}
                                    >
                                      Link to it
                                    </Button>
                                  </div>
                                );
                              }
                              if (match) {
                                return (
                                  <div className="rounded-md border border-line bg-surface px-3 py-2">
                                    <Badge variant="warning">Inactive catalogue product</Badge>
                                    <p className="mt-1.5 text-xs text-muted">
                                      “{match.name}” already represents this product but is
                                      inactive. Reactivate it from the products list — adding a
                                      second entry would split its stock.
                                    </p>
                                  </div>
                                );
                              }
                              return (
                                <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
                                  <span className="min-w-0 flex-1 text-xs text-muted">
                                    Nothing in the catalogue matches “{line.productName}”.
                                  </span>
                                  <Button
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => putInCatalogue(line.salesOrderItemId)}
                                  >
                                    {pending && <Loader2 className="size-3.5 animate-spin" />}
                                    Put in Catalogue
                                  </Button>
                                </div>
                              );
                            })()}

                          <Input
                            value={productQuery}
                            onChange={(e) => setProductQuery(e.target.value)}
                            placeholder="Search the catalogue"
                          />

                          {/*
                            The list scrolls inside its own box rather than
                            growing the dialog: the search input above stays put
                            while the results move, so a long catalogue never
                            pushes it off screen.
                          */}
                          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                            {catalogueMatches.length === 0 ? (
                              <p className="py-1 text-xs text-muted">
                                No catalogue product matches. Create one from the products list
                                first.
                              </p>
                            ) : (
                              catalogueMatches.map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  disabled={pending}
                                  onClick={() =>
                                    orderLineLinked
                                      ? linkPurchaseLine(p.id)
                                      : linkOrderLine(line.salesOrderItemId, p.id)
                                  }
                                  className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:opacity-60"
                                >
                                  <span className="min-w-0 truncate text-ink">{p.name}</span>
                                  <span className="ml-3 shrink-0 text-xs text-muted tabular">
                                    {p.onHand} on hand
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
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
