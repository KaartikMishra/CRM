import { SALES_CHARGE_TYPE_LABELS } from '@rs/shared';
import type {
  DecimalString,
  SalesChargeType,
  TaxRateBreakupView,
  TaxSplit,
} from '@rs/shared';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * How an order's money is put together, in the order somebody reads an invoice.
 *
 *     goods  ->  GST  ->  charges  ->  discount  ->  payable
 *
 * GST is read per line, so there is no order-level mode to state here: the slab
 * table shows what was taxed at each rate, and each line carries its own
 * reading beside the price it applies to.
 *
 * One component for both surfaces: the create form previews a total that does
 * not exist yet, and the detail page shows one the API derived. Feeding both
 * from the same renderer is what stops the preview and the record from
 * describing the same arithmetic differently.
 *
 * Every figure arrives as an exact decimal string and is only ever formatted
 * here. NOTHING on this page does arithmetic — not a sum, not a rounding, not
 * a percentage. The numbers are already right when they reach it.
 */

/** A charge as this card shows it. Both surfaces can supply this shape. */
export type BreakdownCharge = {
  type: SalesChargeType;
  label?: string | null;
  amount: DecimalString;
};

export type MoneyBreakdownProps = {
  taxSplit: TaxSplit;
  /** The goods before tax. Lower than what was typed when prices are inclusive. */
  taxableSubtotal: DecimalString;
  taxTotal: DecimalString;
  cgstTotal: DecimalString;
  sgstTotal: DecimalString;
  igstTotal: DecimalString;
  byRate: TaxRateBreakupView[];
  chargesTotal: DecimalString;
  discountTotal: DecimalString;
  /** Itemised, so a reader can see what the charges actually were. */
  charges?: readonly BreakdownCharge[];
  /** What the customer owes. */
  payable: DecimalString;
  className?: string;
};

const isZero = (amount: DecimalString): boolean => Number(amount) === 0;

/** A section heading. Quiet, because the figures are what is being read. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</p>
  );
}

/**
 * One label-and-amount pair.
 *
 * `indent` is what carries the hierarchy: a figure that belongs to the line
 * above it sits in from the margin, so "Taxable" and "GST" read as parts of
 * the slab they follow rather than as two more order-level totals.
 */
function Row({
  label,
  value,
  indent = false,
  strong = false,
  negative = false,
}: {
  label: React.ReactNode;
  value: DecimalString;
  indent?: boolean;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-6', indent && 'pl-3')}>
      <span
        className={cn(
          'text-sm',
          strong ? 'font-medium text-ink' : indent ? 'text-muted' : 'text-ink-2',
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'shrink-0 font-mono text-sm tabular',
          strong ? 'font-medium text-ink' : indent ? 'text-ink-2' : 'text-ink',
          negative && 'text-critical',
        )}
      >
        {negative ? `− ${formatCurrency(value)}` : formatCurrency(value)}
      </span>
    </div>
  );
}

export function MoneyBreakdown({
  taxSplit,
  taxableSubtotal,
  taxTotal,
  cgstTotal,
  sgstTotal,
  igstTotal,
  byRate,
  chargesTotal,
  discountTotal,
  charges = [],
  payable,
  className,
}: MoneyBreakdownProps) {
  const taxed = byRate.length > 0 && !isZero(taxTotal);
  const added = charges.filter((c) => c.type !== 'DISCOUNT');
  const discounts = charges.filter((c) => c.type === 'DISCOUNT');

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <Row label="Product subtotal" value={taxableSubtotal} />

      {/*
        Each slab as one group: the rate names it, and the two figures beneath
        say what was taxed and what the tax came to. The previous layout
        repeated CGST and SGST under every rate and then again at the bottom,
        which made a two-slab order read as six near-identical lines.
      */}
      {taxed && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <SectionLabel>GST breakdown</SectionLabel>

          {byRate.map((slab) => (
            <div key={slab.rate} className="flex flex-col gap-1">
              <p className="text-sm font-medium text-ink">{slab.rate}% GST</p>
              <Row label="Taxable" value={slab.taxable} indent />
              <Row label="GST" value={slab.tax} indent />
            </div>
          ))}

          {/*
            The heads, once, at the end. Intra-state splits in two; inter-state
            is a single head at the whole rate. Naming them wrongly on a
            document somebody files is the thing to avoid.
          */}
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <Row label="Total GST" value={taxTotal} strong />
            {taxSplit === 'CGST_SGST' ? (
              <>
                <Row label="CGST" value={cgstTotal} indent />
                <Row label="SGST" value={sgstTotal} indent />
              </>
            ) : (
              <Row label="IGST" value={igstTotal} indent />
            )}
          </div>
        </div>
      )}

      {!taxed && <Row label="GST" value="0.00" />}

      {/* Charges, itemised where they are known, between GST and the payable. */}
      {!isZero(chargesTotal) && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          {added.length > 0 ? (
            <>
              <SectionLabel>Charges</SectionLabel>
              {added.map((charge, index) => (
                <Row
                  key={`${charge.type}-${index}`}
                  label={
                    charge.label
                      ? `${SALES_CHARGE_TYPE_LABELS[charge.type]} · ${charge.label}`
                      : SALES_CHARGE_TYPE_LABELS[charge.type]
                  }
                  value={charge.amount}
                  indent
                />
              ))}
            </>
          ) : (
            <Row label="Additional charges" value={chargesTotal} />
          )}
        </div>
      )}

      {!isZero(discountTotal) &&
        (discounts.length > 0 ? (
          <div className="flex flex-col gap-1">
            {discounts.map((charge, index) => (
              <Row
                key={`discount-${index}`}
                label={charge.label ? `Discount · ${charge.label}` : 'Discount'}
                value={charge.amount}
                negative
              />
            ))}
          </div>
        ) : (
          <Row label="Discount" value={discountTotal} negative />
        ))}

      {/* The one figure somebody came here to read. */}
      <div className="flex items-baseline justify-between gap-6 border-t border-line pt-4">
        <span className="text-[15px] font-semibold text-ink">Total payable</span>
        <span className="shrink-0 font-mono text-lg font-semibold text-ink tabular">
          {formatCurrency(payable)}
        </span>
      </div>
    </div>
  );
}
