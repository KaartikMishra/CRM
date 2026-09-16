import { ImageOff } from 'lucide-react';
import type { VendorMappingRow } from '@rs/shared';
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
import { MappingActions } from './mapping-actions';
import { mappingRate, mappingStatusLabel, truncateTitle } from './vendor-format';

/**
 * What this vendor supplies, and what they charge for it today.
 *
 * The rate here is the **current agreed rate** — a standing arrangement, not a
 * record of any particular purchase. The trade history above shows what was
 * actually billed. Keeping them in separate tables under separate headings is
 * the point: they are different numbers, they disagree routinely, and both are
 * correct.
 *
 * Archived mappings are shown rather than hidden, dimmed and marked, so that
 * reactivating one is possible without hunting for a filter — and so that the
 * same row comes back rather than somebody creating a duplicate.
 */
export function MappingTable({
  mappings,
  canEdit,
  canArchive,
}: {
  mappings: VendorMappingRow[];
  canEdit: boolean;
  canArchive: boolean;
}) {
  const showActions = canEdit || canArchive;

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14">Image</TableHead>
            <TableHead className="min-w-[220px]">Product</TableHead>
            {/* "Current" in the heading, always — it is not a billed rate. */}
            <TableHead className="whitespace-nowrap text-right">Current rate</TableHead>
            <TableHead>Status</TableHead>
            {showActions && <TableHead className="w-12 text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>

        <TableBody>
          {mappings.map((mapping) => (
            <TableRow key={mapping.id} className={cn(!mapping.isActive && 'opacity-70')}>
              <TableCell>
                <MappingThumbnail url={mapping.productImageUrl} alt={mapping.productTitle} />
              </TableCell>

              <TableCell>
                <span className="text-sm text-ink" title={mapping.productTitle}>
                  {truncateTitle(mapping.productTitle, 52)}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {mapping.productSource === 'SHOPIFY' ? 'Shopify' : 'CRM only'}
                  {mapping.productStatus !== 'ACTIVE' && ` · ${mapping.productStatus.toLowerCase()}`}
                </span>
              </TableCell>

              <TableCell className="whitespace-nowrap text-right text-sm font-medium text-ink">
                {mappingRate(mapping)}
              </TableCell>

              <TableCell>
                <Badge variant={mapping.isActive ? 'positive' : 'neutral'}>
                  {mappingStatusLabel(mapping)}
                </Badge>
              </TableCell>

              {showActions && (
                <TableCell className="text-right">
                  <MappingActions
                    mapping={mapping}
                    canEdit={canEdit}
                    canArchive={canArchive}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The product's own photograph, reused from the catalogue.
 *
 * Shopify's CDN is a declared remote host, but these thumbnails sit inside a
 * drawer alongside Cloudinary ones, so both take the same plain <img> path.
 * Nothing is uploaded and nothing is copied into Cloudinary.
 */
function MappingThumbnail({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <span
        className="grid size-9 place-items-center rounded-md border border-line bg-surface-2 text-muted"
        aria-label="No image"
        title="No image"
      >
        <ImageOff className="size-4" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      loading="lazy"
      className="size-9 rounded-md border border-line object-cover"
    />
  );
}
