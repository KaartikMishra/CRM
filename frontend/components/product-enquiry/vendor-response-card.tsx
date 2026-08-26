import type { VendorResponseView } from '@rs/shared';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatDimension, formatWeight, label } from '@/lib/format';

/**
 * One vendor's quote.
 *
 * Product match shows "Similar Product" because that is the only value the
 * backend supports (§27) — there is deliberately no "Exact Product" here.
 */
export function VendorResponseCard({ response }: { response: VendorResponseView }) {
  const details: { label: string; value: string }[] = [
    { label: 'Rate', value: `${formatCurrency(response.ratePerUnit, response.currency)} / unit` },
    {
      label: 'Delivery',
      // Same Day is the stronger promise, so it replaces the day count rather
      // than sitting beside it and reading as a contradiction.
      value: response.sameDay ? 'Same Day' : `${response.deliveryWithinDays} days`,
    },
    { label: 'Weight', value: formatWeight(response.weight) },
    { label: 'Dimensions', value: formatDimension(response.dimension) },
  ];

  return (
    <div className="rounded-md border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{response.vendor.name}</p>
          <p className="mt-0.5 text-xs text-muted">Recorded by {response.createdBy.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {response.sameDay && <Badge variant="positive">Same Day</Badge>}
          <Badge variant="accent">{label(response.matchType)}</Badge>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {details.map((detail) => (
          <div key={detail.label}>
            <dt className="text-[11px] uppercase tracking-wider text-muted">{detail.label}</dt>
            <dd className="mt-0.5 text-sm text-ink tabular">{detail.value}</dd>
          </div>
        ))}
      </dl>

      {response.notes && <p className="mt-3 text-xs text-ink-2">{response.notes}</p>}
    </div>
  );
}
