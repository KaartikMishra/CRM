import type { ShopifyVariantView } from '@rs/shared';
import { formatINR, valueProduct, variantStockValue } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EMPTY, formatWeight } from './product-format';

/**
 * One row per variant — the view the catalogue table deliberately cannot give.
 *
 * The list collapses a product's variants into a price range and a summed
 * stock figure, which is right for a table of 501 products but leaves the 36
 * multi-variant ones unable to state their own SKUs, prices or quantities.
 * This is where those are read.
 *
 * Read-only by design: every field here is either Shopify's (overwritten by the
 * next sync) or edited through the existing edit form. Nothing is changed from
 * this table.
 *
 * Not a Client Component — nothing is interactive, so it ships no JavaScript.
 */

/** A money figure, matching `formatPriceRange`'s currency formatting. */
export function formatVariantPrice(price: string | null): string {
  if (price === null) return EMPTY;
  const value = Number(price);
  if (!Number.isFinite(value)) return EMPTY;

  return value.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A variant's own label.
 *
 * Shopify names a single-variant product's only variant "Default Title", which
 * says nothing to a reader. 465 of 501 products are in that position, so the
 * placeholder is suppressed rather than printed 465 times.
 */
export function formatVariantTitle(title: string | null): string {
  if (!title) return EMPTY;
  return title === 'Default Title' ? EMPTY : title;
}

/**
 * Money, including a negative figure.
 *
 * `formatINR` accepts only non-negative amounts — it is shared with Sales and
 * GST, where a negative total means an upstream invariant broke, so it throws
 * rather than rendering one. It is deliberately not weakened here.
 *
 * A negative value can still reach valuation: `crmStockSchema` forbids a
 * negative quantity, but the calculator does not clamp one if it somehow
 * exists, and `addAmount` propagates the sign into an aggregate. So the sign is
 * handled here and the magnitude formatted, keeping the anomaly visible.
 */
export function formatStockMoney(amount: string): string {
  return amount.startsWith('-') ? `-${formatINR(amount.slice(1))}` : formatINR(amount);
}

/**
 * One variant's stock value, or an explicit "unknown" when its cost is absent.
 *
 * The distinction is the point. An uncosted variant is NOT worth zero — zero
 * would read as "this stock is worthless" when the truth is "nobody has entered
 * its cost" — so the shared calculator returns null and this renders a dash.
 */
export function formatVariantStockValue(variant: ShopifyVariantView): string {
  const value = variantStockValue(variant);
  return value === null ? EMPTY : formatStockMoney(value);
}

/** Whether a quantity represents a real oversell, matching the catalogue rule. */
export const isNegativeVariantStock = (variant: Pick<ShopifyVariantView, 'inventoryQty'>): boolean =>
  variant.inventoryQty < 0;

export function VariantTable({ variants }: { variants: ShopifyVariantView[] }) {
  if (variants.length === 0) {
    /*
      No synced product is in this state — every one of the 501 carries at least
      one variant — but a row is reachable through the API, and an empty table
      with headings would read as a rendering fault rather than as an absence.
    */
    return <p className="text-sm text-muted">This product has no variants recorded.</p>;
  }

  return (
    // Table brings its own `.scroll-x` container; no second one is added here.
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12 text-right">#</TableHead>
          <TableHead className="min-w-[140px]">SKU</TableHead>
          <TableHead className="min-w-[140px]">Variant</TableHead>
          {/* Shopify's selling price, then the CRM's own cost — deliberately
              adjacent and separately labelled, because confusing the two would
              misstate every valuation on the page. */}
          <TableHead className="text-right">Shopify price</TableHead>
          <TableHead className="text-right">Cost price</TableHead>
          <TableHead className="text-right">CRM stock</TableHead>
          <TableHead className="text-right">Stock value</TableHead>
          <TableHead className="hidden md:table-cell text-right">Shopify qty</TableHead>
          <TableHead className="hidden md:table-cell text-right">Weight</TableHead>
          <TableHead className="hidden lg:table-cell">Shopify variant ID</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {variants.map((variant) => (
          <TableRow key={variant.id}>
            <TableCell className="text-right text-xs tabular-nums text-muted">
              {variant.position}
            </TableCell>

            <TableCell className="font-mono text-xs text-ink-2">{variant.sku ?? EMPTY}</TableCell>

            <TableCell className="text-sm text-ink">{formatVariantTitle(variant.title)}</TableCell>

            <TableCell className="whitespace-nowrap text-right text-sm text-ink">
              {formatVariantPrice(variant.price)}
            </TableCell>

            {/* Cost price: entered by hand in the CRM. A sync never overwrites
                it, and an absent one is shown as unknown — never as zero. */}
            <TableCell className="whitespace-nowrap text-right text-sm text-ink">
              {variant.costPrice === null ? (
                <span className="text-xs text-warning">Not set</span>
              ) : (
                formatVariantPrice(variant.costPrice)
              )}
            </TableCell>

            {/* CRM stock: maintained by hand, never written by a Shopify sync. */}
            <TableCell className="text-right text-sm tabular-nums text-ink">
              {variant.crmStockQty.toLocaleString('en-IN')}
            </TableCell>

            {/* costPrice x crmStockQty, computed by the shared valuation
                function the dashboard total also uses. */}
            <TableCell className="whitespace-nowrap text-right text-sm tabular-nums text-ink">
              {formatVariantStockValue(variant)}
            </TableCell>

            {/* Shopify's sellable quantity. A negative figure is a real
                oversell, shown and marked rather than clamped to zero. */}
            <TableCell
              className={cn(
                'hidden md:table-cell text-right text-sm tabular-nums',
                isNegativeVariantStock(variant) ? 'font-medium text-critical' : 'text-muted',
              )}
            >
              {variant.inventoryQty.toLocaleString('en-IN')}
            </TableCell>

            <TableCell className="hidden md:table-cell text-right text-sm text-muted">
              {formatWeight(variant)}
            </TableCell>

            {/* The identity to reconcile against Shopify admin. The SKU cannot
                serve: values repeat across the catalogue and some are absent. */}
            <TableCell className="hidden lg:table-cell font-mono text-[11px] text-muted">
              {variant.shopifyVariantId ?? EMPTY}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The product's own total, by the same rules as the dashboard's.
 *
 * `valueProduct` is the shared function the backend aggregation also calls, so
 * this figure and the dashboard's cannot disagree about one product.
 *
 * What is deliberately NOT shown is a single grand number when some costs are
 * missing. A total of ₹0.00 beside "3 variants need a cost price" is honest;
 * ₹0.00 alone would look like a finished answer.
 */
export function ProductStockValue({ variants }: { variants: ShopifyVariantView[] }) {
  const totals = valueProduct({ variants });

  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted">
          Total stock value
        </dt>
        <dd className="mt-1 font-mono text-xl font-medium tabular-nums text-ink">
          {formatStockMoney(totals.knownValue)}
        </dd>
      </div>

      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted">CRM units</dt>
        <dd className="mt-1 font-mono text-xl font-medium tabular-nums text-ink">
          {totals.totalUnits.toLocaleString('en-IN')}
        </dd>
      </div>

      {totals.incomplete && (
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-warning">
            Cost price missing
          </dt>
          <dd className="mt-1 text-sm text-warning">
            {totals.variantsMissingCost === 1
              ? '1 variant'
              : `${totals.variantsMissingCost} variants`}{' '}
            holding {totals.unitsWithUnknownCost.toLocaleString('en-IN')} units — their value is
            not included above.
          </dd>
        </div>
      )}
    </dl>
  );
}
