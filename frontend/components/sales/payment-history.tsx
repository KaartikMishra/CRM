import { PAYMENT_METHOD_LABELS, type SalesPaymentView } from '@rs/shared';
import { formatCurrency, formatDateTime } from '@/lib/format';

/**
 * Every instalment taken against the order, oldest first.
 *
 * Their sum is the order's paid amount — the figure the money guard enforces —
 * so nothing here is a second total. This is what that figure is made of, which
 * is the whole reason a payment is a row rather than a column: an order
 * collected in three instalments has three references, three dates and possibly
 * three methods, and a field on the order could hold one of each.
 *
 * Rendered as a list rather than a table. It sits in a 380px aside beside the
 * money summary, and three columns of a table would wrap a UTR badly; a row per
 * payment with the amount leading reads at that width.
 */
export function PaymentHistory({
  payments,
  currency,
}: {
  payments: SalesPaymentView[];
  currency: string;
}) {
  // An order with no payments says so through the summary above; an empty
  // heading here would be noise on most orders.
  if (payments.length === 0) return null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Payments taken
      </h3>

      <ul className="mt-2 flex flex-col gap-2">
        {payments.map((payment) => (
          <li key={payment.id} className="rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="whitespace-nowrap font-mono text-sm text-ink tabular">
                {formatCurrency(payment.amount, currency)}
              </span>
              {payment.method && (
                <span className="text-xs text-ink-2">
                  {PAYMENT_METHOD_LABELS[payment.method]}
                </span>
              )}
            </div>

            {payment.reference && (
              <p className="mt-1 break-all text-xs text-muted">
                Ref <span className="font-mono text-ink-2">{payment.reference}</span>
              </p>
            )}

            {payment.note && <p className="mt-1 text-xs text-ink-2">{payment.note}</p>}

            <p className="mt-1 text-xs text-muted tabular">
              {payment.recordedBy.name} · {formatDateTime(payment.recordedAt)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
