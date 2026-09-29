import Link from 'next/link';
import { PackageSearch } from 'lucide-react';
import type { DispatchSummary } from '@rs/shared';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ContentScrollArea, contentCard } from '@/components/common/content-page';
import { EmptyState } from '@/components/common/empty-state';
import { formatDate } from '@/lib/format';
import { DispatchStatusBadge, OrderReadinessBadge, PartialRequestBadge } from './dispatch-badges';
import { deadlineCountdown } from './dispatch-logic';

/**
 * The dispatch board: what is worth a dispatcher's attention today.
 *
 * Ordered by promise date rather than by readiness, deliberately. The question
 * a dispatcher opens this with is "what is due", and an order that is fully
 * ready but not due for a week matters less than one due tomorrow with half its
 * lines short.
 *
 * Every figure comes from the API. There is no arithmetic in this file beyond
 * reading the countdown helper, which only turns one instant into words.
 */
/**
 * Keeps a long delivery address from stretching the row.
 *
 * The full address is on the detail page, where the parcel is actually
 * addressed; the board only needs enough to recognise it.
 */
function truncate(value: string, max = 42): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function DispatchBoard({ orders }: { orders: DispatchSummary[] }) {
  if (orders.length === 0) {
    return (
      <Card className={contentCard}>
        <CardContent className="p-0">
          <EmptyState
            icon={PackageSearch}
            title="Nothing to dispatch"
            description="Orders appear here once they are open and not yet fully sent."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={contentCard}>
      <CardContent className="p-0">
        <ContentScrollArea>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Readiness</TableHead>
                {/*
                  Units, not lines. "Lines ready" counted only fully covered
                  lines, so an order with seven of ten units waiting to ship
                  read as "0 / 2" — the one number on the row that says there
                  is work to do, saying there is none.
                */}
                <TableHead className="text-right">Ready to send</TableHead>
                <TableHead>Shipment</TableHead>
                <TableHead>Partial request</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.salesOrderId}>
                  <TableCell>
                    <Link
                      href={`/dispatch/${order.salesOrderId}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {order.orderId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="block">{order.customerName}</span>
                    <span className="block text-xs text-muted tabular">
                      {formatDate(order.orderDate)}
                    </span>
                  </TableCell>
                  {/*
                    Phone and address decide whether the order can go at all —
                    both are hard blockers at dispatch — so a missing one is
                    called out here rather than discovered on the detail page.
                    A missing email is only a warning and is shown plainly.
                  */}
                  <TableCell className="text-xs">
                    <span className={order.customerPhone ? 'block tabular' : 'block text-critical'}>
                      {order.customerPhone ?? 'No phone'}
                    </span>
                    <span className={order.customerAddress ? 'block text-muted' : 'block text-critical'}>
                      {order.customerAddress ? truncate(order.customerAddress) : 'No address'}
                    </span>
                    <span className="block text-muted">{order.customerEmail ?? 'No email'}</span>
                  </TableCell>
                  <TableCell className="tabular">{formatDate(order.toBeDispatchedBy)}</TableCell>
                  <TableCell>
                    <OrderReadinessBadge
                      fullyReady={order.fullyReady}
                      partiallyReady={order.partiallyReady}
                    />
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {order.dispatchableQty > 0 ? (
                      <span className="font-medium">
                        {order.dispatchableQty} unit{order.dispatchableQty === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    <span className="block text-xs text-muted">
                      {order.readyLines}/{order.totalLines} lines complete
                    </span>
                  </TableCell>
                  <TableCell>
                    {order.latestDispatchStatus ? (
                      <DispatchStatusBadge status={order.latestDispatchStatus} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {order.pendingPartialRequest ? (
                      <span className="flex items-center gap-2">
                        <PartialRequestBadge request={order.pendingPartialRequest} />
                        {/*
                          The deadline matters on the board, not just on the
                          detail page: it is what tells a dispatcher whether a
                          question is about to answer itself.
                        */}
                        <span className="text-xs text-muted tabular">
                          {deadlineCountdown(order.pendingPartialRequest.deadline).label}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ContentScrollArea>
      </CardContent>
    </Card>
  );
}
