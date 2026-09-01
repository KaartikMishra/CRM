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
  salesOrderId,
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

async function createOrder(overrides: Record<string, unknown> = {}, token = ownerToken) {
  const res = await api<Wrapped>('POST', '/api/sales', {
    token,
    body: salesOrderPayload(customerId, overrides),
  });
  if (res.status === 201 && res.body.data) trackSalesOrder(res.body.data.order.id);
  return res;
}

describe('create sales order', () => {
  it('creates an order and links it to the customer master', async () => {
    const res = await createOrder();

    expect(res.status).toBe(201);
    const order = res.body.data!.order;
    expect(order.status).toBe('OPEN');
    expect(order.customer.id).toBe(customerId);
    // Never dispatched, so no verdict has been reached yet.
    expect(order.efficiency).toBeNull();
    expect(order.dispatchedAt).toBeNull();
  });

  it('derives the total as quantity x price, exactly', async () => {
    const res = await createOrder({ items: [salesItemPayload({ quantity: 12, price: '1250.50' })] });

    expect(res.status).toBe(201);
    const { money } = res.body.data!.order;
    expect(money.total).toBe('15006.00');
    expect(money.paid).toBe('0.00');
    expect(money.pending).toBe('15006.00');
    expect(money.fullyPaid).toBe(false);
  });

  it('derives pending as total minus paid', async () => {
    const res = await createOrder({ items: [salesItemPayload({ quantity: 12, price: '1250.50' })], paidAmount: '5000' });

    const { money } = res.body.data!.order;
    expect(money.total).toBe('15006.00');
    expect(money.paid).toBe('5000.00');
    expect(money.pending).toBe('10006.00');
    expect(money.fullyPaid).toBe(false);
  });

  it('marks an order paid in full when paid equals total', async () => {
    const res = await createOrder({ items: [salesItemPayload({ quantity: 2, price: '10.00' })], paidAmount: '20.00' });

    const { money } = res.body.data!.order;
    expect(money.pending).toBe('0.00');
    expect(money.fullyPaid).toBe(true);
  });

  it('keeps sub-rupee amounts exact rather than drifting through a float', async () => {
    const res = await createOrder({ items: [salesItemPayload({ quantity: 3, price: '0.10' })] });

    expect(res.body.data!.order.money.total).toBe('0.30');
  });
});

describe('multiple products', () => {
  it('creates an order with several lines, numbered in order', async () => {
    const res = await createOrder({
      items: [
        salesItemPayload({ productName: `${'zz-test'}-a`, quantity: 2, price: '100.00' }),
        salesItemPayload({ productName: `${'zz-test'}-b`, quantity: 3, price: '250.50' }),
        salesItemPayload({ productName: `${'zz-test'}-c`, quantity: 1, price: '99.99' }),
      ],
    });

    expect(res.status).toBe(201);
    const order = res.body.data!.order;
    expect(order.items).toHaveLength(3);
    expect(order.items.map((i) => i.lineNo)).toEqual([1, 2, 3]);
    expect(order.items.every((i) => i.status === 'ACTIVE')).toBe(true);
    // Created with the order, so nothing was approved.
    expect(order.items.every((i) => i.approvedBy === null)).toBe(true);
  });

  it('gives each line its own total', async () => {
    const res = await createOrder({
      items: [
        salesItemPayload({ quantity: 2, price: '100.00' }),
        salesItemPayload({ quantity: 3, price: '250.50' }),
      ],
    });

    const [first, second] = res.body.data!.order.items;
    expect(first!.lineTotal).toBe('200.00');
    expect(second!.lineTotal).toBe('751.50');
  });

  it('sums the order total across every line, exactly', async () => {
    const res = await createOrder({
      items: [
        salesItemPayload({ quantity: 2, price: '100.00' }), //  200.00
        salesItemPayload({ quantity: 3, price: '250.50' }), //  751.50
        salesItemPayload({ quantity: 1, price: '99.99' }), //    99.99
      ],
    });

    const { money } = res.body.data!.order;
    expect(money.total).toBe('1051.49');
    expect(money.pending).toBe('1051.49');
    expect(money.activeItemCount).toBe(3);
  });

  it('keeps a many-line sum free of floating point drift', async () => {
    // Ten lines of 0.10 each: a float would land on 0.9999999999999999.
    const res = await createOrder({
      items: Array.from({ length: 10 }, () => salesItemPayload({ quantity: 1, price: '0.10' })),
    });

    expect(res.body.data!.order.money.total).toBe('1.00');
  });

  it('computes pending across multiple lines after a payment', async () => {
    const res = await createOrder({
      items: [
        salesItemPayload({ quantity: 2, price: '100.00' }),
        salesItemPayload({ quantity: 3, price: '250.50' }),
      ],
      paidAmount: '451.50',
    });

    const { money } = res.body.data!.order;
    expect(money.total).toBe('951.50');
    expect(money.paid).toBe('451.50');
    expect(money.pending).toBe('500.00');
  });

  it('refuses an order with no lines at all', async () => {
    const res = await createOrder({ items: [] });
    expect(res.status).toBe(422);
  });

  it('refuses when any single line is invalid', async () => {
    const res = await createOrder({
      items: [salesItemPayload(), salesItemPayload({ quantity: 0 })],
    });
    expect(res.status).toBe(422);
  });

  it('measures the paid ceiling against the whole order, not one line', async () => {
    // 200 + 751.50 = 951.50; paying 900 is fine even though it exceeds line one.
    const res = await createOrder({
      items: [
        salesItemPayload({ quantity: 2, price: '100.00' }),
        salesItemPayload({ quantity: 3, price: '250.50' }),
      ],
      paidAmount: '900.00',
    });

    expect(res.status).toBe(201);
    expect(res.body.data!.order.money.pending).toBe('51.50');
  });
});

describe('order id', () => {
  it('accepts the formats real orders arrive in', async () => {
    for (const orderId of ['#2001', 'RS-2001/A', 'SO_2026_44']) {
      const res = await createOrder({ orderId: `${orderId}-${salesOrderId()}` });
      expect(res.status).toBe(201);
    }
  });

  it('refuses a duplicate order id with a specific code', async () => {
    const orderId = salesOrderId();
    expect((await createOrder({ orderId })).status).toBe(201);

    const duplicate = await createOrder({ orderId });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_ORDER_ID');
  });

  it('is never generated — a missing order id is rejected', async () => {
    const res = await createOrder({ orderId: undefined });
    expect(res.status).toBe(422);
  });
});

describe('input validation', () => {
  const rejects = async (label: string, overrides: Record<string, unknown>) => {
    const res = await createOrder(overrides);
    expect(res.status, label).toBe(422);
  };

  it('refuses a quantity below 1 or not a whole number', async () => {
    await rejects('zero', { items: [salesItemPayload({ quantity: 0 })] });
    await rejects('negative', { items: [salesItemPayload({ quantity: -5 })] });
    await rejects('fractional', { items: [salesItemPayload({ quantity: 1.5 })] });
  });

  it('refuses a price that is not positive', async () => {
    await rejects('zero', { items: [salesItemPayload({ price: '0' })] });
    await rejects('negative', { items: [salesItemPayload({ price: '-10.00' })] });
  });

  it('refuses more than two decimal places on money', async () => {
    await rejects('three dp', { items: [salesItemPayload({ price: '10.005' })] });
  });

  it('refuses a paid amount above the total', async () => {
    await rejects('overpaid', { items: [salesItemPayload({ quantity: 1, price: '10.00' })], paidAmount: '11.00' });
  });

  it('refuses a dispatch deadline before the order date', async () => {
    await rejects('deadline first', {
      orderDate: new Date('2026-08-10').toISOString(),
      toBeDispatchedBy: new Date('2026-08-01').toISOString(),
    });
  });

  it('allows a same-day dispatch deadline', async () => {
    const sameDay = new Date('2026-08-10').toISOString();
    const res = await createOrder({ orderDate: sameDay, toBeDispatchedBy: sameDay });
    expect(res.status).toBe(201);
  });
});

describe('customer contact details', () => {
  it('exposes name, phone and email on the detail payload', async () => {
    const withContact = await makeCustomer('RETAIL', {
      phone: '+91 98765 43210',
      email: 'buyer@example.com',
    });

    const created = await api<Wrapped>('POST', '/api/sales', {
      token: ownerToken,
      body: salesOrderPayload(withContact.id),
    });
    expect(created.status).toBe(201);
    trackSalesOrder(created.body.data!.order.id);

    const res = await api<Wrapped>('GET', `/api/sales/${created.body.data!.order.id}`, {
      token: ownerToken,
    });

    expect(res.status).toBe(200);
    const customer = res.body.data!.order.customer;
    // Asserted against what the fixture stored, so this tests the contract —
    // the API surfaces the customer's own contact details — rather than
    // restating a literal. (The fixture writes through Prisma directly, so the
    // create-schema's trim/lowercase normalisation is not in play here.)
    expect(customer.name).toBe(withContact.name);
    expect(customer.phone).toBe(withContact.phone);
    expect(customer.email).toBe(withContact.email);
  });

  it('reports contact details as null when the customer has none', async () => {
    const res = await api<Wrapped>('POST', '/api/sales', {
      token: ownerToken,
      body: salesOrderPayload(customerId),
    });
    trackSalesOrder(res.body.data!.order.id);

    const detail = await api<Wrapped>('GET', `/api/sales/${res.body.data!.order.id}`, {
      token: ownerToken,
    });

    expect(detail.body.data!.order.customer.phone).toBeNull();
    expect(detail.body.data!.order.customer.email).toBeNull();
  });

  it('keeps contact details off the list payload', async () => {
    // A table row has no use for them, and they should not travel with 25 rows.
    const res = await api<{ orders: Record<string, unknown>[] }>('GET', '/api/sales?limit=1', {
      token: ownerToken,
    });

    expect(res.status).toBe(200);
    const [first] = res.body.data!.orders;
    if (first) {
      const customer = first.customer as Record<string, unknown>;
      expect(customer).not.toHaveProperty('phone');
      expect(customer).not.toHaveProperty('email');
    }
  });
});

describe('derived and workflow fields are not settable', () => {
  it('ignores a client attempting to set totals, status or efficiency', async () => {
    const res = await createOrder({
      items: [salesItemPayload({ quantity: 2, price: '100.00' })],
      totalAmount: '1.00',
      pendingAmount: '1.00',
      status: 'CLOSED',
      efficiency: 'ON_TIME',
    });

    expect(res.status).toBe(201);
    const order = res.body.data!.order;
    // The smuggled values were stripped, not honoured.
    expect(order.money.total).toBe('200.00');
    expect(order.money.pending).toBe('200.00');
    expect(order.status).toBe('OPEN');
    expect(order.efficiency).toBeNull();
  });
});
