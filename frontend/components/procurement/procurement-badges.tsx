import type {
  BillApprovalStatus,
  DelayReasonStatus,
  FulfillmentStatus,
  ProcurementClockState,
  PurchaseBillStatus,
  PurchaseBillType,
} from '@rs/shared';
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

/**
 * Whether a bill has been signed off — a separate badge from the status one
 * above, because they say separate things. That one reports how much of the
 * goods have arrived; this reports whether the bill is trusted. A bill can be
 * fully Received and still Pending approval, and both badges then show at once,
 * which is the honest reading of its state.
 *
 * Approved renders as nothing. Once the queue is cleared it is the ordinary
 * case, and a green tick on every row would leave nothing for the eye to catch.
 */
export function BillApprovalBadge({ status }: { status: BillApprovalStatus }) {
  if (status === 'APPROVED') return null;
  return (
    <Badge variant={status === 'REJECTED' ? 'critical' : 'warning'}>
      {status === 'REJECTED' ? 'Rejected' : 'Awaiting approval'}
    </Badge>
  );
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

/**
 * Where an order stands on the procurement clock.
 *
 * Four labels, and the two delayed ones are deliberately worded apart because
 * they mean different things to act on: "Late, still short" is an order that
 * still owes goods and somebody has to buy them; "Covered late" is an order that
 * got them, after the deadline, and now needs explaining. Collapsing them into
 * one amber "Delayed" would hide which of the two a reader is looking at.
 *
 * Null on a cancelled order — its clock has stopped, so it is neither fulfilled
 * nor accruing delay, and the order's own Cancelled badge says the rest.
 */
const CLOCK_STATE: Record<
  ProcurementClockState,
  { label: string; variant: 'neutral' | 'warning' | 'positive' | 'critical' }
> = {
  UNFULFILLED: { label: 'Unfulfilled', variant: 'warning' },
  UNFULFILLED_WITH_DELAY: { label: 'Late, still short', variant: 'critical' },
  FULFILLED_ON_TIME: { label: 'Covered on time', variant: 'positive' },
  FULFILLED_DELAYED: { label: 'Covered late', variant: 'warning' },
};

export function ClockStateBadge({ state }: { state: ProcurementClockState | null }) {
  if (!state) return null;
  const { label: text, variant } = CLOCK_STATE[state];
  return <Badge variant={variant}>{text}</Badge>;
}

/** A delay reason's decision. Pending is the one worth catching the eye. */
export function DelayReasonBadge({ status }: { status: DelayReasonStatus }) {
  const map = {
    PENDING: { label: 'Awaiting approval', variant: 'warning' as const },
    APPROVED: { label: 'Approved', variant: 'positive' as const },
    REJECTED: { label: 'Rejected', variant: 'critical' as const },
  };
  const { label: text, variant } = map[status];
  return <Badge variant={variant}>{text}</Badge>;
}
