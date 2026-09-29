import type { DispatchStatus, FulfillmentStatus, PartialDispatchStatus } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import type { PartialDispatchRequestView } from '@rs/shared';

/**
 * Status vocabulary for Packing & Dispatch.
 *
 * Colour carries the same meaning as everywhere else in the CRM: positive for
 * settled or complete, warning for in-flight, critical for a problem. The
 * readiness badges deliberately match Procurement's own FulfillmentBadge
 * wording, because they describe the same fact from the same figures — a line
 * that is PARTIAL on the shortage board must not read as something else here.
 */

const READINESS: Record<
  FulfillmentStatus,
  { label: string; variant: 'critical' | 'warning' | 'positive' }
> = {
  UNFULFILLED: { label: 'Unfulfilled', variant: 'critical' },
  PARTIAL: { label: 'Partial', variant: 'warning' },
  FULFILLED: { label: 'Ready', variant: 'positive' },
};

/** One line's readiness. */
export function ReadinessBadge({ status }: { status: FulfillmentStatus }) {
  const { label, variant } = READINESS[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * A whole order's readiness, from the two booleans the board reports.
 *
 * Derived from `fullyReady`/`partiallyReady` rather than from a third stored
 * field, because those are what the API actually sends — and the order of the
 * checks matters: fully ready wins, then partial, then nothing.
 */
export function OrderReadinessBadge({
  fullyReady,
  partiallyReady,
}: {
  fullyReady: boolean;
  partiallyReady: boolean;
}) {
  if (fullyReady) return <Badge variant="positive">Ready</Badge>;
  if (partiallyReady) return <Badge variant="warning">Partial</Badge>;
  return <Badge variant="critical">Unfulfilled</Badge>;
}

const DISPATCH_STATE: Record<
  DispatchStatus,
  { label: string; variant: 'neutral' | 'warning' | 'positive' | 'critical' | 'accent' }
> = {
  DRAFT: { label: 'Draft', variant: 'neutral' },
  PACKING: { label: 'Packing', variant: 'warning' },
  PACKED: { label: 'Packed', variant: 'accent' },
  DISPATCHED: { label: 'Dispatched', variant: 'positive' },
  CANCELLED: { label: 'Cancelled', variant: 'critical' },
};

export function DispatchStatusBadge({ status }: { status: DispatchStatus }) {
  const { label, variant } = DISPATCH_STATE[status];
  return <Badge variant={variant}>{label}</Badge>;
}

const PARTIAL_STATE: Record<
  PartialDispatchStatus,
  { label: string; variant: 'neutral' | 'warning' | 'positive' | 'critical' }
> = {
  PENDING: { label: 'Awaiting decision', variant: 'warning' },
  ALLOWED: { label: 'Allowed', variant: 'positive' },
  DISALLOWED: { label: 'Refused', variant: 'critical' },
  MOOT: { label: 'No longer needed', variant: 'neutral' },
};

/**
 * A partial-dispatch request's state.
 *
 * The automatic allow gets its own label rather than reading as an ordinary
 * "Allowed", and that distinction is the point: nobody agreed to it. A badge
 * saying only "Allowed" would let a reader assume Procurement approved the
 * shipment when in fact they never answered, so the two cases are never
 * rendered with the same words.
 */
export function PartialRequestBadge({ request }: { request: PartialDispatchRequestView }) {
  if (request.status === 'ALLOWED' && request.autoDecided) {
    return <Badge variant="warning">Auto-allowed</Badge>;
  }

  const { label, variant } = PARTIAL_STATE[request.status];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * The sentence that explains an automatic allow.
 *
 * Exported as a constant so the dialog, the detail panel and the tests all use
 * one wording. It states the *absence* of a decision and never invents a
 * reason, because the request carries none — `reason` is null by database
 * constraint on every automatic allow.
 */
export const AUTO_ALLOWED_EXPLANATION =
  'Auto-allowed — no Procurement response received within 24 hours.';
