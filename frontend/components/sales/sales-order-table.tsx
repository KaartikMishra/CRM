'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ImageIcon } from 'lucide-react';
import type { SalesOrderSummary } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EfficiencyBadge } from '@/components/common/status-badge';
import { SalesStatusBadge } from './sales-status-badge';
import { formatCurrency, formatDate, label } from '@/lib/format';

/**
 * The working list.
 *
 * A whole row is clickable for speed, but each row also carries a real link so
 * keyboard users and middle-click both behave the way they should. The link
 * targets the internal record id, never the manually entered order number.
 */
export function SalesOrderTable({ orders }: { orders: SalesOrderSummary[] }) {
  const router = useRouter();

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-14">Item</TableHead>
          <TableHead>Order</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Pending</TableHead>
          <TableHead>Dispatch by</TableHead>
          <TableHead>Efficiency</TableHead>
          <TableHead className="text-right">Ordered</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {orders.map((order) => (
          <TableRow
            key={order.id}
            onClick={() => router.push(`/sales/${order.id}`)}
            className="cursor-pointer"
          >
            <TableCell>
              {order.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={order.thumbnail.secureUrl}
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
              <Link
                href={`/sales/${order.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono text-[13px] font-medium text-ink tabular hover:text-accent"
              >
                {order.orderId}
              </Link>
              <span className="mt-0.5 block max-w-48 truncate text-xs text-muted">
                {order.leadProductName}
              </span>
            </TableCell>

            <TableCell>
              <span className="block font-medium text-ink">{order.customer.name}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {label(order.customer.type)} · {order.money.activeItemCount} line
                {order.money.activeItemCount === 1 ? '' : 's'}
              </span>
            </TableCell>

            <TableCell>
              <SalesStatusBadge status={order.status} />
            </TableCell>

            <TableCell className="text-right">
              <span className="block font-mono text-sm text-ink tabular">
                {formatCurrency(order.money.total, order.money.currency)}
              </span>
              <span className="mt-0.5 block text-xs text-muted tabular">
                {formatCurrency(order.money.paid, order.money.currency)} paid
              </span>
            </TableCell>

            <TableCell className="text-right">
              {order.money.fullyPaid ? (
                <span className="font-mono text-sm text-positive tabular">Settled</span>
              ) : (
                <span className="font-mono text-sm text-warning tabular">
                  {formatCurrency(order.money.pending, order.money.currency)}
                </span>
              )}
            </TableCell>

            <TableCell>
              <span className="block text-sm tabular">{formatDate(order.toBeDispatchedBy)}</span>
              {order.overdue && (
                <span className="mt-0.5 block text-xs font-medium text-critical">Overdue</span>
              )}
            </TableCell>

            <TableCell>
              <EfficiencyBadge efficiency={order.efficiency} breached={order.overdue} />
            </TableCell>

            <TableCell className="text-right">
              <span className="block text-sm tabular">{formatDate(order.orderDate)}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
