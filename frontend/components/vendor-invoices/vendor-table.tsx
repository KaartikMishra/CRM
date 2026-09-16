'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { VendorListRow } from '@rs/shared';
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
import { VendorActions } from './vendor-actions';
import {
  additionalNumber,
  mappedProductsLabel,
  orDash,
  truncateTitle,
  vendorStatusLabel,
  whatsappNumber,
} from './vendor-format';

/**
 * The vendor list.
 *
 * Opening a vendor writes their id to the URL rather than to component state,
 * so the drawer survives a refresh and is a shareable link — and so the drawer
 * itself can be rendered on the server, where it reads trade history without
 * shipping a second data-fetching path to the browser.
 *
 * A Client Component because the row opens that drawer and the actions menu is
 * interactive; the drawer's contents are rendered by the page, not here.
 */
export function VendorTable({
  vendors,
  canEdit,
  canArchive,
}: {
  vendors: VendorListRow[];
  canEdit: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const openVendor = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('vendorId', id);
    // A drawer opening on a different vendor must start at their first page of
    // trades and mappings, not wherever the last vendor's drawer was left.
    for (const key of ['tradeCursor', 'tradePages', 'mapCursor', 'mapPages']) {
      next.delete(key);
    }
    router.push(`/vendor-invoices?${next}`, { scroll: false });
  };

  return (
    // The only horizontal scroll on the page is this container's — the body
    // itself must never scroll sideways.
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[200px]">Name</TableHead>
            <TableHead className="min-w-[160px]">Company</TableHead>
            <TableHead className="hidden sm:table-cell">WhatsApp / Phone</TableHead>
            <TableHead className="hidden lg:table-cell">Additional number</TableHead>
            <TableHead className="hidden md:table-cell">Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-12 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {vendors.map((vendor) => (
            <TableRow
              key={vendor.id}
              className={cn(
                'cursor-pointer',
                // An archived vendor is shown, not hidden — their history is
                // still worth reading — but marked as no longer current.
                !vendor.isActive && 'opacity-70',
              )}
              onClick={() => openVendor(vendor.id)}
            >
              <TableCell>
                <button
                  type="button"
                  className="text-left text-sm font-medium text-ink hover:text-accent"
                  title={vendor.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    openVendor(vendor.id);
                  }}
                >
                  {truncateTitle(vendor.name, 40)}
                </button>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {mappedProductsLabel(vendor.mappedProductCount)}
                </span>
              </TableCell>

              <TableCell className="text-sm text-ink-2">
                {vendor.companyName ? truncateTitle(vendor.companyName, 40) : orDash(null)}
              </TableCell>

              <TableCell className="hidden sm:table-cell whitespace-nowrap text-sm text-ink-2">
                {whatsappNumber(vendor)}
              </TableCell>

              <TableCell className="hidden lg:table-cell whitespace-nowrap text-sm text-muted">
                {additionalNumber(vendor)}
              </TableCell>

              <TableCell className="hidden md:table-cell text-sm text-ink-2">
                {vendor.email ? truncateTitle(vendor.email, 32) : orDash(null)}
              </TableCell>

              <TableCell>
                <Badge variant={vendor.isActive ? 'positive' : 'neutral'}>
                  {vendorStatusLabel(vendor)}
                </Badge>
              </TableCell>

              {/* Stops a click on the menu from also opening the drawer. */}
              <TableCell
                className="text-right"
                onClick={(event) => event.stopPropagation()}
              >
                <VendorActions
                  vendor={vendor}
                  canEdit={canEdit}
                  canArchive={canArchive}
                  onViewTrades={() => openVendor(vendor.id)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
