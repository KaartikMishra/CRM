/**
 * The order shape Sales' `toMoney` consumes, for the customer directory.
 *
 * Copied in spirit from `lead.repository.ts`'s `orderMoneySelect`, which
 * established this pattern: a module that needs an order's value selects
 * exactly what `toMoney` reads and calls it, rather than summing lines itself.
 * There is no stored total to read instead — deliberately, so a charge changing
 * on an order cannot leave a stale figure anywhere.
 *
 * Why this file exists separately: the directory needs the same shape in three
 * queries (page rows, profile, export), and three inline copies would be three
 * chances for one to omit `cancelledQty` or an item `status` and quietly report
 * a different number from the invoice.
 */

import type { Prisma } from '@rs/database';

/**
 * Everything `toMoney` reads, and nothing else.
 *
 * `customer.state`/`country` decide the GST split; the items carry the per-line
 * rate and mode plus `cancelledQty` and `status`; the charges are order-level;
 * the refunds carry their own status so completed and pending can be
 * distinguished. `paidAmount` and `paymentMethod` come from the order itself.
 */
export const orderMoneySelect = {
  select: {
    paidAmount: true,
    paymentMethod: true,
    status: true,
    customer: { select: { state: true, country: true } },
    refunds: { select: { amount: true, status: true } },
    items: {
      select: {
        quantity: true,
        cancelledQty: true,
        price: true,
        gstRate: true,
        gstMode: true,
        status: true,
      },
    },
    charges: { select: { type: true, amount: true } },
  },
} satisfies { select: Prisma.SalesOrderSelect };
