import { ImageOff } from 'lucide-react';
import type { VendorTradeRow } from '@rs/shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  formatQty,
  historicalRate,
  isShortReceipt,
  tradeBillDate,
  tradeLineTotal,
  tradeTime,
  truncateTitle,
} from './vendor-format';

/**
 * What the CRM has actually bought from this vendor.
 *
 * Every row is an existing PurchaseBillItem, read live from Procurement's own
 * records. Nothing here is stored by this module and nothing can be edited from
 * this module — there is no write path to a purchase line, by design.
 *
 * The rate column is the **historical** rate: what that particular bill
 * charged. It is deliberately in a different table, under a different heading,
 * from the mapping's current rate below — the two are different facts about
 * different moments, and a single "rate" column showing sometimes one and
 * sometimes the other would make both unreadable.
 *
 * A Server Component: nothing here is interactive.
 */
export function TradeTable({ trades }: { trades: VendorTradeRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[200px]">Product</TableHead>
            <TableHead className="w-14">Image</TableHead>
            <TableHead>Bill number</TableHead>
            <TableHead className="whitespace-nowrap">Bill date</TableHead>
            <TableHead className="whitespace-nowrap">Time</TableHead>
            <TableHead className="text-right">Ordered</TableHead>
            <TableHead className="text-right">Received</TableHead>
            {/* Named in full so it can never be read as the current rate. */}
            <TableHead className="whitespace-nowrap text-right">Rate (billed)</TableHead>
            <TableHead className="text-right">Line total</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {trades.map((trade) => (
            <TableRow key={trade.id}>
              <TableCell>
                <span className="text-sm text-ink" title={trade.productName}>
                  {truncateTitle(trade.productName, 48)}
                </span>
              </TableCell>

              <TableCell>
                <TradeThumbnail url={trade.productImageUrl} alt={trade.productName} />
              </TableCell>

              <TableCell className="whitespace-nowrap font-mono text-xs text-ink-2">
                {trade.billNumber}
              </TableCell>

              <TableCell className="whitespace-nowrap text-sm text-ink-2">
                {tradeBillDate(trade)}
              </TableCell>

              {/*
                When the line was recorded in the CRM — a real timestamp, not a
                stand-in for a bill time nobody wrote down. Reads as a dash if it
                is ever absent rather than showing an invented one.
              */}
              <TableCell className="whitespace-nowrap text-sm text-muted">
                {tradeTime(trade)}
              </TableCell>

              <TableCell className="text-right text-sm tabular-nums text-ink-2">
                {formatQty(trade.orderedQty)}
              </TableCell>

              <TableCell
                className={cn(
                  'text-right text-sm tabular-nums',
                  // A short delivery is a fact about the trade and is marked,
                  // not hidden.
                  isShortReceipt(trade) ? 'font-medium text-warning' : 'text-ink-2',
                )}
                title={isShortReceipt(trade) ? 'Received less than ordered' : undefined}
              >
                {formatQty(trade.receivedQty)}
              </TableCell>

              <TableCell className="whitespace-nowrap text-right text-sm text-ink">
                {historicalRate(trade)}
              </TableCell>

              <TableCell className="whitespace-nowrap text-right text-sm font-medium text-ink">
                {tradeLineTotal(trade)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The line's photograph, through the CRM's existing MediaAsset path.
 *
 * A plain <img>, matching how every other module renders a Cloudinary asset —
 * next/image is reserved for the Shopify CDN host declared in next.config.ts.
 * Nothing is uploaded here and nothing is copied into Cloudinary.
 */
function TradeThumbnail({ url, alt }: { url: string | null; alt: string }) {
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
