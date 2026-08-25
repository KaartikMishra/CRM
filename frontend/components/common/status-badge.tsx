import type { EnquiryEfficiency, EnquiryProductStatus, EnquiryStatus } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { label } from '@/lib/format';

/**
 * Status and efficiency answer different questions — coverage versus timing —
 * so they never share a colour vocabulary. Status uses neutral/accent tones;
 * efficiency uses the semantic positive/critical pair.
 */

export function StatusBadge({ status }: { status: EnquiryStatus }) {
  const variant = status === 'OPEN' ? 'accent' : status === 'PARTIAL_CLOSED' ? 'warning' : 'neutral';
  return <Badge variant={variant}>{label(status)}</Badge>;
}

export function EfficiencyBadge({
  efficiency,
  breached,
}: {
  efficiency: EnquiryEfficiency | null;
  breached?: boolean;
}) {
  if (efficiency === null) {
    // Not yet answered: breached is a live fact, not a recorded verdict.
    return breached ? <Badge variant="critical">Overdue</Badge> : <Badge variant="outline">Awaiting</Badge>;
  }
  return (
    <Badge variant={efficiency === 'ON_TIME' ? 'positive' : 'critical'}>{label(efficiency)}</Badge>
  );
}

export function ProductStatusBadge({ status }: { status: EnquiryProductStatus }) {
  const variant =
    status === 'RESPONDED' ? 'positive' : status === 'NO_VENDOR' ? 'warning' : 'outline';
  return <Badge variant={variant}>{label(status)}</Badge>;
}
