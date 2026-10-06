import type { DealStatus, LeadAnalyticsRow } from '@rs/shared';
import { DEAL_STATUS_LABELS, LEAD_PROMPTNESS_LABELS } from '@rs/shared';
import { Badge } from '@/components/ui/badge';

/**
 * Status vocabulary for Lead/Deal analytics.
 *
 * Colour carries the same meaning as everywhere else in the CRM: positive for
 * settled well, warning for in-between, critical for a problem, neutral for
 * "no answer yet". The palette has no literal green/yellow/red triad — these
 * four tokens are what it offers, and they map onto the business's colours
 * exactly.
 *
 * ### Deal status is not promptness
 *
 * Two separate vocabularies that happen to share a palette, and they are kept
 * apart deliberately — `DEAL` below and `PROMPTNESS_VARIANTS` further down are
 * two maps, never one. A deal in process is amber because it is unresolved; an
 * associate rated AVERAGE is amber because their score sits in the middle band.
 * Merging them would make "in process" imply something about somebody's
 * performance, which it says nothing about.
 */

/**
 * WON green, LOST red, INPROCESS amber.
 *
 * `warning` rather than `neutral` for INPROCESS: a deal being actively worked is
 * a real state with a colour the business named, not an absence of one. Neutral
 * is reserved for "no answer yet", which a deal in process is not — it is the
 * answer, mid-flight.
 */
const DEAL: Record<DealStatus, { variant: 'positive' | 'warning' | 'critical' }> = {
  WON: { variant: 'positive' },
  LOST: { variant: 'critical' },
  INPROCESS: { variant: 'warning' },
};

export function DealStatusBadge({ status }: { status: DealStatus }) {
  return <Badge variant={DEAL[status].variant}>{DEAL_STATUS_LABELS[status]}</Badge>;
}

/**
 * An associate's promptness, with the figures behind it.
 *
 * The rating alone is not enough on a table somebody acts on: "POOR" invites
 * the question "out of how many", and NOT_RATED invites "why". So the badge
 * carries the band and a line beneath carries the arithmetic.
 *
 * NOT_RATED never shows a percentage. There are two distinct reasons for it —
 * nothing measurable yet, and nobody to attribute it to — and showing 0% would
 * misread either one as bad performance.
 */
export function PromptnessBadge({
  promptness,
  hasAssociate,
}: {
  promptness: LeadAnalyticsRow['promptness'];
  hasAssociate: boolean;
}) {
  const { rating, expected, onTime, score, overdue } = promptness;

  const variant =
    rating === 'GOOD'
      ? 'positive'
      : rating === 'AVERAGE'
        ? 'warning'
        : rating === 'POOR'
          ? 'critical'
          : 'neutral';

  return (
    <span className="flex flex-col gap-0.5">
      <Badge variant={variant} className="w-fit">
        {LEAD_PROMPTNESS_LABELS[rating]}
      </Badge>

      {rating === 'NOT_RATED' ? (
        <span className="text-xs text-muted">
          {/* The two reasons are different facts and must read differently. */}
          {hasAssociate ? 'No measurable activity' : 'Unassigned'}
        </span>
      ) : (
        <span className="text-xs text-muted tabular">
          {onTime}/{expected} · {((score ?? 0) * 100).toFixed(1)}%
          {overdue > 0 && <span className="text-critical"> · {overdue} overdue</span>}
        </span>
      )}
    </span>
  );
}

/** How the lead reached its associate. */
export function AllocationBadge({ allocation }: { allocation: LeadAnalyticsRow['allocation'] }) {
  if (allocation === 'UNASSIGNED') return <Badge variant="outline">Unassigned</Badge>;
  return (
    <Badge variant={allocation === 'SELF' ? 'accent' : 'neutral'}>
      {allocation === 'SELF' ? 'Self' : 'Other user'}
    </Badge>
  );
}
