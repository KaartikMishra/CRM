import type {
  DimensionView,
  EnquirySource,
  EnquiryStatus,
  CustomerType,
  WeightView,
} from '@rs/shared';

/**
 * Display formatting only.
 *
 * Money arrives as an exact decimal string and is formatted for reading, never
 * parsed back into a number for arithmetic — the backend owns every calculation.
 */

const IST = 'Asia/Kolkata';

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: IST,
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: IST,
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: IST,
  });
}

/** ₹1,23,456.00 — Indian digit grouping. */
export function formatCurrency(amount: string, currency = 'INR'): string {
  const [whole = '0', fraction = '00'] = amount.split('.');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${grouped}.${fraction}`;
}

const trimZeros = (value: string): string => String(Number(value));

export function formatWeight(weight: WeightView | null): string {
  if (!weight) return '—';
  return `${trimZeros(weight.value)} ${weight.unit.toLowerCase()}`;
}

export function formatDimension(dimension: DimensionView | null): string {
  if (!dimension) return '—';
  const { length, width, height, unit } = dimension;
  return `${trimZeros(length)} × ${trimZeros(width)} × ${trimZeros(height)} ${unit.toLowerCase()}`;
}

/** mm:ss, or h:mm:ss past an hour. Never negative. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

const TITLE_CASE: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  CALL: 'Call',
  WEBSITE: 'Website',
  INDIAMART: 'IndiaMART',
  OTHERS: 'Others',
  RETAIL: 'Retail',
  BULK: 'Bulk',
  WEDDING_GIFTING: 'Wedding Gifting',
  CORPORATE_GIFTING: 'Corporate Gifting',
  OPEN: 'Open',
  PARTIAL_CLOSED: 'Partially Closed',
  DISPATCHED: 'Dispatched',
  CLOSED: 'Closed',
  PENDING: 'Pending',
  RESPONDED: 'Responded',
  NO_VENDOR: 'No Vendor',
  ON_TIME: 'On Time',
  DELAYED: 'Delayed',
  SIMILAR_PRODUCT: 'Similar Product',
  EXACT_PRODUCT: 'Exact Product',
  ADMIN: 'Admin',
  USER: 'User',
};

/** Enum values are SCREAMING_SNAKE; people are not. */
export function label(value: string | null | undefined): string {
  if (!value) return '—';
  return TITLE_CASE[value] ?? value.replace(/_/g, ' ').toLowerCase();
}

export const sourceLabel = (s: EnquirySource) => label(s);
export const statusLabel = (s: EnquiryStatus) => label(s);
export const customerTypeLabel = (t: CustomerType) => label(t);
