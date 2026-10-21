import Link from 'next/link';
import { ArrowRight, Boxes, TriangleAlert } from 'lucide-react';
import type { StockValuationView } from '@rs/shared';
import { Card, CardContent } from '@/components/ui/card';
// The signed formatter, so a negative aggregate renders instead of throwing —
// formatINR alone rejects negatives, and it is shared with Sales/GST.
import { formatStockMoney } from './variant-table';

/**
 * How much money is held in CRM stock — the Admin Dashboard's figure.
 *
 * Reads the same `/api/rs-products/valuation` aggregation the product pages
 * reconcile against, so this total and the sum of the per-product totals are
 * one computation rather than two that could drift.
 *
 * ### Why the incompleteness is as prominent as the total
 *
 * No variant in the live catalogue has a cost price yet, so the honest first
 * answer is ₹0.00 known across 5 units of unknown value. A card showing only
 * "₹0.00" would read as "no money in stock", which is a different and wrong
 * claim. So a missing-cost warning sits beside the figure whenever one exists,
 * and the total is labelled as the *known* value throughout.
 *
 * Not a Client Component: nothing here is interactive beyond a link.
 */
/**
 * Props are a discriminated union so the two states cannot be confused: either
 * a valuation is supplied, or the card is told the figure is unavailable. There
 * is no third state in which it renders a number it does not have.
 */
type Props =
  | { valuation: StockValuationView; unavailable?: false }
  | { valuation?: undefined; unavailable: true };

export function StockValuationCard(props: Props) {
  if (props.unavailable) {
    /*
      The request failed. The card still appears, saying so plainly — hiding it
      would make a broken backend indistinguishable from an unbuilt feature,
      and showing ₹0.00 would be a false figure rather than a missing one.

      No backend message or error code is surfaced: those can carry internal
      detail that has no place on a dashboard.
    */
    return (
      <Card>
        <CardContent className="p-5">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
            <Boxes className="size-3.5 text-muted" />
            CRM stock value
          </p>

          <div className="mt-3 flex items-start gap-2 rounded-md bg-surface-2 p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-xs text-ink-2">
              <p className="font-medium">Valuation unavailable</p>
              <p className="mt-0.5 text-muted">
                The stock valuation could not be loaded just now. No figure is shown rather than a
                misleading zero. Try again shortly, or open the catalogue to read per-product
                values.
              </p>
            </div>
          </div>

          <Link
            href="/rs-products"
            className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Catalogue <ArrowRight className="size-3" />
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { primary, archived, negativeStockVariants } = props.valuation;

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
              <Boxes className="size-3.5 text-accent" />
              CRM stock value
            </p>
            {/* "Known" in the label, not a footnote: the number excludes every
                variant whose cost nobody has entered. */}
            <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-ink">
              {formatStockMoney(primary.knownValue)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Known value, at manually entered cost prices
            </p>
          </div>

          <Link
            href="/rs-products"
            className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-accent hover:underline"
          >
            Catalogue <ArrowRight className="size-3" />
          </Link>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
          <div>
            <dt className="text-xs text-muted">CRM stock units</dt>
            <dd className="mt-0.5 font-mono text-lg tabular-nums text-ink">
              {primary.totalUnits.toLocaleString('en-IN')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Variants costed</dt>
            <dd className="mt-0.5 font-mono text-lg tabular-nums text-ink">
              {primary.variantsValued.toLocaleString('en-IN')}
            </dd>
          </div>
        </dl>

        {primary.incomplete && (
          /*
            The valuation is incomplete, and that is stated rather than implied.
            Uncosted stock is counted in units and variants, never valued at
            zero — zero would say the stock is worthless rather than unpriced.
          */
          <div className="mt-4 flex items-start gap-2 rounded-md bg-warning-soft p-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-xs text-warning">
              <p className="font-medium">Valuation incomplete</p>
              <p className="mt-0.5">
                {primary.variantsMissingCost === 1
                  ? '1 variant'
                  : `${primary.variantsMissingCost} variants`}{' '}
                across{' '}
                {primary.productsMissingCost === 1
                  ? '1 product'
                  : `${primary.productsMissingCost} products`}{' '}
                hold {primary.unitsWithUnknownCost.toLocaleString('en-IN')} units with no cost
                price. Their value is not counted above.
              </p>
            </div>
          </div>
        )}

        {/* Archived products are excluded from the figure above, so the
            exclusion is shown rather than left for someone to discover by
            counting the catalogue by hand. */}
        {(archived.totalUnits > 0 || archived.variantsValued > 0) && (
          <p className="mt-3 text-xs text-muted">
            Excludes archived products: {formatStockMoney(archived.knownValue)} across{' '}
            {archived.totalUnits.toLocaleString('en-IN')} units.
          </p>
        )}

        {negativeStockVariants > 0 && (
          /*
            `crmStockSchema` forbids a negative CRM stock, so this should never
            appear. It is surfaced rather than clamped: a non-zero count means
            stock moved through a path that bypassed validation, and absorbing
            it into the total would hide the defect.
          */
          <p className="mt-3 text-xs font-medium text-critical">
            {negativeStockVariants === 1
              ? '1 variant has negative CRM stock'
              : `${negativeStockVariants} variants have negative CRM stock`}{' '}
            — please report this.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
