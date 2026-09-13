import Image from 'next/image';
import { ImageOff } from 'lucide-react';
import type { RsProductListRow } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ProductActions } from './product-actions';
import { ProductSourceBadge, ProductStatusBadge } from './product-badges';
import {
  EMPTY,
  formatDimensions,
  formatInventory,
  formatPriceRange,
  formatSku,
  formatVolume,
  formatWeight,
  isNegativeStock,
  truncateTitle,
  variantSummary,
} from './product-format';

/**
 * The catalogue.
 *
 * One row per product, not per variant: 465 of the 501 synced products have a
 * single variant, so a variant-per-row table would repeat most titles for no
 * gain. Where a product does have several, the row aggregates rather than
 * misreports — a price range, summed stock, and a badge saying how many.
 *
 * Not a Client Component: nothing here is interactive yet, so it renders on the
 * server and ships no JavaScript. A detail dialog in a later phase can make the
 * row clickable without changing this shape.
 */
export function RsProductTable({
  products,
  canEdit = false,
  canArchive = false,
}: {
  products: RsProductListRow[];
  canEdit?: boolean;
  canArchive?: boolean;
}) {
  const showActions = canEdit || canArchive;

  return (
    // The only horizontal scroll on the page is this container's — the body
    // itself must never scroll sideways.
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14">Image</TableHead>
            <TableHead className="min-w-[220px]">Product</TableHead>
            <TableHead className="hidden sm:table-cell">SKU</TableHead>
            <TableHead className="text-right">Price</TableHead>
            {/* Two stock figures, deliberately distinct: the CRM's own count
                and Shopify's. Merging them would hide which is which. */}
            <TableHead className="text-right">CRM stock</TableHead>
            <TableHead className="text-right">Shopify</TableHead>
            <TableHead className="hidden md:table-cell text-right">Weight</TableHead>
            <TableHead className="hidden lg:table-cell">Dimensions</TableHead>
            <TableHead className="hidden lg:table-cell text-right">Volume</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            {showActions && <TableHead className="w-12 text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>

        <TableBody>
          {products.map((product) => {
            const variants = variantSummary(product);

            return (
              <TableRow key={product.id}>
                <TableCell>
                  <ProductThumbnail url={product.imageUrl} alt={product.imageAlt ?? product.title} />
                </TableCell>

                <TableCell>
                  {/* The full title stays reachable on hover: the longest in the
                      catalogue runs to 222 characters and cannot be shown. */}
                  <span className="text-sm font-medium text-ink" title={product.title}>
                    {truncateTitle(product.title)}
                  </span>
                  {(variants ?? product.productType) && (
                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      {variants && <span>{variants}</span>}
                      {product.productType && <span>{product.productType}</span>}
                    </span>
                  )}
                </TableCell>

                <TableCell className="hidden sm:table-cell font-mono text-xs text-ink-2">
                  {formatSku(product)}
                </TableCell>

                <TableCell className="whitespace-nowrap text-right text-sm text-ink">
                  {formatPriceRange(product)}
                </TableCell>

                {/* CRM stock: hand-maintained, never written by Shopify. */}
                <TableCell className="text-right text-sm tabular-nums text-ink">
                  {product.crmStockQty.toLocaleString('en-IN')}
                </TableCell>

                <TableCell
                  className={cn(
                    'text-right text-sm tabular-nums',
                    // A negative quantity is a real oversell, not a rendering
                    // error — shown, and marked.
                    isNegativeStock(product) ? 'font-medium text-critical' : 'text-muted',
                  )}
                >
                  {formatInventory(product)}
                </TableCell>

                <TableCell className="hidden md:table-cell whitespace-nowrap text-right text-sm text-ink-2">
                  {formatWeight(product)}
                </TableCell>

                {/* Dimensions and volume read as a dash until the store's
                    dimension unit is confirmed. The formatters already handle
                    real values, so the columns start working without a change
                    here. */}
                <TableCell className="hidden lg:table-cell whitespace-nowrap text-sm text-muted">
                  {formatDimensions(product)}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap text-right text-sm text-muted">
                  {formatVolume(product)}
                </TableCell>

                <TableCell>
                  <ProductStatusBadge status={product.status} />
                </TableCell>
                <TableCell>
                  <ProductSourceBadge source={product.source} />
                </TableCell>

                {showActions && (
                  <TableCell className="text-right">
                    <ProductActions
                      product={product}
                      canEdit={canEdit}
                      canArchive={canArchive}
                    />
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Shopify's first product image.
 *
 * `next/image` with the CDN host declared in next.config.ts — it refuses an
 * unconfigured host outright, so the declaration is load-bearing. Every synced
 * product has at least one image; the fallback covers manual products, which
 * start with none.
 */
function ProductThumbnail({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <span
        className="grid size-10 place-items-center rounded-md border border-line bg-surface-2 text-muted"
        aria-label="No image"
        title="No image"
      >
        <ImageOff className="size-4" />
      </span>
    );
  }

  return (
    <Image
      src={url}
      alt={alt}
      width={40}
      height={40}
      className="size-10 rounded-md border border-line object-cover"
      // A catalogue page shows 50 of these; only the ones on screen matter.
      loading="lazy"
      unoptimized={false}
    />
  );
}

/** What an empty cell looks like, re-exported for tests and callers. */
export { EMPTY };
