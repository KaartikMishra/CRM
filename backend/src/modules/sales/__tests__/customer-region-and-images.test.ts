/**
 * Where the customer is, and which picture the order keeps.
 *
 * Three rules meet here, and all three are about the server being the one that
 * decides rather than the form:
 *
 *   1. A state belongs to India. `Customer.state` is closed to the States and
 *      Union Territories of India, so recording one against Lesotho is not a
 *      preference but a contradiction. The add-customer dialog disables the
 *      control; this proves the API refuses it regardless of what the dialog did.
 *
 *   2. Indian GST belongs to an Indian supply. A customer abroad cannot carry
 *      CGST, SGST or IGST, and an order that tries is refused — because the
 *      money guard would otherwise enforce a payable containing tax owed to
 *      nobody.
 *
 *   3. A line's own uploaded image is authoritative. The RS Product's catalogue
 *      image is a reference borrowed from the product, shown only when the line
 *      has no upload of its own, and it must never displace one.
 *
 * All of it runs against the real database, because every one of these rules is
 * a claim about what survives being written down and read back.
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
  makeRsProduct,
  makeUser,
  residualTestRows,
  salesItemPayload,
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type OrderBody = { order: SalesOrderDetail };
type CustomerBody = { customer: { id: string; state: string | null; country: string | null } };

let admin: TestUser;
let token: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  token = await mintToken(admin.id, { role: 'ADMIN' });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const newCustomer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `zz-test-customer-${Math.random().toString(36).slice(2, 8)}`,
  type: 'BULK',
  phone: '9876543210',
  ...overrides,
});

// ===========================================================================
//  A — the country decides whether a state may be recorded at all
// ===========================================================================

describe('a state is only recorded for a customer in India', () => {
  it('accepts India with a state', async () => {
    const res = await api<CustomerBody>('POST', '/api/customers', {
      token,
      body: newCustomer({ country: 'India', state: 'Karnataka' }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data!.customer.state).toBe('Karnataka');
    expect(res.body.data!.customer.country).toBe('India');
  });

  it('refuses India without a state', async () => {
    const res = await api('POST', '/api/customers', {
      token,
      body: newCustomer({ country: 'India' }),
    });

    expect(res.status).toBe(422);
  });

  it('refuses the contradiction the brief names: Lesotho with Haryana', async () => {
    // The exact pair that must never be stored. A disabled dropdown still holds
    // its value, so this is the layer that has to say no.
    const res = await api('POST', '/api/customers', {
      token,
      body: newCustomer({ country: 'Lesotho', state: 'Haryana' }),
    });

    expect(res.status).toBe(422);
  });

  it('accepts a country outside India when no state is sent', async () => {
    const res = await api<CustomerBody>('POST', '/api/customers', {
      token,
      body: newCustomer({ country: 'Lesotho' }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data!.customer.state).toBeNull();
  });

  it('still accepts a customer with no country at all', async () => {
    // Every row recorded before the field existed has none. They must stay
    // creatable and loadable, or the new rule breaks the existing master.
    const res = await api<CustomerBody>('POST', '/api/customers', {
      token,
      body: newCustomer(),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data!.customer.country).toBeNull();
  });
});

// ===========================================================================
//  B — Indian GST, and who it applies to
// ===========================================================================

describe('Indian GST applies to an Indian supply and no other', () => {
  it('splits an Indian customer into heads and charges the tax', async () => {
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });

    const res = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ quantity: 2, price: '100.00', gstRate: '18', gstMode: 'EXCLUSIVE' })],
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = res.body.data!.order;
    trackSalesOrder(order.id);

    expect(order.money.taxSplit).not.toBe('NONE');
    expect(order.money.taxTotal).toBe('36.00');
    expect(order.money.total).toBe('236.00');
  });

  it('refuses a taxed line for a customer abroad', async () => {
    const customer = await makeCustomer('BULK', { country: 'Lesotho' });

    const res = await api('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ quantity: 2, price: '100.00', gstRate: '18', gstMode: 'EXCLUSIVE' })],
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('GST_NOT_APPLICABLE');
  });

  it('accepts the same order once the lines carry no GST, and posts to no head', async () => {
    const customer = await makeCustomer('BULK', { country: 'Lesotho' });

    const res = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ quantity: 2, price: '100.00', gstRate: 'NONE', gstMode: 'EXCLUSIVE' })],
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = res.body.data!.order;
    trackSalesOrder(order.id);

    expect(order.money.taxSplit).toBe('NONE');
    expect(order.money.taxTotal).toBe('0.00');
    expect(order.money.cgstTotal).toBe('0.00');
    expect(order.money.sgstTotal).toBe('0.00');
    expect(order.money.igstTotal).toBe('0.00');
    // The goods are still owed for. Only the tax is absent.
    expect(order.money.total).toBe('200.00');
  });

  it('treats a zero-rated line as untaxed rather than as a refusal', async () => {
    // '0' and 'NONE' are different statements, and neither charges anything, so
    // both must be permitted for a customer abroad.
    const customer = await makeCustomer('BULK', { country: 'Lesotho' });

    const res = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ quantity: 1, price: '50.00', gstRate: '0', gstMode: 'EXCLUSIVE' })],
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    trackSalesOrder(res.body.data!.order.id);
  });

  it('leaves a customer with no country recorded taxed exactly as before', async () => {
    // The backward-compatibility case. Reading a blank country as an export
    // would silently strip the tax off historical orders.
    const customer = await makeCustomer('BULK', { state: 'Karnataka' });

    const res = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ quantity: 2, price: '100.00', gstRate: '18', gstMode: 'EXCLUSIVE' })],
      }),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = res.body.data!.order;
    trackSalesOrder(order.id);

    expect(order.money.taxSplit).not.toBe('NONE');
    expect(order.money.taxTotal).toBe('36.00');
  });
});

// ===========================================================================
//  C — which image the order keeps
// ===========================================================================

describe('a line keeps its own image, and borrows the catalogue one', () => {
  const CATALOGUE = 'https://cdn.example.test/zz-test-catalogue.jpg';

  it('shows the RS Product image when the line has no upload of its own', async () => {
    // Scenario 1 from the brief: pick a product, upload nothing, create, reopen.
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });
    const product = await makeRsProduct({ imageUrl: CATALOGUE });

    const created = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ rsProductId: product.id })],
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    trackSalesOrder(created.body.data!.order.id);

    // Read back through the detail endpoint, which is where it was disappearing.
    const detail = await api<OrderBody>('GET', `/api/sales/${created.body.data!.order.id}`, {
      token,
    });
    expect(detail.status).toBe(200);

    const line = detail.body.data!.order.items[0]!;
    expect(line.image, 'no upload was made, so the order owns no image').toBeNull();
    expect(line.catalogueImage?.url).toBe(CATALOGUE);
  });

  it('carries no catalogue image for a line pointing at no RS Product', async () => {
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });

    const created = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, { items: [salesItemPayload()] }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    trackSalesOrder(created.body.data!.order.id);

    const line = created.body.data!.order.items[0]!;
    expect(line.image).toBeNull();
    expect(line.catalogueImage).toBeNull();
  });

  it('keeps an RS Product line loadable when the product has no image at all', async () => {
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });
    const product = await makeRsProduct();

    const created = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ rsProductId: product.id })],
      }),
    });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    trackSalesOrder(created.body.data!.order.id);
    expect(created.body.data!.order.items[0]!.catalogueImage).toBeNull();
  });

  it('survives a reload, because it is resolved from the product every time', async () => {
    // Nothing is copied onto the line at creation, so the second read is the
    // one that proves the fix is persistence and not a create-time fallback.
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });
    const product = await makeRsProduct({ imageUrl: CATALOGUE });

    const created = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ rsProductId: product.id })],
      }),
    });
    const id = created.body.data!.order.id;
    trackSalesOrder(id);

    const first = await api<OrderBody>('GET', `/api/sales/${id}`, { token });
    const second = await api<OrderBody>('GET', `/api/sales/${id}`, { token });

    expect(first.body.data!.order.items[0]!.catalogueImage?.url).toBe(CATALOGUE);
    expect(second.body.data!.order.items[0]!.catalogueImage?.url).toBe(CATALOGUE);
  });

  it('shows the catalogue image on the list thumbnail too', async () => {
    const customer = await makeCustomer('BULK', { state: 'Karnataka', country: 'India' });
    const product = await makeRsProduct({ imageUrl: CATALOGUE });

    const created = await api<OrderBody>('POST', '/api/sales', {
      token,
      body: salesOrderPayload(customer.id, {
        items: [salesItemPayload({ rsProductId: product.id })],
      }),
    });
    const id = created.body.data!.order.id;
    trackSalesOrder(id);

    const list = await api<{ orders: { id: string; catalogueThumbnail: { url: string } | null }[] }>(
      'GET',
      '/api/sales?limit=50',
      { token },
    );

    const row = list.body.data!.orders.find((o) => o.id === id);
    expect(row?.catalogueThumbnail?.url).toBe(CATALOGUE);
  });
});

// ===========================================================================
//  D — the seller's own State reaches the browser
// ===========================================================================

describe('the session carries the seller state', () => {
  it('exposes it, so the new-order preview can name the right heads', async () => {
    /*
      Server configuration, so the browser has no other way to know it. Without
      it the preview called taxSplitFor with a null seller and every Indian
      customer read as intra-state — a Gujarat customer showed CGST + SGST
      however the seller was configured.

      Asserted as "the field is present", not as a value: SELLER_STATE is
      environment configuration and this suite must not depend on it being set.
      Null is a legitimate answer and is what taxSplitFor already handles.
    */
    const res = await api<{ sellerState: string | null }>('GET', '/api/auth/me', { token });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toHaveProperty('sellerState');
  });
});
