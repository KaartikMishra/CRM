/**
 * HSN code and GST rate on a sales line.
 *
 * Both are recorded per line and nothing is derived from either. That last
 * point is what most of this suite defends: the order's money is
 * sum(quantity * price), enforced by the sales_order_money_guard trigger, and
 * choosing a GST rate must not move a single figure.
 *
 * The other rule worth a test of its own is that `NONE`, `'0'` and `null` are
 * three different answers. "No GST decision recorded", "no GST applies" and
 * "exempt, at zero percent" are distinct statements about a document somebody
 * was handed, and collapsing any two of them would misreport a tax position.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GST_RATES, type SalesOrderDetail } from '@rs/shared';
import { prisma } from '../../../config/database.js';
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
  salesItemPayload,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { order: SalesOrderDetail };

let owner: TestUser;
let ownerToken: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  owner = await makeUser('USER');
  ownerToken = await mintToken(owner.id, { role: 'USER' });
  customerId = (await makeCustomer('BULK')).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function createOrder(overrides: Record<string, unknown> = {}) {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token: ownerToken,
    body: salesOrderPayload(customerId, overrides),
  });
  if (res.status === 201 && res.body.data) trackSalesOrder(res.body.data.order.id);
  return res;
}

/** Creates a single-line order with the given line overrides. */
const createWithLine = (line: Record<string, unknown>) =>
  createOrder({ items: [salesItemPayload(line)] });

// ---------------------------------------------------------------------------
//  HSN
// ---------------------------------------------------------------------------

describe('HSN code', () => {
  it('is accepted when omitted, and reads back as null', async () => {
    const res = await createWithLine({});
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.hsnCode).toBeNull();
  });

  it('stores a plain numeric-looking code as text', async () => {
    const res = await createWithLine({ hsnCode: '7418' });
    expect(res.status).toBe(201);
    const stored = res.body.data!.order.items[0]!.hsnCode;
    expect(stored).toBe('7418');
    expect(typeof stored).toBe('string');
  });

  it('keeps an alphanumeric code intact', async () => {
    const res = await createWithLine({ hsnCode: '7418AB' });
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.hsnCode).toBe('7418AB');
  });

  it('preserves a leading zero, which a numeric column would destroy', async () => {
    // The whole reason the column is TEXT.
    const res = await createWithLine({ hsnCode: '00741810' });
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.hsnCode).toBe('00741810');
  });

  it('trims surrounding whitespace, like every other text field', async () => {
    const res = await createWithLine({ hsnCode: '  741810  ' });
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.hsnCode).toBe('741810');
  });

  it('accepts a code at the 20-character limit', async () => {
    const twenty = '1'.repeat(20);
    const res = await createWithLine({ hsnCode: twenty });
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.hsnCode).toBe(twenty);
  });

  it('rejects a code past the limit, before it reaches the database', async () => {
    const res = await createWithLine({ hsnCode: '1'.repeat(21) });
    expect(res.status).toBe(422);
  });

  it('is never coerced from a number', async () => {
    // A JSON number is not a string, and the schema says string.
    const res = await createWithLine({ hsnCode: 7418 });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  GST
// ---------------------------------------------------------------------------

describe('GST rate', () => {
  it('accepts every one of the six permitted values, and no others exist', async () => {
    expect([...GST_RATES]).toEqual(['NONE', '0', '5', '12', '18', '28']);
    expect(GST_RATES).toHaveLength(6);

    for (const rate of GST_RATES) {
      const res = await createWithLine({ gstRate: rate });
      expect(res.status, `rate ${rate}`).toBe(201);
      expect(res.body.data!.order.items[0]!.gstRate, `rate ${rate}`).toBe(rate);
    }
  });

  it('is accepted when omitted, and reads back as null', async () => {
    const res = await createWithLine({});
    expect(res.status).toBe(201);
    expect(res.body.data!.order.items[0]!.gstRate).toBeNull();
  });

  it('keeps NONE, "0" and null as three different answers', async () => {
    // The central rule. "Not recorded", "no GST applies" and "exempt at zero
    // percent" are distinct positions, and a bill has to be able to say which.
    const none = await createWithLine({ gstRate: 'NONE' });
    const zero = await createWithLine({ gstRate: '0' });
    const absent = await createWithLine({});

    expect(none.body.data!.order.items[0]!.gstRate).toBe('NONE');
    expect(zero.body.data!.order.items[0]!.gstRate).toBe('0');
    expect(absent.body.data!.order.items[0]!.gstRate).toBeNull();

    expect(none.body.data!.order.items[0]!.gstRate).not.toBe('0');
    expect(zero.body.data!.order.items[0]!.gstRate).not.toBe('NONE');
  });

  it('stores the rate as a string, never a number', async () => {
    const res = await createWithLine({ gstRate: '18' });
    expect(res.status).toBe(201);
    const stored = res.body.data!.order.items[0]!.gstRate;
    expect(stored).toBe('18');
    expect(typeof stored).toBe('string');
    // 18 and '18' must not be treated as the same submitted value.
    expect(stored).not.toBe(18);
  });

  it('rejects a rate outside the six', async () => {
    for (const bad of ['9', '3', '0.5', 'none', 'None', '18%', 'EXEMPT', '', '100']) {
      const res = await createWithLine({ gstRate: bad });
      expect(res.status, `should reject ${JSON.stringify(bad)}`).toBe(422);
    }
  });

  it('rejects a numeric rate, so 18 cannot slip in beside "18"', async () => {
    const res = await createWithLine({ gstRate: 18 });
    expect(res.status).toBe(422);
  });

  it('refuses the whole order when one line carries an invalid rate', async () => {
    // Partial acceptance would leave an order whose lines disagree about
    // whether validation ran.
    const res = await createOrder({
      items: [salesItemPayload({ gstRate: '18' }), salesItemPayload({ gstRate: '7' })],
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Money is untouched
// ---------------------------------------------------------------------------

describe('neither field affects any total', () => {
  it('leaves the line total at quantity × price with GST at 28%', async () => {
    const res = await createWithLine({ quantity: 12, price: '1250.50', gstRate: '28' });
    expect(res.status).toBe(201);
    const item = res.body.data!.order.items[0]!;
    // 12 × 1250.50 = 15006.00 — no tax term.
    expect(item.lineTotal).toBe('15006.00');
  });

  it('gives the same order total whatever the GST rate', async () => {
    const totals = new Set<string>();

    for (const rate of GST_RATES) {
      const res = await createWithLine({ quantity: 4, price: '250.00', gstRate: rate });
      expect(res.status).toBe(201);
      totals.add(res.body.data!.order.money.total);
    }

    // One distinct total across all six rates.
    expect(totals.size).toBe(1);
    expect([...totals][0]).toBe('1000.00');
  });

  it('leaves pending and paid alone', async () => {
    const res = await createWithLine({
      quantity: 2,
      price: '500.00',
      gstRate: '18',
      hsnCode: '7418',
    });
    expect(res.status).toBe(201);
    const money = res.body.data!.order.money;
    expect(money.total).toBe('1000.00');
    expect(money.paid).toBe('0.00');
    expect(money.pending).toBe('1000.00');
  });
});

// ---------------------------------------------------------------------------
//  Persistence, and what did not change
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('writes both fields to the row, readable straight from the database', async () => {
    const res = await createWithLine({ hsnCode: '741810', gstRate: '12' });
    expect(res.status).toBe(201);

    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: res.body.data!.order.items[0]!.id },
      select: { hsnCode: true, gstRate: true, quantity: true, price: true },
    });

    expect(row.hsnCode).toBe('741810');
    expect(row.gstRate).toBe('12');
    // The columns beside them are unchanged.
    expect(row.quantity).toBe(12);
    expect(row.price.toString()).toBe('1250.5');
  });

  it('keeps the two fields independent per line', async () => {
    const res = await createOrder({
      items: [
        salesItemPayload({ hsnCode: '7418', gstRate: '18' }),
        salesItemPayload({ gstRate: 'NONE' }),
        salesItemPayload({ hsnCode: '9999AB' }),
      ],
    });

    expect(res.status).toBe(201);
    const items = res.body.data!.order.items;
    expect(items).toHaveLength(3);

    expect(items[0]!.hsnCode).toBe('7418');
    expect(items[0]!.gstRate).toBe('18');
    expect(items[1]!.hsnCode).toBeNull();
    expect(items[1]!.gstRate).toBe('NONE');
    expect(items[2]!.hsnCode).toBe('9999AB');
    expect(items[2]!.gstRate).toBeNull();
  });
});

describe('existing Sales behaviour is unchanged', () => {
  it('still creates an order with no HSN or GST anywhere', async () => {
    const res = await createOrder();
    expect(res.status).toBe(201);
    const order = res.body.data!.order;
    expect(order.status).toBe('OPEN');
    expect(order.items[0]!.lineTotal).toBe('15006.00');
  });

  it('still leaves productId null on an unlinked line', async () => {
    // The RS Product picker's behaviour, untouched by this change.
    const res = await createWithLine({ hsnCode: '7418', gstRate: '5' });
    expect(res.status).toBe(201);

    const row = await prisma.salesOrderItem.findUniqueOrThrow({
      where: { id: res.body.data!.order.items[0]!.id },
      select: { productId: true, productName: true },
    });
    expect(row.productId).toBeNull();
    expect(row.productName).toContain('product');
  });

  it('still rejects a line with no product name', async () => {
    const res = await createWithLine({ productName: '   ', gstRate: '18' });
    expect(res.status).toBe(422);
  });

  it('still rejects a zero price, with the new fields present', async () => {
    const res = await createWithLine({ price: '0.00', gstRate: '18' });
    expect(res.status).toBe(422);
  });
});

describe('lines written before these fields existed stay readable', () => {
  it('reads null for both on a row where the columns were never written', async () => {
    // Exactly the shape of the six pre-migration rows: the column exists, the
    // value was never set, and nothing was backfilled.
    const res = await createWithLine({});
    expect(res.status).toBe(201);
    const orderId = res.body.data!.order.id;

    const detail = await api<Wrapped>('GET', `/api/sales/${orderId}`, { token: ownerToken });
    expect(detail.status).toBe(200);

    const item = detail.body.data!.order.items[0]!;
    expect(item.hsnCode).toBeNull();
    expect(item.gstRate).toBeNull();
    // And the line still prices correctly.
    expect(item.lineTotal).toBe('15006.00');
  });
});
