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
  makeVendor,
  residualTestRows,
  trackEnquiry,
  vendorResponsePayload,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type Wrapped = { enquiry: EnquiryDetail };

let owner: TestUser;
let token: string;
let customerId: string;
let vendor: { id: string; name: string };

beforeAll(async () => {
  await startTestServer();
  owner = await makeUser('USER');
  token = await mintToken(owner.id, { role: 'USER' });
  customerId = (await makeCustomer()).id;
  vendor = await makeVendor();
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

async function newEnquiry(count = 2): Promise<EnquiryDetail> {
  const res = await api<Wrapped>('POST', '/api/product-enquiries', {
    token,
    body: enquiryPayload(customerId, owner.id, count),
  });
  const enquiry = res.body.data!.enquiry;
  trackEnquiry(enquiry.id);
  return enquiry;
}

const respond = (enquiryId: string, productId: string, body = vendorResponsePayload(vendor.id)) =>
  api<Wrapped>(
    'POST',
    `/api/product-enquiries/${enquiryId}/products/${productId}/vendor-responses`,
    { token, body },
  );

const markNoVendor = (enquiryId: string, productId: string) =>
  api<Wrapped>('PATCH', `/api/product-enquiries/${enquiryId}/products/${productId}`, {
    token,
    body: { status: 'NO_VENDOR', noVendorReason: 'Required quantity unavailable' },
  });

describe('vendor responses', () => {
  it('records a response and marks the product RESPONDED', async () => {
    const enquiry = await newEnquiry(1);
    const res = await respond(enquiry.id, enquiry.products[0]!.id);

    expect(res.status).toBe(201);
    const product = res.body.data!.enquiry.products[0]!;
    expect(product.status).toBe('RESPONDED');
    expect(product.vendorResponses).toHaveLength(1);
    expect(product.vendorResponses[0]!.matchType).toBe('SIMILAR_PRODUCT');
  });

  it('keeps the rate exact as a decimal string', async () => {
    const enquiry = await newEnquiry(1);
    const res = await respond(enquiry.id, enquiry.products[0]!.id, {
      ...vendorResponsePayload(vendor.id),
      ratePerUnit: '1234.56',
    });

    const rate = res.body.data!.enquiry.products[0]!.vendorResponses[0]!.ratePerUnit;
    expect(rate).toBe('1234.56');
    expect(typeof rate).toBe('string');
  });

  it('accepts several responses from different vendors on one product', async () => {
    const enquiry = await newEnquiry(1);
    const second = await makeVendor();

    await respond(enquiry.id, enquiry.products[0]!.id);
    const res = await respond(enquiry.id, enquiry.products[0]!.id, {
      ...vendorResponsePayload(second.id),
      ratePerUnit: '910.00',
    });

    expect(res.body.data!.enquiry.products[0]!.vendorResponses).toHaveLength(2);
  });

  it('treats an identical immediate repeat as a retry, not a second quote', async () => {
    const enquiry = await newEnquiry(1);
    const body = vendorResponsePayload(vendor.id);

    await respond(enquiry.id, enquiry.products[0]!.id, body);
    const retry = await respond(enquiry.id, enquiry.products[0]!.id, body);

    expect(retry.status).toBe(201);
    expect(retry.body.data!.enquiry.products[0]!.vendorResponses).toHaveLength(1);
  });

  it('rejects an unknown vendor', async () => {
    const enquiry = await newEnquiry(1);
    const res = await respond(enquiry.id, enquiry.products[0]!.id, {
      ...vendorResponsePayload('clzzzzzzzzzzzzzzzzzzzzzzz'),
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('VENDOR_NOT_FOUND');
  });

  it('rejects a product from another enquiry', async () => {
    const mine = await newEnquiry(1);
    const other = await newEnquiry(1);

    const res = await respond(mine.id, other.products[0]!.id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each(['EXACT_PRODUCT', 'EXACT', 'SIMILAR'])(
    'rejects the removed match type %s',
    async (matchType) => {
      const enquiry = await newEnquiry(1);
      const res = await respond(enquiry.id, enquiry.products[0]!.id, {
        ...vendorResponsePayload(vendor.id),
        matchType,
      });

      expect(res.status).toBe(422);
    },
  );

  it('rejects a negative rate and a zero delivery time', async () => {
    const enquiry = await newEnquiry(1);

    const negative = await respond(enquiry.id, enquiry.products[0]!.id, {
      ...vendorResponsePayload(vendor.id),
      ratePerUnit: '-5.00',
    });
    expect(negative.status).toBe(422);

    const zeroDays = await respond(enquiry.id, enquiry.products[0]!.id, {
      ...vendorResponsePayload(vendor.id),
      deliveryWithinDays: 0,
    });
    expect(zeroDays.status).toBe(422);
  });
});

describe('partial submit', () => {
  it('moves to PARTIAL_CLOSED and keeps pending lines', async () => {
    const enquiry = await newEnquiry(3);
    await respond(enquiry.id, enquiry.products[0]!.id);

    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/partial-submit`, {
      token,
    });

    expect(res.status).toBe(200);
    const after = res.body.data!.enquiry;
    expect(after.status).toBe('PARTIAL_CLOSED');
    expect(after.products.filter((p) => p.status === 'PENDING')).toHaveLength(2);
    expect(after.partialSubmittedAt).not.toBeNull();
  });

  it('refuses when nothing has been responded to', async () => {
    const enquiry = await newEnquiry(2);
    const res = await api(`POST`, `/api/product-enquiries/${enquiry.id}/partial-submit`, { token });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_SUBMIT');
  });

  it('still accepts vendor responses afterwards', async () => {
    const enquiry = await newEnquiry(2);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await api(`POST`, `/api/product-enquiries/${enquiry.id}/partial-submit`, { token });

    const res = await respond(enquiry.id, enquiry.products[1]!.id);
    expect(res.status).toBe(201);
    expect(res.body.data!.enquiry.status).toBe('PARTIAL_CLOSED');
  });
});

describe('full submit', () => {
  it('refuses while any line is still pending, naming the lines', async () => {
    const enquiry = await newEnquiry(3);
    await respond(enquiry.id, enquiry.products[0]!.id);

    const res = await api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, { token });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FULL_SUBMIT_INCOMPLETE');
    expect(res.body.details).toHaveLength(2);
    expect(res.body.details![0]!.message).toContain('Line 2');
  });

  it('closes when every line is responded to', async () => {
    const enquiry = await newEnquiry(2);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await respond(enquiry.id, enquiry.products[1]!.id);

    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, {
      token,
    });

    expect(res.status).toBe(200);
    const after = res.body.data!.enquiry;
    expect(after.status).toBe('CLOSED');
    expect(after.closedAt).not.toBeNull();
    expect(after.closedBy?.id).toBe(owner.id);
  });

  it('closes when a mix of responses and NO_VENDOR resolves every line', async () => {
    const enquiry = await newEnquiry(3);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await markNoVendor(enquiry.id, enquiry.products[1]!.id);
    await respond(enquiry.id, enquiry.products[2]!.id);

    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, {
      token,
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.enquiry.status).toBe('CLOSED');
  });

  it('refuses a second submit once closed', async () => {
    const enquiry = await newEnquiry(1);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, { token });

    const again = await api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, { token });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ENQUIRY_CLOSED');
  });
});

describe('SLA freeze', () => {
  it('records ON_TIME when the first submit beats the deadline', async () => {
    const enquiry = await newEnquiry(1);
    await respond(enquiry.id, enquiry.products[0]!.id);

    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, {
      token,
    });

    const { sla } = res.body.data!.enquiry;
    expect(sla.efficiency).toBe('ON_TIME');
    expect(sla.firstSubmitAt).not.toBeNull();
    expect(sla.responseSeconds).toBeGreaterThanOrEqual(0);
    expect(sla.responseSeconds).toBeLessThan(15 * 60);
  });

  it('records DELAYED past the deadline, once the delay is explained', async () => {
    const enquiry = await newEnquiry(1);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await backdateEnquiry(enquiry.id, 40);

    const blocked = await api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, { token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('DELAY_REASON_REQUIRED');

    const reason = await api(`POST`, `/api/product-enquiries/${enquiry.id}/delay-reason`, {
      token,
      body: { reason: 'Vendor did not respond on time.' },
    });
    expect(reason.status).toBe(201);

    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, {
      token,
    });

    const after = res.body.data!.enquiry;
    expect(after.sla.efficiency).toBe('DELAYED');
    expect(after.sla.responseSeconds).toBeGreaterThan(15 * 60);
    expect(after.delays).toHaveLength(1);
    expect(after.events.map((e) => e.type)).toContain('DEADLINE_BREACHED');
    expect(after.events.map((e) => e.type)).toContain('DELAY_REASON_SUBMITTED');
  });

  it('freezes the verdict — a later submit never changes it', async () => {
    const enquiry = await newEnquiry(2);
    await respond(enquiry.id, enquiry.products[0]!.id);

    const first = await api<Wrapped>(
      `POST`,
      `/api/product-enquiries/${enquiry.id}/partial-submit`,
      { token },
    );
    const frozen = first.body.data!.enquiry.sla;
    expect(frozen.efficiency).toBe('ON_TIME');

    // Push the deadline into the past, then submit again.
    await backdateEnquiry(enquiry.id, 60);
    await respond(enquiry.id, enquiry.products[1]!.id);
    const second = await api<Wrapped>(
      `POST`,
      `/api/product-enquiries/${enquiry.id}/full-submit`,
      { token },
    );

    const after = second.body.data!.enquiry.sla;
    expect(after.efficiency).toBe('ON_TIME');
    expect(after.firstSubmitAt).toBe(frozen.firstSubmitAt);
    expect(after.responseSeconds).toBe(frozen.responseSeconds);
  });

  it('ignores client-supplied SLA fields entirely', async () => {
    const enquiry = await newEnquiry(1);
    await respond(enquiry.id, enquiry.products[0]!.id);

    await api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, {
      token,
      body: {
        firstSubmitAt: '1999-01-01T00:00:00.000Z',
        responseSeconds: 1,
        efficiency: 'ON_TIME',
      },
    });

    const row = await prisma.productEnquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      select: { firstSubmitAt: true, responseSeconds: true },
    });

    expect(row.firstSubmitAt!.getUTCFullYear()).toBeGreaterThan(2020);
    expect(row.responseSeconds).not.toBe(1);
  });

  it('survives simultaneous first submits with one verdict', async () => {
    const enquiry = await newEnquiry(1);
    await respond(enquiry.id, enquiry.products[0]!.id);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(`POST`, `/api/product-enquiries/${enquiry.id}/full-submit`, { token }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const row = await prisma.productEnquiry.findUniqueOrThrow({
      where: { id: enquiry.id },
      select: { status: true, firstSubmitAt: true, efficiency: true },
    });
    expect(row.status).toBe('CLOSED');
    expect(row.efficiency).toBe('ON_TIME');

    const closedEvents = await prisma.enquiryEvent.count({
      where: { enquiryId: enquiry.id, type: 'CLOSED' },
    });
    expect(closedEvents).toBe(1);
  });

  it('refuses a delay reason when the enquiry is not late', async () => {
    const enquiry = await newEnquiry(1);
    const res = await api(`POST`, `/api/product-enquiries/${enquiry.id}/delay-reason`, {
      token,
      body: { reason: 'Nothing is actually wrong' },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_DELAYED');
  });

  it('keeps every delay record rather than overwriting', async () => {
    const enquiry = await newEnquiry(1);
    await backdateEnquiry(enquiry.id, 40);

    await api(`POST`, `/api/product-enquiries/${enquiry.id}/delay-reason`, {
      token,
      body: { reason: 'First explanation for the delay' },
    });
    const res = await api<Wrapped>(`POST`, `/api/product-enquiries/${enquiry.id}/delay-reason`, {
      token,
      body: { reason: 'Second explanation for the delay' },
    });

    expect(res.body.data!.enquiry.delays).toHaveLength(2);
  });
});

describe('history', () => {
  it('records the whole lifecycle on the timeline', async () => {
    const enquiry = await newEnquiry(2);
    await respond(enquiry.id, enquiry.products[0]!.id);
    await markNoVendor(enquiry.id, enquiry.products[1]!.id);
    await api(`POST`, `/api/product-enquiries/${enquiry.id}/partial-submit`, { token });
    const final = await api<Wrapped>(
      `POST`,
      `/api/product-enquiries/${enquiry.id}/full-submit`,
      { token },
    );

    const types = final.body.data!.enquiry.events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'CREATED',
        'ASSIGNED',
        'VENDOR_RESPONSE_ADDED',
        'PRODUCT_UPDATED',
        'PARTIAL_SUBMITTED',
        'FULL_SUBMITTED',
        'CLOSED',
      ]),
    );

    // Every event names who did it and when.
    for (const event of final.body.data!.enquiry.events) {
      expect(event.occurredAt).toBeTruthy();
      expect(event.actor?.id).toBe(owner.id);
    }
  });
});
