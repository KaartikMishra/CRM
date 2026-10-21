import type { ShopifyVariantView } from '@rs/shared';
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
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">CRM stock</TableHead>
          <TableHead className="text-right">Shopify</TableHead>
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

            {/* CRM stock: maintained by hand, never written by a Shopify sync. */}
            <TableCell className="text-right text-sm tabular-nums text-ink">
              {variant.crmStockQty.toLocaleString('en-IN')}
            </TableCell>

            {/* Shopify's sellable quantity. A negative figure is a real
                oversell, shown and marked rather than clamped to zero. */}
            <TableCell
              className={cn(
                'text-right text-sm tabular-nums',
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
