/**
 * Line-level GST and order-level charges, end to end against the real database.
 *
 * GST is decided per line — both the slab and whether the price includes it —
 * so the case that matters most here is a single order carrying 5% exclusive
 * beside 18% inclusive beside a line taxed at nothing.
 *
 * What this suite is really for is the agreement between two implementations of
 * the same arithmetic that cannot call each other:
 *
 *   computeLineTax / computeSalesTotals  in @rs/shared, TypeScript, BigInt paise
 *   sales_order_money_guard              in Postgres, plpgsql, NUMERIC(14,2)
 *
 * A database invariant cannot call TypeScript, so the rounding rule is written
 * twice and the two must agree to the paise. If they ever drift, an order the
 * API reports as fully paid would be refused at COMMIT — a failure that would
 * only surface in production, on a real customer's payment.
 *
 * The check for that is the sharpest one available and it is used throughout
 * below: pay an order the exact figure the API reported, then CLOSE it. The
 * trigger permits a close only when `paid = payable` exactly, so a close that
 * commits is proof the two agree. Nothing else in the suite is as important.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SalesOrderDetail } from '@rs/shared';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  makeCustomer,
  makeUser,
  residualTestRows,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type OrderBody = { order: SalesOrderDetail };

let admin: TestUser;
let token: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  token = await mintToken(admin.id, { role: 'ADMIN' });
  customerId = (await makeCustomer('BULK', { state: 'Karnataka' })).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const createOrder = async (overrides: Record<string, unknown>): Promise<SalesOrderDetail> => {
  const res = await api<OrderBody>('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customerId, overrides),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = res.body.data!.order;
  trackSalesOrder(order.id);
  return order;
};

/** A line carries its own slab AND its own reading. */
const item = (quantity: number, price: string, gstRate: string, gstMode: string) => ({
  productName: `zz-test-${price}-${gstRate}`,
  quantity,
  price,
  gstRate,
  gstMode,
});

/**
 * Pays an order its own reported payable and closes it.
 *
 * The close is what proves the agreement: the money guard refuses it unless
 * `paid` equals the payable it computes independently, in SQL, reading each
 * line's own mode.
 */
async function settleAndClose(order: SalesOrderDetail): Promise<void> {
  const pay = await api<OrderBody>('POST', `/api/sales/${order.id}/payments`, {
    token,
    body: { amount: order.money.total },
  });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  expect(pay.body.data!.order.money.fullyPaid).toBe(true);

  const dispatched = await api('POST', `/api/sales/${order.id}/dispatch`, { token });
  expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);

  const closed = await api<OrderBody>('POST', `/api/sales/${order.id}/close`, { token });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(closed.body.data!.order.status).toBe('CLOSED');
}

// ===========================================================================
//  A + B — one line, each mode
// ===========================================================================

describe('a single line', () => {
  it('EXCLUDED adds the tax on top of the price', async () => {
    const order = await createOrder({ items: [item(1, '90.00', '5', 'EXCLUSIVE')] });

    expect(order.items[0]!.gstMode).toBe('EXCLUSIVE');
    expect(order.items[0]!.taxableAmount).toBe('90.00');
    expect(order.items[0]!.gstAmount).toBe('4.50');
    expect(order.money.taxableSubtotal).toBe('90.00');
    expect(order.money.total).toBe('94.50');
  });

  it('INCLUDED works the tax back out of the price', async () => {
    const order = await createOrder({ items: [item(1, '90.00', '5', 'INCLUSIVE')] });

    expect(order.items[0]!.gstMode).toBe('INCLUSIVE');
    expect(order.items[0]!.taxableAmount).toBe('85.71');
    expect(order.items[0]!.gstAmount).toBe('4.29');
    // The customer still pays what was typed.
    expect(order.money.total).toBe('90.00');
  });

  it('lets the customer pay the taxed figure, and closes on it', async () => {
    const order = await createOrder({ items: [item(2, '1250.50', '18', 'EXCLUSIVE')] });

    expect(order.money.total).toBe('2951.18');
    await settleAndClose(order);
  });
});

// ===========================================================================
//  C — mixed modes in ONE order. The point of the whole change.
// ===========================================================================

describe('mixed GST modes in the same order', () => {
  it('reads each line on its own terms', async () => {
    // Exactly the worked example from the requirement.
    const order = await createOrder({
      items: [item(1, '1000.00', '5', 'EXCLUSIVE'), item(1, '1000.00', '18', 'INCLUSIVE')],
    });

    const [excl, incl] = order.items;
    expect(excl!.taxableAmount).toBe('1000.00');
    expect(excl!.gstAmount).toBe('50.00');
    expect(incl!.taxableAmount).toBe('847.46');
    expect(incl!.gstAmount).toBe('152.54');

    expect(order.money.taxableSubtotal).toBe('1847.46');
    expect(order.money.taxTotal).toBe('202.54');
    expect(order.money.total).toBe('2050.00');
  });

  it('agrees with the database on a mixed order', async () => {
    const order = await createOrder({
      items: [item(1, '1000.00', '5', 'EXCLUSIVE'), item(1, '1000.00', '18', 'INCLUSIVE')],
    });

    await settleAndClose(order);
  });

  it('agrees on awkward paise, mixed both ways', async () => {
    const order = await createOrder({
      items: [
        item(1, '0.99', '28', 'INCLUSIVE'),
        item(13, '7.77', '5', 'EXCLUSIVE'),
        item(3, '33.33', '12', 'INCLUSIVE'),
        item(7, '1.01', '18', 'EXCLUSIVE'),
      ],
    });

    await settleAndClose(order);
  });
});

// ===========================================================================
//  D + E — slabs, and the untaxed line
// ===========================================================================

describe('slabs', () => {
  it('reports each slab separately for the invoice', async () => {
    const order = await createOrder({
      items: [
        item(1, '100.00', '5', 'EXCLUSIVE'),
        item(1, '100.00', '18', 'EXCLUSIVE'),
        item(1, '100.00', 'NONE', 'EXCLUSIVE'),
      ],
    });

    expect(order.money.taxByRate.map((r) => r.rate)).toEqual([5, 18]);
    expect(order.money.taxTotal).toBe('23.00');
    // The untaxed line is still part of the goods.
    expect(order.money.taxableSubtotal).toBe('300.00');
    expect(order.money.total).toBe('323.00');
  });

  it('groups a slab by rate, not by how each price was typed', async () => {
    const order = await createOrder({
      items: [item(1, '105.00', '5', 'INCLUSIVE'), item(1, '100.00', '5', 'EXCLUSIVE')],
    });

    expect(order.money.taxByRate).toHaveLength(1);
    expect(order.money.taxByRate[0]!.taxable).toBe('200.00');
    expect(order.money.taxByRate[0]!.tax).toBe('10.00');
  });

  it('leaves a NONE line untaxed whichever mode it carries', async () => {
    const order = await createOrder({
      items: [item(1, '100.00', 'NONE', 'INCLUSIVE'), item(1, '100.00', 'NONE', 'EXCLUSIVE')],
    });

    expect(order.money.taxTotal).toBe('0.00');
    expect(order.money.total).toBe('200.00');
    expect(order.items[0]!.gstAmount).toBe('0.00');
    expect(order.items[1]!.gstAmount).toBe('0.00');
  });
});

// ===========================================================================
//  F + G — the heads
// ===========================================================================

describe('CGST and SGST', () => {
  it('splits the rate in half and the halves add back to the whole', async () => {
    const order = await createOrder({ items: [item(1, '90.00', '5', 'EXCLUSIVE')] });

    expect(order.money.taxSplit).toBe('CGST_SGST');
    expect(order.money.cgstTotal).toBe('2.25');
    expect(order.money.sgstTotal).toBe('2.25');
    expect(order.money.igstTotal).toBe('0.00');
  });

  it('splits every slab of a mixed-mode order', async () => {
    const order = await createOrder({
      items: [item(1, '1000.00', '5', 'EXCLUSIVE'), item(1, '1000.00', '18', 'INCLUSIVE')],
    });

    expect(order.money.taxByRate[0]!.cgst).toBe('25.00');
    expect(order.money.taxByRate[1]!.cgst).toBe('76.27');
    expect(order.money.cgstTotal).toBe('101.27');
    expect(order.money.sgstTotal).toBe('101.27');
    expect(order.money.igstTotal).toBe('0.00');
  });
});

// ===========================================================================
//  H — charges, order level
// ===========================================================================

describe('charges and adjustments', () => {
  it('adds them to the payable and reports them back', async () => {
    const order = await createOrder({
      items: [item(2, '100.00', '18', 'EXCLUSIVE')],
      charges: [
        { type: 'SHIPPING', label: 'zz-test freight', amount: '250.00' },
        { type: 'DISCOUNT', amount: '30.00' },
      ],
    });

    expect(order.charges).toHaveLength(2);
    expect(order.money.chargesTotal).toBe('250.00');
    expect(order.money.discountTotal).toBe('30.00');
    // 200 goods + 36 GST + 250 shipping − 30 discount.
    expect(order.money.total).toBe('456.00');
  });

  it('applies over a mixed-mode order, and closes on it', async () => {
    const order = await createOrder({
      items: [
        item(1, '1000.00', '5', 'EXCLUSIVE'),
        item(1, '1000.00', '18', 'INCLUSIVE'),
        item(2, '50.00', 'NONE', 'EXCLUSIVE'),
      ],
      charges: [
        { type: 'SHIPPING', amount: '200.00' },
        { type: 'DISCOUNT', amount: '75.00' },
      ],
    });

    expect(order.money.taxableSubtotal).toBe('1947.46');
    expect(order.money.total).toBe('2275.00');
    await settleAndClose(order);
  });

  it('can be replaced wholesale afterwards', async () => {
    const order = await createOrder({ items: [item(1, '100.00', '18', 'EXCLUSIVE')] });
    expect(order.money.total).toBe('118.00');

    const res = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: {
        charges: [
          { type: 'DUTY', amount: '11.11' },
          { type: 'PACKING', amount: '5.00' },
        ],
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.order.money.total).toBe('134.11');

    const cleared = await api<OrderBody>('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [] },
    });
    expect(cleared.body.data!.order.charges).toHaveLength(0);
    expect(cleared.body.data!.order.money.total).toBe('118.00');
  });

  it('refuses a discount larger than the order', async () => {
    const order = await createOrder({ items: [item(1, '10.00', 'NONE', 'EXCLUSIVE')] });

    const res = await api('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [{ type: 'DISCOUNT', amount: '999.00' }] },
    });

    expect(res.status).toBe(422);
  });

  it('refuses charges that would drop the payable below what is already paid', async () => {
    const order = await createOrder({
      items: [item(1, '100.00', 'NONE', 'EXCLUSIVE')],
      charges: [{ type: 'SHIPPING', amount: '100.00' }],
    });

    const paid = await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '200.00' },
    });
    expect(paid.status).toBe(201);

    const res = await api('PUT', `/api/sales/${order.id}/charges`, {
      token,
      body: { charges: [] },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');
  });
});

// ===========================================================================
//  I — the payment ceiling is the final payable
// ===========================================================================

describe('the payment ceiling is the payable', () => {
  it('accepts exactly the payable and refuses a paisa more', async () => {
    const order = await createOrder({
      items: [item(1, '100.00', '18', 'EXCLUSIVE'), item(1, '100.00', '5', 'INCLUSIVE')],
      charges: [{ type: 'DUTY', amount: '7.07' }],
    });

    // 100 + 18 tax, plus 100 inclusive (95.24 + 4.76), plus 7.07 duty.
    expect(order.money.total).toBe('225.07');

    const over = await api('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '225.08' },
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');

    const exact = await api<OrderBody>('POST', `/api/sales/${order.id}/payments`, {
      token,
      body: { amount: '225.07' },
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body.data!.order.money.pending).toBe('0.00');
  });
});

// ===========================================================================
//  K — what the API refuses
// ===========================================================================

describe('validation', () => {
  it('rejects an invalid GST mode', async () => {
    const res = await api('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customerId, { items: [item(1, '90.00', '5', 'SOMETIMES')] }),
    });

    expect(res.status).toBe(422);
  });

  it('rejects an invalid slab', async () => {
    const res = await api('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customerId, { items: [item(1, '90.00', '7', 'EXCLUSIVE')] }),
    });

    expect(res.status).toBe(422);
  });

  it('defaults a line with no mode to EXCLUSIVE', async () => {
    const order = await createOrder({
      items: [{ productName: 'zz-test-default', quantity: 1, price: '100.00', gstRate: '18' }],
    });

    expect(order.items[0]!.gstMode).toBe('EXCLUSIVE');
    expect(order.money.total).toBe('118.00');
  });

  it('ignores an order-level gstMode, which no longer exists', async () => {
    // Sent by an old client. Stripped by the schema rather than honoured, and
    // the line's own default is what decides.
    const order = await createOrder({
      gstMode: 'INCLUSIVE',
      items: [item(1, '100.00', '18', 'EXCLUSIVE')],
    });

    expect(order.items[0]!.gstMode).toBe('EXCLUSIVE');
    expect(order.money.total).toBe('118.00');
  });
});
