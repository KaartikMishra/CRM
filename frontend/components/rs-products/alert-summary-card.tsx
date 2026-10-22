import Link from 'next/link';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import type { InventoryAlertSummary } from '@rs/shared';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Active low-stock alerts, on the Admin Dashboard.
 *
 * Reads the same `/api/rs-products/alerts/summary` aggregation the Inventory
 * Alerts page shows, so the count here and the list there cannot disagree.
 *
 * Rendered whether or not the request succeeded. Hiding a card on failure makes
 * a broken backend indistinguishable from an unbuilt feature — the lesson from
 * the stock-valuation card, which did exactly that.
 */
export function AlertSummaryCard({
  summary,
  unavailable = false,
}: {
  summary?: InventoryAlertSummary;
  unavailable?: boolean;
}) {
  if (unavailable || !summary) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Stock alerts</p>
          <p className="mt-2 text-xs text-muted">
            Could not be loaded just now. No count is shown rather than a misleading zero.
          </p>
          <Link
            href="/rs-products/alerts"
            className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Inventory Alerts <ArrowRight className="size-3" />
          </Link>
        </CardContent>
      </Card>
    );
  }

  const alerting = summary.activeAlerts > 0;

  return (
    <Card>
      <CardContent className="p-5">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
          {alerting && <TriangleAlert className="size-3.5 text-critical" />}
          Stock alerts
        </p>

        <p
          className={
            alerting
              ? 'mt-2 font-mono text-3xl font-medium tabular-nums text-critical'
              : 'mt-2 font-mono text-3xl font-medium tabular-nums text-ink'
          }
        >
          {summary.activeAlerts.toLocaleString('en-IN')}
        </p>

        <p className="mt-1 text-xs text-muted">
          {alerting
            ? `${summary.totalShortfall.toLocaleString('en-IN')} units short across ${summary.monitoredVariants.toLocaleString('en-IN')} monitored variants`
            : `${summary.monitoredVariants.toLocaleString('en-IN')} variants monitored, none low`}
        </p>

        <Link
          href="/rs-products/alerts"
          className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          View alerts <ArrowRight className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
