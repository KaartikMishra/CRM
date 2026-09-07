import type { FulfillmentStatus, PurchaseBillStatus, PurchaseBillType } from '@rs/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Status vocabulary for Purchase & Procurement.
 *
 * Colour carries meaning consistently with the rest of the CRM: positive for
 * settled or complete, warning for in-flight, critical for a problem. Standing
 * and pending get deliberately different treatments — they are the two numbers
 * the module exists to keep apart, so they must never look alike.
 */

const BILL_STATUS: Record<PurchaseBillStatus, { label: string; variant: 'neutral' | 'warning' | 'positive' }> = {
  OPEN: { label: 'Open', variant: 'warning' },
  RECEIVED: { label: 'Received', variant: 'positive' },
  CLOSED: { label: 'Closed', variant: 'neutral' },
};

export function BillStatusBadge({ status }: { status: PurchaseBillStatus }) {
  const { label, variant } = BILL_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export function BillTypeBadge({ type }: { type: PurchaseBillType }) {
  return (
    <Badge variant={type === 'PAID_UP' ? 'positive' : 'outline'}>
      {type === 'PAID_UP' ? 'Paid Up' : 'Credit'}
    </Badge>
  );
}

const FULFILLMENT: Record<FulfillmentStatus, { label: string; variant: 'critical' | 'warning' | 'positive' }> = {
  UNFULFILLED: { label: 'Unfulfilled', variant: 'critical' },
  PARTIAL: { label: 'Partial', variant: 'warning' },
  FULFILLED: { label: 'Fulfilled', variant: 'positive' },
};

export function FulfillmentBadge({ status }: { status: FulfillmentStatus }) {
  const { label, variant } = FULFILLMENT[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Stock that has arrived and is not yet assigned to anyone.
 *
 * Shown as a positive quantity because it is an asset — the opposite reading of
 * a pending number, which is a debt to a customer.
 */
export function StandingQty({ qty }: { qty: number }) {
  return (
    <span className={qty > 0 ? 'font-medium text-positive tabular' : 'text-muted tabular'}>
      {qty}
    </span>
  );
}

/** What a customer is still owed. Zero is the good case here. */
export function PendingQty({ qty }: { qty: number }) {
  return (
    <span className={qty > 0 ? 'font-medium text-critical tabular' : 'text-positive tabular'}>
      {qty}
    </span>
  );
}
