'use client';

import { useRouter } from 'next/navigation';
import { AlertTriangle, Info } from 'lucide-react';
import type { DispatchDetail } from '@rs/shared';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/format';
import { OrderReadinessBadge, ReadinessBadge } from './dispatch-badges';
import { dispatchableQty } from './dispatch-logic';
import { PartialDispatchPanel } from './partial-dispatch-panel';
import { ShipmentPanel } from './shipment-panel';

/**
 * One order's dispatch picture.
 *
 * A client component because everything under it mutates — packing a parcel,
 * asking about a partial dispatch, deciding one — and all of those need to
 * refresh the same server-rendered data afterwards. `router.refresh()` is that
 * refresh: it re-runs the page on the server, so what comes back is the API's
 * current answer rather than a client-side guess at what changed.
 */
export function OrderDetail({
  detail,
  canCreate,
  canEdit,
  canAssign,
  isAdmin,
}: {
  detail: DispatchDetail;
  canCreate: boolean;
  canEdit: boolean;
  canAssign: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const { readiness, customer } = detail;

  return (
    <div className="flex flex-col gap-4">
      {/*
        Blockers first, because they stop the parcel. The API refuses the
        dispatch itself on these same three fields, so this is a warning ahead
        of time rather than a second rule.
      */}
      {readiness.blockers.length > 0 && (
        <Card className="border-critical/30 bg-critical-soft">
          <CardContent className="flex gap-2.5 p-4 text-sm text-critical">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">This order cannot be dispatched yet.</p>
              <ul className="mt-1 list-disc pl-4">
                {readiness.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Warnings never block. A customer with no email on file still gets
          their parcel; somebody just cannot be emailed about it. */}
      {readiness.warnings.length > 0 && (
        <Card className="border-warning/30 bg-warning-soft">
          <CardContent className="flex gap-2.5 p-4 text-sm text-warning">
            <Info className="mt-0.5 size-4 shrink-0" />
            <ul>
              {readiness.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
          <div>
            <h2 className="text-sm font-medium text-ink">Deliver to</h2>
            <p className="mt-1 text-sm text-ink">{customer.name}</p>
            {customer.companyName && (
              <p className="text-sm text-muted">{customer.companyName}</p>
            )}
            <p className="mt-1 whitespace-pre-line text-sm text-muted">
              {customer.address ?? 'No address on file'}
            </p>
            <p className="mt-1 text-sm text-muted tabular">
              {customer.phone ?? 'No phone on file'}
            </p>
            <p className="text-sm text-muted">{customer.email ?? 'No email on file'}</p>
          </div>

          <div className="sm:text-right">
            <h2 className="text-sm font-medium text-ink">Order</h2>
            <p className="mt-1 text-sm text-muted">
              Placed {formatDate(detail.orderDate)}
            </p>
            <p className="text-sm text-muted">
              Due {formatDate(detail.toBeDispatchedBy)}
            </p>
            <p className="mt-2">
              <OrderReadinessBadge
                fullyReady={readiness.fullyReady}
                partiallyReady={readiness.partiallyReady}
              />
            </p>
            {/* Shown for context only — dispatch does not gate on payment. */}
            <p className="mt-2 text-sm text-muted tabular">
              {formatCurrency(detail.paidAmount)} paid of {formatCurrency(detail.orderTotal)}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {/*
            No scroll wrapper here on purpose.

            `Table` already provides its own `.scroll-x` container, so the nine
            columns scroll sideways on a narrow screen without anything added.
            A `ContentScrollArea` around it was actively harmful: that component
            claims height with `lg:flex-1` and then scrolls vertically, which
            only works inside a bounded `ContentPage`/`ContentRegion`. This page
            is auto-height and scrolls through the shell's own `<main>`, so the
            wrapper had no height to resolve against and cut the page off
            instead of extending it.
          */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Required</TableHead>
                <TableHead className="text-right">Ready</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Can send</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {readiness.lines.map((line) => (
                <TableRow key={line.salesOrderItemId}>
                  <TableCell className="tabular text-muted">{line.lineNo}</TableCell>
                  <TableCell>
                    <span className="block">{line.productName}</span>
                    {/* A free-text line, or a product whose variant carries no
                        SKU, shows nothing rather than a invented placeholder. */}
                    {line.sku && (
                      <span className="block text-xs text-muted tabular">{line.sku}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">{line.requiredQty}</TableCell>
                  <TableCell className="tabular text-right">{line.readyQty}</TableCell>
                  <TableCell className="tabular text-right">{line.pendingQty}</TableCell>
                  <TableCell className="tabular text-right">{line.dispatchedQty}</TableCell>
                  <TableCell className="tabular text-right font-medium">
                    {dispatchableQty(line)}
                  </TableCell>
                  <TableCell>
                    <ReadinessBadge status={line.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PartialDispatchPanel
        detail={detail}
        canCreate={canCreate}
        canAssign={canAssign}
        isAdmin={isAdmin}
        onChanged={refresh}
      />

      <ShipmentPanel
        detail={detail}
        canCreate={canCreate}
        canEdit={canEdit}
        onChanged={refresh}
      />
    </div>
  );
}
