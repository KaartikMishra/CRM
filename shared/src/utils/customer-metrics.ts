/**
 * What a customer is worth, and how often they come back.
 *
 * ### This file performs no order arithmetic
 *
 * Every money figure below comes in already computed by Sales' own `toMoney`,
 * which is the single definition of what an order comes to — the create form
 * previews with it, the create schema validates with it, the API derives the
 * money view with it, and the `sales_order_money_guard` trigger mirrors it in
 * SQL. The Lead module already reads it the same way.
 *
 * So this module only *aggregates*: it adds up figures it is handed and counts
 * the orders they came from. It never looks at a line, a quantity, a price, a
 * GST rate or a charge. That is deliberate — restating any of that here would
 * create a second definition of order value that could disagree with the
 * invoice the customer was sent, which is the one thing these figures must
 * never do.
 *
 * ### Which orders count
 *
 * A placed order is a purchase, whether or not it has been paid: the goods were
 * agreed. So OPEN, DISPATCHED and CLOSED all count and unpaid ones are
 * included. CANCELLED orders do not count at all — and note this needs no
 * special case here, because `toMoney` already returns `activeTotal` of '0.00'
 * for a cancelled order. Cancelled *quantities* within a surviving order are
 * likewise already netted out of `activeTotal`.
 *
 * Shipping, packing and every other charge are inside `activeTotal` too, as is
 * any discount. Completed refunds are subtracted; pending ones are reported
 * beside the total rather than inside it, because a refund nobody has settled
 * has not left the business yet.
 */

import { addAmount, compareAmount, normaliseAmount, subtractAmount } from './money.js';

/** The slice of an order these metrics need. Nothing here is recomputed. */
export type CustomerOrderFact = {
  orderId: string;
  /** `SalesOrder.orderDate` — the business date, not when the row was written. */
  orderDate: Date;
  status: 'OPEN' | 'DISPATCHED' | 'CLOSED' | 'CANCELLED';
  /**
   * Straight from `toMoney`.
   *
   * `activeTotal` already nets out cancelled quantities and is '0.00' for a
   * cancelled order; `refunded` counts COMPLETED refunds only; `refundPending`
   * counts PENDING ones.
   */
  money: {
    activeTotal: string;
    refunded: string;
    refundPending: string;
    paid: string;
    fullyPaid: boolean;
  };
};

export type CustomerPurchaseMetrics = {
  /** Orders that count as purchases: every status except CANCELLED. */
  validOrderCount: number;
  cancelledOrderCount: number;
  /**
   * Of the valid orders, how many are settled in full.
   *
   * Reported beside `validOrderCount` rather than replacing it, because the
   * repeat-customer rule counts valid orders. A business that later prefers
   * "two *paid* orders" has the number it needs without the definition of a
   * purchase changing underneath it.
   */
  paidOrderCount: number;
  /**
   * Σ activeTotal over valid orders, less completed refunds. Never negative:
   * refunds exceeding the order value would otherwise read as a debt the
   * customer owes, which is not what a purchase history means.
   */
  verifiedPurchaseValue: string;
  /** Σ activeTotal before refunds, for readers who want the gross figure. */
  grossPurchaseValue: string;
  refundedValue: string;
  /** Promised but not settled. Deliberately outside the total above. */
  pendingRefundValue: string;
  /**
   * verifiedPurchaseValue ÷ validOrderCount, or null with no valid orders.
   *
   * Null rather than '0.00'. A customer who has never ordered has no average
   * order value; printing zero would put them in the same bucket as somebody
   * whose orders genuinely came to nothing, and would drag any cohort average
   * down with a figure that is not a measurement.
   */
  averageOrderValue: string | null;
  /** At least two valid non-cancelled orders. */
  isRepeatCustomer: boolean;
  /** Latest `orderDate` among valid orders. Null when there are none. */
  lastPurchaseAt: string | null;
  firstPurchaseAt: string | null;
};

/** Divides a money string by a positive integer, half-up at two places. */
function divideAmount(amount: string, divisor: number): string {
  // Paise as an integer, so the division never meets a binary float.
  const paise = BigInt(normaliseAmount(amount).replace('.', ''));
  const d = BigInt(divisor);
  // Half-up: add half the divisor before truncating.
  const quotient = (paise * 2n + d) / (d * 2n);
  const sign = quotient < 0n ? '-' : '';
  const abs = quotient < 0n ? -quotient : quotient;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export function customerPurchaseMetrics(
  orders: readonly CustomerOrderFact[],
): CustomerPurchaseMetrics {
  const valid = orders.filter((o) => o.status !== 'CANCELLED');
  const cancelledOrderCount = orders.length - valid.length;

  let gross = '0.00';
  let refunded = '0.00';
  let pendingRefund = '0.00';
  let paidOrderCount = 0;

  for (const order of valid) {
    gross = addAmount(gross, normaliseAmount(order.money.activeTotal));
    refunded = addAmount(refunded, normaliseAmount(order.money.refunded));
    pendingRefund = addAmount(pendingRefund, normaliseAmount(order.money.refundPending));
    if (order.money.fullyPaid) paidOrderCount += 1;
  }

  /*
    Clamped at zero. Refunds can exceed what the remaining order is worth once
    units are cancelled — `toMoney` reports exactly that as `refundable` — and a
    negative purchase history would be a debt, not a purchase.
  */
  const net = subtractAmount(gross, refunded);
  const verifiedPurchaseValue = compareAmount(net, '0.00') > 0 ? net : '0.00';

  const dates = valid.map((o) => o.orderDate.getTime());

  return {
    validOrderCount: valid.length,
    cancelledOrderCount,
    paidOrderCount,
    verifiedPurchaseValue,
    grossPurchaseValue: gross,
    refundedValue: refunded,
    pendingRefundValue: pendingRefund,
    averageOrderValue:
      valid.length > 0 ? divideAmount(verifiedPurchaseValue, valid.length) : null,
    isRepeatCustomer: valid.length >= 2,
    lastPurchaseAt: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null,
    firstPurchaseAt: dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null,
  };
}

/** One lead, as the conversion rules need it. */
export type CustomerLeadFact = {
  leadId: string;
  dealStatus: 'WON' | 'LOST' | 'INPROCESS';
  /** `Lead.salesOrderId` — unique, so one order is the result of at most one lead. */
  salesOrderId: string | null;
  /** Whether that linked order is cancelled. Null when no order is linked. */
  linkedOrderCancelled: boolean | null;
};

export type CustomerConversionMetrics = {
  leadCount: number;
  /**
   * Leads linked to a surviving sales order.
   *
   * The definition of conversion: a lead became a purchase when it produced an
   * order and that order was not called off. A cancelled order is not a sale,
   * so a lead linked only to one has not converted.
   */
  convertedLeadCount: number;
  /**
   * Leads a person marked WON.
   *
   * Reported separately, never merged with the above, because the two can
   * legitimately disagree: a lead can be marked WON before its order exists,
   * and an order can be cancelled after its lead was marked WON. Collapsing
   * them would hide exactly the discrepancy worth seeing.
   */
  wonLeadCount: number;
  /** convertedLeadCount ÷ leadCount as a percentage, or null with no leads. */
  conversionRate: number | null;
};

export function customerConversionMetrics(
  leads: readonly CustomerLeadFact[],
): CustomerConversionMetrics {
  const converted = leads.filter(
    (l) => l.salesOrderId !== null && l.linkedOrderCancelled === false,
  ).length;
  const won = leads.filter((l) => l.dealStatus === 'WON').length;

  return {
    leadCount: leads.length,
    convertedLeadCount: converted,
    wonLeadCount: won,
    // Null, not 0: a customer with no leads has no conversion rate to report.
    conversionRate:
      leads.length > 0 ? Math.round((converted / leads.length) * 1000) / 10 : null,
  };
}
