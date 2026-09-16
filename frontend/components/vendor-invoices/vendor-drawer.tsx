import { Receipt, Tags } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorMessage } from '@/components/common/error-message';
import {
  fetchMappings,
  fetchVendor,
  fetchVendorTrades,
} from '@/lib/vendor-invoice-api';
import { VendorDrawerShell } from './vendor-drawer-shell';
import { TradeTable } from './trade-table';
import { MappingTable } from './mapping-table';
import { MapProductButton } from './map-product-button';
import { PaginationControls, decodeStack } from './pagination-controls';
import { orDash, tradesTitle, vendorStatusLabel, vendorSubtitle } from './vendor-format';

/**
 * Everything about one vendor: who they are, what was bought from them, and
 * what they charge today.
 *
 * A Server Component. The three reads happen on the server in parallel, so the
 * drawer arrives populated rather than opening empty and filling in — and no
 * second data-fetching path ships to the browser.
 *
 * The two rate figures are kept in separate sections on purpose. Trade history
 * shows what each bill actually charged; the mapping table shows the standing
 * agreement. They disagree routinely, and both are correct.
 */
export async function VendorDrawer({
  vendorId,
  filters,
  tradeCursor,
  tradeStack,
  mapCursor,
  mapStack,
  canEdit,
  canArchive,
  canCreate,
}: {
  vendorId: string;
  /** The list's own query state, preserved by the drawer's pagination links. */
  filters: Record<string, string | undefined>;
  tradeCursor?: string;
  tradeStack?: string;
  mapCursor?: string;
  mapStack?: string;
  canEdit: boolean;
  canArchive: boolean;
  canCreate: boolean;
}) {
  const [vendorResult, trades, mappings] = await Promise.all([
    fetchVendor(vendorId),
    fetchVendorTrades(vendorId, { cursor: tradeCursor }),
    fetchMappings({ vendorId, cursor: mapCursor }),
  ]);

  // A vendor that could not be read has no drawer to draw — the failure is
  // shown in the frame rather than as a blank panel.
  if (!vendorResult.success) {
    return (
      <VendorDrawerShell title="Vendor">
        <div className="p-5">
          <ErrorMessage message={vendorResult.message} code={vendorResult.code} />
        </div>
      </VendorDrawerShell>
    );
  }

  const vendor = vendorResult.data.vendor;

  return (
    <VendorDrawerShell
      title={tradesTitle(vendor)}
      subtitle={vendorSubtitle(vendor)}
    >
      <div className="space-y-6 p-5">
        {/* --- who they are ------------------------------------------------ */}
        <section aria-labelledby="vendor-details-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="vendor-details-heading"
              className="text-xs font-semibold uppercase tracking-[0.14em] text-accent"
            >
              Vendor details
            </h3>
            <Badge variant={vendor.isActive ? 'positive' : 'neutral'}>
              {vendorStatusLabel(vendor)}
            </Badge>
          </div>

          <dl className="mt-3 grid gap-x-6 gap-y-3 rounded-md border border-line bg-surface-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail label="Name" value={vendor.name} />
            <Detail label="Company" value={orDash(vendor.companyName)} />
            <Detail label="Contact person" value={orDash(vendor.contactPerson)} />
            <Detail label="WhatsApp / Phone" value={orDash(vendor.phone)} />
            <Detail label="Additional number" value={orDash(vendor.altPhone)} />
            <Detail label="Email" value={orDash(vendor.email)} />
            <Detail label="City" value={orDash(vendor.city)} />
            <Detail label="Address" value={orDash(vendor.address)} className="sm:col-span-2" />
          </dl>
        </section>

        {/* --- what was bought --------------------------------------------- */}
        <section aria-labelledby="trade-history-heading">
          <h3
            id="trade-history-heading"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-accent"
          >
            Trade history
          </h3>
          <p className="mt-1 text-xs text-muted">
            Purchases already recorded, at the rate each bill charged. Read-only — these are
            Procurement&apos;s own records.
          </p>

          <div className="mt-3 overflow-hidden rounded-md border border-line">
            {!trades.result.success ? (
              <div className="p-4">
                <ErrorMessage
                  message={trades.result.message}
                  code={trades.result.code}
                />
              </div>
            ) : trades.result.data.trades.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No purchases recorded yet"
                description="Bills raised against this vendor in Procurement will appear here."
              />
            ) : (
              <>
                <TradeTable trades={trades.result.data.trades} />
                <PaginationControls
                  stack={decodeStack(tradeStack)}
                  nextCursor={trades.meta.nextCursor ?? null}
                  filters={{ ...filters, vendorId, mapCursor, mapPages: mapStack }}
                  cursorKey="tradeCursor"
                  stackKey="tradePages"
                  basePath="/vendor-invoices"
                  label="Trade history pages"
                />
              </>
            )}
          </div>
        </section>

        {/* --- what they supply -------------------------------------------- */}
        <section aria-labelledby="mapping-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="mapping-heading"
              className="text-xs font-semibold uppercase tracking-[0.14em] text-accent"
            >
              Vendor Mapping with Products
            </h3>
            {canCreate && (
              <MapProductButton
                vendorId={vendor.id}
                vendorName={vendor.name}
                vendorIsActive={vendor.isActive}
              />
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            What this vendor supplies and the rate agreed today. Changing a rate here never alters
            a purchase already recorded above.
          </p>

          <div className="mt-3 overflow-hidden rounded-md border border-line">
            {!mappings.result.success ? (
              <div className="p-4">
                <ErrorMessage
                  message={mappings.result.message}
                  code={mappings.result.code}
                />
              </div>
            ) : mappings.result.data.mappings.length === 0 ? (
              <EmptyState
                icon={Tags}
                title="No products mapped yet"
                description={
                  canCreate
                    ? 'Map a product from the RS Products catalogue to record what this vendor supplies.'
                    : 'Nothing from the catalogue is mapped to this vendor.'
                }
              />
            ) : (
              <>
                <MappingTable
                  mappings={mappings.result.data.mappings}
                  canEdit={canEdit}
                  canArchive={canArchive}
                />
                <PaginationControls
                  stack={decodeStack(mapStack)}
                  nextCursor={mappings.meta.nextCursor ?? null}
                  filters={{ ...filters, vendorId, tradeCursor, tradePages: tradeStack }}
                  cursorKey="mapCursor"
                  stackKey="mapPages"
                  basePath="/vendor-invoices"
                  label="Product mapping pages"
                />
              </>
            )}
          </div>
        </section>
      </div>
    </VendorDrawerShell>
  );
}

function Detail({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{value}</dd>
    </div>
  );
}
