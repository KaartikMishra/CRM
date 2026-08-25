import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnquiryDetail } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  backdateEnquiry,
  cleanup,
  enquiryPayload,
  makeCustomer,
  makeUser,
  residualTestRows,
  trackEnquiry,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { enquiry: EnquiryDetail };

let admin: TestUser;
let owner: TestUser;
let adminToken: string;
let ownerToken: string;
let customerId: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  owner = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  ownerToken = await mintToken(owner.id, { role: 'USER' });
  customerId = (await makeCustomer('CORPORATE_GIFTING')).id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function createEnquiry(count: number, token = ownerToken) {
  const res = await api<Wrapped>('POST', '/api/product-enquiries', {
    token,
    body: enquiryPayload(customerId, owner.id, count),
  });
  if (res.status === 201 && res.body.data) trackEnquiry(res.body.data.enquiry.id);
  return res;
}

describe('create enquiry', () => {
  it('creates an enquiry with one product', async () => {
    const res = await createEnquiry(1);

    expect(res.status).toBe(201);
    const enquiry = res.body.data!.enquiry;
    expect(enquiry.products).toHaveLength(1);
    expect(enquiry.status).toBe('OPEN');
    expect(enquiry.products[0]!.lineNo).toBe(1);
  });

  it('creates an enquiry with the maximum 20 products', async () => {
    const res = await createEnquiry(20);

    expect(res.status).toBe(201);
    const lineNos = res.body.data!.enquiry.products.map((p) => p.lineNo);
    expect(lineNos).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rejects an enquiry with no products', async () => {
    const res = await createEnquiry(0);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an enquiry with 21 products', async () => {
    const res = await createEnquiry(21);
    expect(res.status).toBe(422);
    expect(res.body.details?.some((d) => d.path.startsWith('products'))).toBe(true);
  });

  it('rejects an unknown customer', async () => {
    const res = await api('POST', '/api/product-enquiries', {
      token: ownerToken,
      body: { ...enquiryPayload('clzzzzzzzzzzzzzzzzzzzzzzz', owner.id, 1) },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('rejects an invalid source', async () => {
    const body = enquiryPayload(customerId, owner.id, 1);
    const res = await api('POST', '/api/product-enquiries', {
      token: ownerToken,
      body: { ...body, source: 'CARRIER_PIGEON' },
    });
    expect(res.status).toBe(422);
  });

  it('rejects OTHERS without a sourceDetail', async () => {
    const body = enquiryPayload(customerId, owner.id, 1);
    const res = await api('POST', '/api/product-enquiries', {
      token: ownerToken,
      body: { ...body, source: 'OTHERS' },
    });
    expect(res.status).toBe(422);
    expect(res.body.details?.some((d) => d.path === 'sourceDetail')).toBe(true);
  });

  it('accepts OTHERS when the source is specified', async () => {
    const body = enquiryPayload(customerId, owner.id, 1);
    const res = await api<Wrapped>('POST', '/api/product-enquiries', {
      token: ownerToken,
      body: { ...body, source: 'OTHERS', sourceDetail: 'Trade fair' },
    });
    expect(res.status).toBe(201);
    trackEnquiry(res.body.data!.enquiry.id);
    expect(res.body.data!.enquiry.sourceDetail).toBe('Trade fair');
  });

  it('allocates a unique, formatted enquiry number', async () => {
    const a = await createEnquiry(1);
    const b = await createEnquiry(1);

    const numberA = a.body.data!.enquiry.enquiryNo;
    const numberB = b.body.data!.enquiry.enquiryNo;

    expect(numberA).toMatch(/^ENQ-\d{4}(-\d{2})?-\d{6}$/);
    expect(numberA).not.toBe(numberB);
  });

  it('sets the SLA window from the database clock', async () => {
    const res = await createEnquiry(1);
    const { sla } = res.body.data!.enquiry;

    expect(sla.slaMinutes).toBe(15);
    const elapsed =
      new Date(sla.slaDeadlineAt).getTime() - new Date(sla.createdAt).getTime();
    expect(elapsed).toBe(15 * 60_000);
    expect(sla.firstSubmitAt).toBeNull();
    expect(sla.efficiency).toBeNull();
  });

  it('records CREATED and ASSIGNED on the timeline', async () => {
    const res = await createEnquiry(1);
    const types = res.body.data!.enquiry.events.map((e) => e.type);
    expect(types).toContain('CREATED');
    expect(types).toContain('ASSIGNED');
  });

  it('rolls back completely when a product is invalid', async () => {
    const before = await prisma.productEnquiry.count();
    const body = enquiryPayload(customerId, owner.id, 2) as {
      products: { quantity: number }[];
    };
    body.products[1]!.quantity = -5;

    const res = await api('POST', '/api/product-enquiries', { token: ownerToken, body });

    expect(res.status).toBe(422);
    expect(await prisma.productEnquiry.count()).toBe(before);
  });
});

describe('add product', () => {
  it('appends the next line number', async () => {
    const created = await createEnquiry(2);
    const id = created.body.data!.enquiry.id;

    const res = await api<Wrapped>('POST', `/api/product-enquiries/${id}/products`, {
      token: ownerToken,
      body: { name: 'added line', quantity: 5, similarOptionNeeded: false },
    });

    expect(res.status).toBe(201);
    expect(res.body.data!.enquiry.products.map((p) => p.lineNo)).toEqual([1, 2, 3]);
  });

  it('accepts the twentieth product and refuses the twenty-first', async () => {
    const created = await createEnquiry(19);
    const id = created.body.data!.enquiry.id;

    const twentieth = await api<Wrapped>('POST', `/api/product-enquiries/${id}/products`, {
      token: ownerToken,
      body: { name: 'line twenty', quantity: 1, similarOptionNeeded: false },
    });
    expect(twentieth.status).toBe(201);
    expect(twentieth.body.data!.enquiry.products).toHaveLength(20);

    const twentyFirst = await api('POST', `/api/product-enquiries/${id}/products`, {
      token: ownerToken,
      body: { name: 'line twenty one', quantity: 1, similarOptionNeeded: false },
    });
    expect(twentyFirst.status).toBe(409);
    expect(twentyFirst.body.code).toBe('MAX_PRODUCTS_REACHED');

    expect(await prisma.enquiryProduct.count({ where: { enquiryId: id } })).toBe(20);
  });

  it('rejects a duplicate lineNo at the database level', async () => {
    const created = await createEnquiry(1);
    const id = created.body.data!.enquiry.id;

    await expect(
      prisma.enquiryProduct.create({
        data: { enquiryId: id, lineNo: 1, name: 'clash', quantity: 1 },
      }),
    ).rejects.toThrow();
  });

  it('rejects lineNo 21 at the database level', async () => {
    const created = await createEnquiry(1);
    const id = created.body.data!.enquiry.id;

    await expect(
      prisma.enquiryProduct.create({
        data: { enquiryId: id, lineNo: 21, name: 'over', quantity: 1 },
      }),
    ).rejects.toThrow();
  });

  it('refuses an unknown enquiry without revealing anything', async () => {
    const res = await api('POST', '/api/product-enquiries/clzzzzzzzzzzzzzzzzzzzzzzz/products', {
      token: ownerToken,
      body: { name: 'ghost', quantity: 1, similarOptionNeeded: false },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRODUCT_ENQUIRY_NOT_FOUND');
  });
});

describe('update product', () => {
  it('updates name and quantity', async () => {
    const created = await createEnquiry(1);
    const enquiry = created.body.data!.enquiry;

    const res = await api<Wrapped>(
      'PATCH',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}`,
      { token: ownerToken, body: { name: 'renamed', quantity: 99 } },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.enquiry.products[0]!.name).toBe('renamed');
    expect(res.body.data!.enquiry.products[0]!.quantity).toBe(99);
  });

  it('rejects NO_VENDOR without a reason', async () => {
    const created = await createEnquiry(1);
    const enquiry = created.body.data!.enquiry;

    const res = await api(
      'PATCH',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}`,
      { token: ownerToken, body: { status: 'NO_VENDOR' } },
    );

    expect(res.status).toBe(422);
    expect(res.body.details?.some((d) => d.path === 'noVendorReason')).toBe(true);
  });

  it('accepts NO_VENDOR with a reason', async () => {
    const created = await createEnquiry(1);
    const enquiry = created.body.data!.enquiry;

    const res = await api<Wrapped>(
      'PATCH',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}`,
      {
        token: ownerToken,
        body: { status: 'NO_VENDOR', noVendorReason: 'Required quantity unavailable' },
      },
    );

    expect(res.status).toBe(200);
    const product = res.body.data!.enquiry.products[0]!;
    expect(product.status).toBe('NO_VENDOR');
    expect(product.noVendorReason).toBe('Required quantity unavailable');
  });

  it('refuses a product belonging to a different enquiry', async () => {
    const mine = await createEnquiry(1);
    const theirs = await createEnquiry(1);

    const res = await api(
      'PATCH',
      `/api/product-enquiries/${mine.body.data!.enquiry.id}/products/${
        theirs.body.data!.enquiry.products[0]!.id
      }`,
      { token: ownerToken, body: { name: 'crossed wires' } },
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('refuses edits once the enquiry is closed', async () => {
    const created = await createEnquiry(1);
    const enquiry = created.body.data!.enquiry;

    await api(
      'PATCH',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}`,
      { token: ownerToken, body: { status: 'NO_VENDOR', noVendorReason: 'none available' } },
    );
    await api('POST', `/api/product-enquiries/${enquiry.id}/full-submit`, { token: ownerToken });

    const res = await api(
      'PATCH',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}`,
      { token: ownerToken, body: { name: 'too late' } },
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENQUIRY_CLOSED');
  });
});

describe('concurrency', () => {
  it('never creates a twenty-first product under parallel requests', async () => {
    const created = await createEnquiry(18);
    const id = created.body.data!.enquiry.id;

    // Six simultaneous adds against two free slots.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api('POST', `/api/product-enquiries/${id}/products`, {
          token: ownerToken,
          body: { name: `race-${i}`, quantity: 1, similarOptionNeeded: false },
        }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const accepted = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409).length;

    // Checked first so a transient infrastructure failure reports itself
    // plainly instead of surfacing as a confusing count mismatch below.
    expect(results.filter((r) => r.status >= 500), `statuses: ${statuses}`).toHaveLength(0);
    expect(statuses.every((s) => s === 201 || s === 409), `statuses: ${statuses}`).toBe(true);

    // Two slots were free, so exactly two requests win and the rest are told
    // the limit is reached. The row lock is what makes this deterministic.
    expect(accepted).toBe(2);
    expect(refused).toBe(4);

    // The guarantee that survives regardless: the database cannot hold 21.
    expect(await prisma.enquiryProduct.count({ where: { enquiryId: id } })).toBe(20);
  });
});

describe('SLA breach detection', () => {
  it('reports breached once the deadline passes with nothing submitted', async () => {
    const created = await createEnquiry(1);
    const id = created.body.data!.enquiry.id;

    await backdateEnquiry(id, 30);

    const res = await api<Wrapped>('GET', `/api/product-enquiries/${id}`, { token: ownerToken });
    expect(res.body.data!.enquiry.sla.breached).toBe(true);
    expect(res.body.data!.enquiry.sla.efficiency).toBeNull();
  });
});
