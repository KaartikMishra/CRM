import type { SalesMoneyView } from '@rs/shared';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';

/**
 * Total, paid and pending — the three numbers that matter on an order.
 *
 * Only `paid` is stored. `total` is quantity × price and `pending` is
 * total − paid, both derived by the API; this renders what the backend sent and
 * never recomputes them, so the screen cannot disagree with the record.
 *
 * The markup is the same three-cell statistic block the enquiry submit dialog
 * already uses, so it reads as an existing part of the CRM rather than a new
 * idiom.
 */
export function MoneySummary({
  money,
  className,
}: {
  money: SalesMoneyView;
  className?: string;
}) {
  const cells = [
    { label: 'Total', value: money.total, tone: 'text-ink' },
    { label: 'Paid', value: money.paid, tone: 'text-positive' },
    {
      label: 'Pending',
      value: money.pending,
      // A settled order is a good outcome, not an outstanding one.
      tone: money.fullyPaid ? 'text-muted' : 'text-warning',
    },
  ];

  return (
    /*
      Sized against the container, not the viewport.

      This sits in a fixed 320px aside on the detail page and in a much wider
      dialog elsewhere, so a viewport breakpoint is the wrong tool — the aside is
      320px on any screen. Three centred columns leave roughly 77px each once the
      card and grid padding come off, which is not enough for a value like
      ₹19,488.00 (~108px at this size); grid tracks are min-width:auto, so the
      amount overflowed its cell and collided with its neighbours.

      Below ~22rem the three amounts stack as label/value rows, each with the
      full width to itself. Above it the original three-across layout returns
      unchanged, which is what the dialogs get.
    */
    <div className={cn('@container', className)}>
      <dl className="grid gap-2 rounded-md border border-line bg-surface-2 p-3 @[22rem]:grid-cols-3 @[22rem]:gap-3 @[22rem]:text-center">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="flex items-baseline justify-between gap-3 @[22rem]:block"
          >
            <dt className="text-[11px] uppercase tracking-wider text-muted">{cell.label}</dt>
            {/* nowrap: a currency value must never break across lines mid-number. */}
            <dd
              className={cn(
                'whitespace-nowrap font-mono text-lg tabular @[22rem]:mt-1',
                cell.tone,
              )}
            >
              {formatCurrency(cell.value, money.currency)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
