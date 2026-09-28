'use client';

import { useState, useTransition } from 'react';
import { Clock } from 'lucide-react';
import type { ProcurementClockSummary } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/common/empty-state';
import { ContentRegion, ContentScrollArea, contentCard } from '@/components/common/content-page';
import { ClockStateBadge } from './procurement-badges';
import { ClockDetailDialog } from './clock-detail-dialog';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * Every sales order against its procurement deadline.
 *
 * Each figure on a row is the API's. Nothing here recomputes a requirement, a
 * coverage total or a state: the server derives them from the order's lines and
 * their allocations through the same helpers the shortage board uses, and a
 * second arithmetic in the browser is how two screens start disagreeing.
 *
 * Deliberately not a countdown. A live timer would redraw the page every second
 * to tell somebody something a date already tells them, and nothing in this CRM
 * ticks. The deadline is shown, and the state says which side of it the order is.
 */
export function ClockBoard({
  orders,
  canEdit,
  canReview,
  isAdmin,
}: {
  orders: ProcurementClockSummary[];
  /** PROCUREMENT EDIT — may submit an item-level delay reason. */
  canEdit: boolean;
  /** PROCUREMENT ASSIGN — may decide one, and may account for a late order. */
  canReview: boolean;
  /** May decide procurement's own reason. The API enforces this regardless. */
  isAdmin: boolean;
}) {
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  return (
    <ContentRegion fill={orders.length > 0}>
      <h2 className="shrink-0 text-sm font-semibold uppercase tracking-wider text-muted">
        Orders on the clock
      </h2>

      {orders.length === 0 ? (
        <Card>
          <EmptyState
            icon={Clock}
            title="No orders on the clock"
            description="Every sales order appears here with a procurement deadline two days after its order date."
          />
        </Card>
      ) : (
        <Card className={contentCard}>
          <ContentScrollArea>
            <div className="scroll-x">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Ordered</TableHead>
                    <TableHead>Due by</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">Lines short</TableHead>
                    <TableHead>Delay</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {orders.map((order) => (
                    <TableRow
                      key={order.orderId}
                      className="cursor-pointer"
                      onClick={() => startTransition(() => setOpenOrderId(order.orderId))}
                    >
                      <TableCell className="font-mono text-xs text-ink">
                        {order.orderNumber}
                      </TableCell>
                      <TableCell className="text-ink-2">{order.customerName}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted tabular">
                        {formatDate(order.orderDate)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted tabular">
                        {formatDate(order.deadline)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ClockStateBadge state={order.state} />
                          {order.orderStatus === 'CANCELLED' && (
                            <Badge variant="neutral">Cancelled</Badge>
                          )}
                          {/*
                            An estimate is labelled as one. These are orders that
                            were already covered before the clock existed, partly
                            by hand, so the completion instant was never recorded
                            and the migration could only infer it.
                          */}
                          {order.completionEstimated && (
                            <Badge variant="outline">Estimated</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-ink tabular">
                        {order.outstandingQty}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted tabular">
                        {order.outstandingLines}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {order.pendingPurchaseDelays > 0 && (
                            <Badge variant="warning">
                              {order.pendingPurchaseDelays} to approve
                            </Badge>
                          )}
                          {order.procurementDelayRequired && (
                            <Badge variant="critical">Reason needed</Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ContentScrollArea>
        </Card>
      )}

      {/*
        One dialog for the whole board rather than one per row: the per-line
        breakdown is fetched when it is opened, so a board of two hundred orders
        costs two hundred rows and not two hundred requests.
      */}
      <ClockDetailDialog
        orderId={openOrderId}
        open={openOrderId !== null}
        onOpenChange={(next) => setOpenOrderId(next ? openOrderId : null)}
        canEdit={canEdit}
        canReview={canReview}
        isAdmin={isAdmin}
      />
    </ContentRegion>
  );
}

/** Exported for the dialog's footer, so both spell a completion the same way. */
export function completionLine(order: ProcurementClockSummary): string | null {
  if (!order.completedAt) return null;
  const when = formatDateTime(order.completedAt);
  return order.completionEstimated
    ? `Covered around ${when} — estimated, because this order was completed before the clock existed`
    : `Covered ${when}`;
}
