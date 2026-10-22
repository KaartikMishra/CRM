import type { InventoryAlertView, MonitoredVariantView } from '@rs/shared';
import { stockShortfall } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EMPTY } from './product-format';

/**
 * Inventory Alerts tables — monitored variants, and alert history.
 *
 * Presentational and server-rendered: no interactivity here, so they ship no
 * JavaScript. The controls that change things are client components beside
 * them.
 *
 * Every stock figure shown is `crmStockQty`. Shopify's `inventoryQty` appears
 * only in its own clearly-labelled column, never in a threshold comparison —
 * the two numbers answer different questions.
 */

/** A variant's identity, when the SKU cannot provide one on its own. */
export function variantLabel(row: {
  sku: string | null;
  variantTitle: string | null;
}): string {
  // 5 SKU groups repeat in the live catalogue and 2 variants have none, so the
  // SKU is shown but never relied on alone.
  if (row.sku && row.variantTitle && row.variantTitle !== 'Default Title') {
    return `${row.sku} · ${row.variantTitle}`;
  }
  if (row.sku) return row.sku;
  if (row.variantTitle && row.variantTitle !== 'Default Title') return row.variantTitle;
  return EMPTY;
}

/** The state of one configuration, as a single word. */
export function monitorState(row: MonitoredVariantView): 'Alerting' | 'Paused' | 'Removed' | 'OK' {
  if (row.archivedAt !== null) return 'Removed';
  if (!row.isActive) return 'Paused';
  return row.activeAlert ? 'Alerting' : 'OK';
}

export function MonitoredTable({
  rows,
  canEdit,
}: {
  rows: MonitoredVariantView[];
  canEdit: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No variants are being monitored yet. Add one to start watching its CRM stock.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[200px]">Product</TableHead>
          <TableHead className="min-w-[150px]">Variant</TableHead>
          {/* The CRM count the threshold is compared against. */}
          <TableHead className="text-right">CRM stock</TableHead>
          <TableHead className="text-right">Threshold</TableHead>
          <TableHead className="text-right">Short by</TableHead>
          {/* Shopify's own figure, shown apart so the two are never conflated. */}
          <TableHead className="hidden md:table-cell text-right">Shopify qty</TableHead>
          <TableHead>State</TableHead>
          <TableHead className="hidden lg:table-cell text-right">Lifecycles</TableHead>
          {canEdit && <TableHead className="w-12" />}
        </TableRow>
      </TableHeader>

      <TableBody>
        {rows.map((row) => {
          const state = monitorState(row);
          const short = row.activeAlert ? stockShortfall(row.crmStockQty, row.threshold) : 0;

          return (
            <TableRow key={row.id}>
              <TableCell className="text-sm text-ink" title={row.productTitle}>
                {row.productTitle}
              </TableCell>

              <TableCell className="font-mono text-xs text-ink-2">{variantLabel(row)}</TableCell>

              <TableCell
                className={cn(
                  'text-right text-sm tabular-nums',
                  // A negative CRM stock should be impossible; marked, never hidden.
                  row.crmStockQty < 0 ? 'font-medium text-critical' : 'text-ink',
                )}
              >
                {row.crmStockQty.toLocaleString('en-IN')}
              </TableCell>

              <TableCell className="text-right text-sm tabular-nums text-muted">
                {row.threshold.toLocaleString('en-IN')}
              </TableCell>

              <TableCell className="text-right text-sm tabular-nums text-warning">
                {short > 0 ? short.toLocaleString('en-IN') : EMPTY}
              </TableCell>

              <TableCell className="hidden md:table-cell text-right text-sm tabular-nums text-muted">
                {row.inventoryQty.toLocaleString('en-IN')}
              </TableCell>

              <TableCell>
                <Badge
                  variant={
                    state === 'Alerting'
                      ? 'critical'
                      : state === 'Removed'
                        ? 'outline'
                        : state === 'Paused'
                          ? 'outline'
                          : 'positive'
                  }
                >
                  {state}
                </Badge>
              </TableCell>

              <TableCell className="hidden lg:table-cell text-right text-xs tabular-nums text-muted">
                {row.alertCount}
              </TableCell>

              {canEdit && <TableCell />}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Why an alert ended, in words rather than an enum. */
export function resolutionLabel(alert: InventoryAlertView): string {
  if (alert.status === 'ACTIVE') return 'Active';
  switch (alert.resolution) {
    case 'STOCK_RECOVERED':
      return 'Stock recovered';
    case 'MONITORING_DISABLED':
      return 'Monitoring switched off';
    case 'THRESHOLD_CHANGED':
      return 'Threshold changed';
    case 'VARIANT_REMOVED':
      return 'Variant removed';
    default:
      return 'Resolved';
  }
}

export function AlertHistoryTable({ rows }: { rows: InventoryAlertView[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No alerts have been raised yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[200px]">Product</TableHead>
          <TableHead className="min-w-[110px]">SKU</TableHead>
          <TableHead className="text-right">Stock</TableHead>
          <TableHead className="text-right">Threshold</TableHead>
          <TableHead>Raised</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead className="hidden lg:table-cell">Resolved</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {rows.map((a) => (
          <TableRow key={a.id}>
            {/*
              The snapshot, not a live lookup. This is what makes history
              readable after a Shopify sync deletes the variant: the title and
              SKU recorded at the moment the alert was raised.
            */}
            <TableCell className="text-sm text-ink">
              {a.productTitleAtRaise}
              {a.variantId === null && (
                <span className="ml-2 text-[11px] text-muted">(variant since removed)</span>
              )}
            </TableCell>

            <TableCell className="font-mono text-xs text-ink-2">{a.skuAtRaise ?? EMPTY}</TableCell>

            <TableCell className="text-right text-sm tabular-nums text-ink">
              {a.stockAtRaise.toLocaleString('en-IN')}
            </TableCell>

            <TableCell className="text-right text-sm tabular-nums text-muted">
              {a.thresholdAtRaise.toLocaleString('en-IN')}
            </TableCell>

            <TableCell className="whitespace-nowrap text-xs text-muted">
              {new Date(a.raisedAt).toLocaleString('en-IN')}
            </TableCell>

            <TableCell>
              <Badge variant={a.status === 'ACTIVE' ? 'critical' : 'outline'}>
                {resolutionLabel(a)}
              </Badge>
            </TableCell>

            <TableCell className="hidden lg:table-cell whitespace-nowrap text-xs text-muted">
              {a.resolvedAt ? new Date(a.resolvedAt).toLocaleString('en-IN') : EMPTY}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
