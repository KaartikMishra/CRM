import type { VendorListRow, VendorSummary, VendorTradeRow } from '@rs/shared';
import { formatCurrency, formatDate, formatTime } from '@/lib/format';

/**
 * Display helpers for Vendor Invoices.
 *
 * Pure functions, kept out of the components so the frontend's DOM-less test
 * suite can assert them directly. Nothing here computes a business figure:
 * `lineTotal` arrives from the backend already derived, and this file only
 * decides how it reads.
 */

/** What an unknown value looks like. One em dash, everywhere. */
export const EMPTY = '—';

/** A title long enough to break the table layout is trimmed, never silently. */
const TITLE_MAX = 70;

export function truncateTitle(title: string, max = TITLE_MAX): string {
  return title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`;
}

/** Any optional text field: a blank string is as absent as null. */
export function orDash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : EMPTY;
}

/**
 * The vendor's primary number, which this module treats as WhatsApp.
 *
 * Separate from `altPhone` deliberately: staff ring one and message the other,
 * and collapsing them would lose which is which.
 */
export const whatsappNumber = (vendor: Pick<VendorListRow, 'phone'>): string =>
  orDash(vendor.phone);

export const additionalNumber = (vendor: Pick<VendorListRow, 'altPhone'>): string =>
  orDash(vendor.altPhone);

/** "Active" / "Archived" — the vendor's own state, not a product's. */
export const vendorStatusLabel = (vendor: Pick<VendorListRow, 'isActive'>): string =>
  vendor.isActive ? 'Active' : 'Archived';

/**
 * How many products this vendor supplies.
 *
 * Counted by the backend over *active* mappings only, so an archived mapping
 * does not inflate it.
 */
export function mappedProductsLabel(count: number): string {
  if (count === 0) return 'No products mapped';
  return count === 1 ? '1 product mapped' : `${count} products mapped`;
}

/** A vendor's display line under their name: company, then city. */
export function vendorSubtitle(
  vendor: Pick<VendorListRow, 'companyName' | 'city'>,
): string | null {
  const parts = [vendor.companyName, vendor.city]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The drawer's title. Named for the vendor, because that is what it is about. */
export const tradesTitle = (vendor: Pick<VendorSummary, 'name'>): string =>
  `Trades with ${vendor.name}`;

// ---------------------------------------------------------------------------
//  Trade history
// ---------------------------------------------------------------------------

/** The bill's own date, as printed on it. */
export const tradeBillDate = (trade: Pick<VendorTradeRow, 'billDate'>): string =>
  formatDate(trade.billDate);

/**
 * The time the line was recorded in the CRM.
 *
 * `recordedAt` is a real timestamp, so this is a genuine fact rather than a
 * stand-in for a bill time nobody captured. If it were ever missing, the column
 * reads as a dash — an invented time would be worse than no time.
 */
export function tradeTime(trade: Pick<VendorTradeRow, 'recordedAt'>): string {
  if (!trade.recordedAt) return EMPTY;
  const parsed = new Date(trade.recordedAt);
  return Number.isNaN(parsed.getTime()) ? EMPTY : formatTime(trade.recordedAt);
}

/** A quantity. Zero is a real answer and is shown as one. */
export const formatQty = (qty: number): string => qty.toLocaleString('en-IN');

/**
 * What this purchase actually cost per unit.
 *
 * Historical, and never the mapping's current rate: they are different numbers
 * about different moments, which is why they never share a column.
 */
export const historicalRate = (trade: Pick<VendorTradeRow, 'rate'>): string =>
  formatCurrency(trade.rate);

/** rate × ordered quantity, exactly as the backend derived it. */
export const tradeLineTotal = (trade: Pick<VendorTradeRow, 'lineTotal'>): string =>
  formatCurrency(trade.lineTotal);

/**
 * Whether a delivery fell short of what was ordered.
 *
 * Surfaced rather than hidden: a short receipt is a fact about the trade, and
 * somebody reviewing a vendor needs to see it.
 */
export const isShortReceipt = (
  trade: Pick<VendorTradeRow, 'orderedQty' | 'receivedQty'>,
): boolean => trade.receivedQty < trade.orderedQty;

// ---------------------------------------------------------------------------
//  Mappings
// ---------------------------------------------------------------------------

/**
 * The agreed rate today.
 *
 * Labelled "current" wherever it appears, so it cannot be mistaken for what a
 * past purchase cost.
 */
export const mappingRate = (mapping: { currentRate: string }): string =>
  formatCurrency(mapping.currentRate);

export const mappingStatusLabel = (mapping: { isActive: boolean }): string =>
  mapping.isActive ? 'Active' : 'Archived';
