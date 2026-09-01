'use client';

import { useState, useTransition } from 'react';
import { Check, ImageIcon, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SalesChangeRequestView, SalesOrderItemView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/common/empty-state';
import { formatCurrency, formatDateTime, label } from '@/lib/format';
import {
  approveChangeRequestAction,
  rejectChangeRequestAction,
} from '@/app/(app)/sales/actions';
import {
  AddProductDialog,
  EditProductDialog,
  RemoveProductDialog,
} from './change-request-dialogs';

type Props = {
  orderId: string;
  items: SalesOrderItemView[];
  changeRequests: SalesChangeRequestView[];
  currency: string;
  /** All resolved server-side from backend permissions + ownership. */
  canRequest: boolean;
  canReview: boolean;
  /** The signed-in person, so their own requests never offer them a decision. */
  currentUserId: string;
};

const STATUS_VARIANT = {
  PENDING: 'warning',
  APPROVED: 'positive',
  REJECTED: 'neutral',
} as const;

const TYPE_COPY = {
  ADD: 'Add product',
  EDIT: 'Edit product',
  REMOVE: 'Remove product',
} as const;

/**
 * The order's products, and the requests made against them.
 *
 * Deliberately two sections rather than one. Products are what the order
 * actually contains; requests are what somebody has asked for. Mixing them
 * would suggest a pending line is already part of the order, which is exactly
 * the thing that is not true — nothing here moves the total until it is
 * approved.
 */
export function SalesItemList({
  orderId,
  items,
  changeRequests,
  currency,
  canRequest,
  canReview,
  currentUserId,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SalesOrderItemView | null>(null);
  const [removing, setRemoving] = useState<SalesOrderItemView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const openRequests = changeRequests.filter((r) => r.status === 'PENDING');
  const decided = changeRequests.filter((r) => r.status !== 'PENDING');
  /** A line already under review cannot take a second request. */
  const lockedItemIds = new Set(openRequests.map((r) => r.current?.id).filter(Boolean));

  function decide(request: SalesChangeRequestView, approve: boolean) {
    setBusyId(request.id);
    startTransition(async () => {
      const result = approve
        ? await approveChangeRequestAction(orderId, request.id)
        : await rejectChangeRequestAction(orderId, request.id);
      setBusyId(null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(approve ? 'Change approved and applied' : 'Change rejected');
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------- Products ---------------- */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Products ({items.length})
          </h2>
          {canRequest && (
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)} disabled={pending}>
              <Plus className="size-4" />
              Add Product
            </Button>
          )}
        </div>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14">Item</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Price</TableHead>
                <TableHead className="text-right">Line Total</TableHead>
                {canRequest && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>

            <TableBody>
              {items.map((item) => {
                const locked = lockedItemIds.has(item.id);
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      {item.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.image.secureUrl}
                          alt=""
                          className="size-9 rounded-sm border border-line object-cover"
                        />
                      ) : (
                        <span className="grid size-9 place-items-center rounded-sm border border-line bg-surface-2 text-faint">
                          <ImageIcon className="size-4" />
                        </span>
                      )}
                    </TableCell>

                    <TableCell>
                      <span className="block font-medium text-ink">{item.productName}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        Line {item.lineNo}
                        {locked && ' · change awaiting approval'}
                      </span>
                    </TableCell>

                    <TableCell className="text-right tabular">{item.quantity}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular">
                      {formatCurrency(item.price, currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-ink tabular">
                      {formatCurrency(item.lineTotal, currency)}
                    </TableCell>

                    {canRequest && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${item.productName}`}
                            disabled={pending || locked}
                            title={locked ? 'A change is already awaiting approval' : undefined}
                            onClick={() => setEditing(item)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Request removal of ${item.productName}`}
                            disabled={pending || locked}
                            title={locked ? 'A change is already awaiting approval' : undefined}
                            onClick={() => setRemoving(item)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </section>

      {/* ---------------- Change requests ---------------- */}
      {(openRequests.length > 0 || decided.length > 0) && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">
            Change requests ({openRequests.length} awaiting)
          </h2>

          <div className="flex flex-col gap-3">
            {[...openRequests, ...decided].map((request) => {
              const awaiting = request.status === 'PENDING';
              const isOwnRequest = request.requestedBy.id === currentUserId;
              // Nobody decides their own request, whatever they hold.
              const mayDecide = canReview && awaiting && !isOwnRequest;
              const busy = busyId === request.id;

              return (
                <Card key={request.id} className={awaiting ? 'border-warning/40' : undefined}>
                  <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={STATUS_VARIANT[request.status]}>
                          {label(request.status)}
                        </Badge>
                        <span className="text-sm font-medium text-ink">
                          {TYPE_COPY[request.type]}
                        </span>
                      </div>

                      {/* CURRENT -> PROPOSED, so the difference is readable at a glance. */}
                      <div className="mt-2.5 grid gap-2 text-sm sm:grid-cols-2">
                        {request.current && (
                          <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
                            <span className="text-[11px] uppercase tracking-wider text-muted">
                              {request.type === 'REMOVE' ? 'Proposed for removal' : 'Current'}
                            </span>
                            <p className="mt-0.5 text-ink tabular">
                              {request.current.productName} · {request.current.quantity} ×{' '}
                              {formatCurrency(request.current.price, currency)} ={' '}
                              {formatCurrency(request.current.lineTotal, currency)}
                            </p>
                          </div>
                        )}

                        {request.proposed && (
                          <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
                            <span className="text-[11px] uppercase tracking-wider text-muted">
                              {request.type === 'ADD' ? 'New product requested' : 'Proposed'}
                            </span>
                            <p className="mt-0.5 text-ink tabular">
                              {request.proposed.productName} · {request.proposed.quantity} ×{' '}
                              {formatCurrency(request.proposed.price, currency)} ={' '}
                              {formatCurrency(request.proposed.lineTotal, currency)}
                            </p>
                          </div>
                        )}
                      </div>

                      <p className="mt-2 text-xs text-muted tabular">
                        Requested by {request.requestedBy.name} ·{' '}
                        {formatDateTime(request.requestedAt)}
                        {request.reviewedBy && request.reviewedAt && (
                          <>
                            {' · '}
                            {request.status === 'APPROVED' ? 'Approved' : 'Rejected'} by{' '}
                            {request.reviewedBy.name} · {formatDateTime(request.reviewedAt)}
                          </>
                        )}
                      </p>

                      {request.reviewNote && (
                        <p className="mt-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
                          {request.reviewNote}
                        </p>
                      )}

                      {awaiting && (
                        <p className="mt-2 text-xs text-muted">
                          {request.type === 'ADD'
                            ? 'Not included in the order total until approved.'
                            : 'The product on the order is unchanged until this is approved.'}
                        </p>
                      )}
                    </div>

                    {mayDecide && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => decide(request, false)}
                        >
                          {busy && pending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <X className="size-4" />
                          )}
                          Reject
                        </Button>
                        <Button size="sm" disabled={pending} onClick={() => decide(request, true)}>
                          {busy && pending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Check className="size-4" />
                          )}
                          Approve
                        </Button>
                      </div>
                    )}

                    {awaiting && canReview && isOwnRequest && (
                      <span className="shrink-0 text-xs text-muted">
                        Someone else has to decide your own request.
                      </span>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {items.length === 0 && (
        <Card>
          <EmptyState icon={ImageIcon} title="No products on this order" />
        </Card>
      )}

      <AddProductDialog
        orderId={orderId}
        open={addOpen}
        onOpenChange={setAddOpen}
        decidesImmediately={canReview}
      />
      <EditProductDialog orderId={orderId} item={editing} onClose={() => setEditing(null)} />
      <RemoveProductDialog orderId={orderId} item={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
