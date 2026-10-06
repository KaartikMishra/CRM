import type { PostSalesCaseStatus, PostSalesPriority } from '@rs/shared';
import { POST_SALES_CASE_STATUS_LABELS, POST_SALES_PRIORITY_LABELS } from '@rs/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Status and priority vocabulary for Post Sales.
 *
 * Colour carries the same meaning as everywhere else in the CRM: positive for
 * settled well, warning for in-between, critical for a problem, neutral for "no
 * answer yet". The palette offers those four tokens and no literal green/amber/red
 * triad, so these maps are how the business's colours reach the screen.
 *
 * **Priority and status are two separate maps and must stay separate.** A case
 * awaiting a courier says nothing about how urgent it is, and a critical case may
 * be perfectly on track. Merging them would make one read as the other.
 */

/**
 * Where the case stands.
 *
 * `warning` for every blocked state, because waiting is the in-between: real work
 * is owed but not by us this minute. `neutral` for NEW — nobody has answered it yet
 * — and `critical` for REOPENED, which is a case that came back and the one status
 * somebody should look at twice.
 */
const STATUS: Record<PostSalesCaseStatus, 'positive' | 'warning' | 'critical' | 'neutral'> = {
  NEW: 'neutral',
  ASSIGNED: 'neutral',
  IN_PROGRESS: 'warning',
  AWAITING_CUSTOMER: 'warning',
  AWAITING_INTERNAL: 'warning',
  AWAITING_VENDOR: 'warning',
  AWAITING_COURIER: 'warning',
  RESOLUTION_IN_PROGRESS: 'warning',
  RESOLVED: 'positive',
  CLOSED: 'positive',
  REOPENED: 'critical',
};

export function CaseStatusBadge({ status }: { status: PostSalesCaseStatus }) {
  return <Badge variant={STATUS[status]}>{POST_SALES_CASE_STATUS_LABELS[status]}</Badge>;
}

/** How urgent somebody judged it. Set by hand; Phase 1 derives nothing. */
const PRIORITY: Record<PostSalesPriority, 'positive' | 'warning' | 'critical' | 'neutral'> = {
  LOW: 'neutral',
  MEDIUM: 'neutral',
  HIGH: 'warning',
  CRITICAL: 'critical',
};

export function CasePriorityBadge({ priority }: { priority: PostSalesPriority }) {
  return <Badge variant={PRIORITY[priority]}>{POST_SALES_PRIORITY_LABELS[priority]}</Badge>;
}
