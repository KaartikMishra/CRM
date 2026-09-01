import type { SalesOrderStatus } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { label } from '@/lib/format';

/**
 * The Sales lifecycle badge.
 *
 * Separate from the enquiry StatusBadge only because that one is typed to
 * EnquiryStatus. The tonal logic is deliberately identical: the live state takes
 * the accent, the in-progress state takes warning, and the terminal state goes
 * quiet — so the two modules read the same way at a glance.
 */
export function SalesStatusBadge({ status }: { status: SalesOrderStatus }) {
  const variant =
    status === 'OPEN' ? 'accent' : status === 'DISPATCHED' ? 'warning' : 'neutral';
  return <Badge variant={variant}>{label(status)}</Badge>;
}
