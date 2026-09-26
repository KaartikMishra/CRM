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
  /*
    CANCELLED is critical rather than neutral, and deliberately not the same
    quiet tone as CLOSED. Both are terminal, but one means settled and the other
    means called off — reading them alike on a list is how somebody chases an
    order that is not coming.
  */
  const variant =
    status === 'OPEN'
      ? 'accent'
      : status === 'DISPATCHED'
        ? 'warning'
        : status === 'CANCELLED'
          ? 'critical'
          : 'neutral';
  return <Badge variant={variant}>{label(status)}</Badge>;
}
