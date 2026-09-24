/**
 * Product Enquiry's two capabilities, and what each one actually decides.
 *
 *   Raiser    holds PRODUCT_ENQUIRY CREATE. Took the enquiry, has to ring the
 *             customer back, so sees the name, phone and email.
 *   Answerer  holds PRODUCT_ENQUIRY EDIT. Sources and prices the goods, which
 *             is what the vendor-response endpoints are for.
 *
 * They are INDEPENDENT. Somebody may hold both, one, or neither, so the matrix
 * has four corners and all four are exercised here. Holding both is a union and
 * never a subtraction: it sees everything a Raiser sees and does everything an
 * Answerer does.
 *
 * EXACTLY THREE FIELDS are withheld from somebody without Raiser access — name,
 * phone, email. Address, state, GST number and customer type go to everybody:
 * an Answerer has to know where the goods are going and how the sale is taxed,
 * and none of that says who the buyer is. The tests below assert both halves,
 * because over-redaction is a real failure too — it takes away information the
 * Answerer's job needs.
 *
 * What these tests are really for is that the withholding is done by the
 * SERVER, not by the page. Every assertion reads the raw API payload: a UI that
 * simply declines to render a field still shipped it to the browser, where
 * anyone can open the network tab.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnquiryDetail, EnquirySummary } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
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

type DetailBody = { enquiry: EnquiryDetail };
type ListBody = { enquiries: EnquirySummary[] };

/** The four corners of the matrix. */
let raiser: TestUser; //  CREATE only
let answerer: TestUser; //  EDIT only
let both: TestUser; //  CREATE + EDIT
let neither: TestUser; //  VIEW alone

let raiserToken: string;
let answererToken: string;
let bothToken: string;
let neitherToken: string;

/** A customer with every field filled in — nothing to hide otherwise. */
const PHONE = '9876500011';
const EMAIL = 'zz-test-contact@test.invalid';
const ADDRESS = 'zz-test 14 Brigade Road\nSecond floor';
const STATE = 'Karnataka';
const GSTIN = '29ZZTEST0001Z5';
const COMPANY = 'zz-test Royal Traders Pvt Ltd';

let customerId: string;
let customerName: string;
let vendorId: string;

/** Raised by the Raiser, Towards the Answerer — the ordinary shape. */
let enquiryId: string;
let enquiryNo: string;
let productId: string;

/** Raised by the Raiser and Towards the Raiser, so ownership cannot mask the gate. */
let ownEnquiryId: string;
let ownProductId: string;

/**
 * Writes the two capability rows directly, which is exactly what the admin
 * endpoint does — one row per action, `allowed` false being as authoritative as
 * true. SALES CREATE is revoked on all four so the customer directory can only
 * be reached through Product Enquiry, which is the thing under test.
 */
async function grant(
  userId: string,
  { create, edit }: { create: boolean; edit: boolean },
): Promise<void> {
  await prisma.userModulePermission.createMany({
    data: [
      { userId, module: 'PRODUCT_ENQUIRY', action: 'VIEW', allowed: true },
      { userId, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: create },
      { userId, module: 'PRODUCT_ENQUIRY', action: 'EDIT', allowed: edit },
      { userId, module: 'SALES', action: 'CREATE', allowed: false },
    ],
  });
}

beforeAll(async () => {
  await startTestServer();

  [raiser, answerer, both, neither] = await Promise.all([
    makeUser('USER'),
    makeUser('USER'),
    makeUser('USER'),
    makeUser('USER'),
  ]);

  await Promise.all([
    grant(raiser.id, { create: true, edit: false }),
    grant(answerer.id, { create: false, edit: true }),
    grant(both.id, { create: true, edit: true }),
    grant(neither.id, { create: false, edit: false }),
  ]);

  [raiserToken, answererToken, bothToken, neitherToken] = await Promise.all([
    mintToken(raiser.id, { role: 'USER' }),
    mintToken(answerer.id, { role: 'USER' }),
    mintToken(both.id, { role: 'USER' }),
    mintToken(neither.id, { role: 'USER' }),
  ]);

  const customer = await makeCustomer('RETAIL', {
    companyName: COMPANY,
    phone: PHONE,
    email: EMAIL,
    address: ADDRESS,
    state: STATE,
    gstNumber: GSTIN,
  });
  customerId = customer.id;
  customerName = customer.name;
  vendorId = (await makeVendor()).id;

  const res = await api<DetailBody>('POST', '/api/product-enquiries', {
    token: raiserToken,
    body: enquiryPayload(customerId, answerer.id),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  enquiryId = res.body.data!.enquiry.id;
  enquiryNo = res.body.data!.enquiry.enquiryNo;
  productId = res.body.data!.enquiry.products[0]!.id;
  trackEnquiry(enquiryId);

  const own = await api<DetailBody>('POST', '/api/product-enquiries', {
    token: raiserToken,
    body: enquiryPayload(customerId, raiser.id),
  });
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  ownEnquiryId = own.body.data!.enquiry.id;
  ownProductId = own.body.data!.enquiry.products[0]!.id;
  trackEnquiry(ownEnquiryId);
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const detailAs = (token: string) =>
  api<DetailBody>('GET', `/api/product-enquiries/${enquiryId}`, { token });

// ===========================================================================
//  Raising — the CREATE half
// ===========================================================================

describe('raising an enquiry follows the Raiser capability alone', () => {
  it('a Raiser can', async () => {
    const res = await api<DetailBody>('POST', '/api/product-enquiries', {
      token: raiserToken,
      body: enquiryPayload(customerId, raiser.id),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    trackEnquiry(res.body.data!.enquiry.id);
  });

  it('somebody holding both can', async () => {
    const res = await api<DetailBody>('POST', '/api/product-enquiries', {
      token: bothToken,
      body: enquiryPayload(customerId, both.id),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    trackEnquiry(res.body.data!.enquiry.id);
  });

  it('an Answerer cannot — holding EDIT is not holding CREATE', async () => {
    const res = await api('POST', '/api/product-enquiries', {
      token: answererToken,
      body: enquiryPayload(customerId, answerer.id),
    });

    expect(res.status).toBe(403);
  });

  it('somebody with neither cannot', async () => {
    const res = await api('POST', '/api/product-enquiries', {
      token: neitherToken,
      body: enquiryPayload(customerId, neither.id),
    });

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
//  Reading — narrowed for nobody
// ===========================================================================

describe('viewing an enquiry', () => {
  it('all four can read it — only the customer is narrowed, never the enquiry', async () => {
    for (const token of [raiserToken, answererToken, bothToken, neitherToken]) {
      const res = await detailAs(token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data!.enquiry.id).toBe(enquiryId);
    }
  });
});

// ===========================================================================
//  The customer — exactly three fields
// ===========================================================================

describe('Raiser access carries the customer identity', () => {
  it('a Raiser gets name, phone and email', async () => {
    const customer = (await detailAs(raiserToken)).body.data!.enquiry.customer;

    expect(customer.name).toBe(customerName);
    expect(customer.companyName).toBe(COMPANY);
    expect(customer.phone).toBe(PHONE);
    expect(customer.email).toBe(EMAIL);
  });

  it('somebody holding both gets them too — the capabilities are a union', async () => {
    const customer = (await detailAs(bothToken)).body.data!.enquiry.customer;

    expect(customer.name).toBe(customerName);
    expect(customer.phone).toBe(PHONE);
    expect(customer.email).toBe(EMAIL);
  });

  it('a Raiser gets the name on list rows', async () => {
    const res = await api<ListBody>('GET', '/api/product-enquiries?limit=50', {
      token: raiserToken,
    });
    const row = res.body.data!.enquiries.find((e) => e.id === enquiryId);

    expect(row, 'the enquiry should be listed').toBeDefined();
    expect(row!.customer.name).toBe(customerName);
  });
});

describe('without Raiser access exactly three fields are withheld', () => {
  it('name, company name, phone and email arrive null', async () => {
    const customer = (await detailAs(answererToken)).body.data!.enquiry.customer;

    expect(customer.name).toBeNull();
    /*
      companyName follows the identity, not the address. A firm's name says
      who the buyer is at least as plainly as a person's does, so sending it
      to somebody who may not see `name` would undo the rule, not extend it.
    */
    expect(customer.companyName).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.email).toBeNull();
  });

  it('address, state, GST and customer type are NOT withheld', async () => {
    /*
      The other half of the rule, and a regression this suite exists to catch:
      redacting the whole customer object would take away what an Answerer's own
      job needs — where the goods go, and how the sale is taxed.
    */
    const customer = (await detailAs(answererToken)).body.data!.enquiry.customer;

    expect(customer.country).toBeNull(); // never set on this fixture, never withheld
    expect(customer.address).toBe(ADDRESS);
    expect(customer.state).toBe(STATE);
    expect(customer.gstNumber).toBe(GSTIN);
    expect(customer.type).toBe('RETAIL');
  });

  it('holds for somebody with neither capability as well', async () => {
    const customer = (await detailAs(neitherToken)).body.data!.enquiry.customer;

    expect(customer.name).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.email).toBeNull();
    expect(customer.state).toBe(STATE);
  });

  it('carries the three values nowhere in the raw response body', async () => {
    /*
      The assertion that actually matters. A field could be nulled on the shape
      the type describes while the same string still travels somewhere else in
      the payload — an event's metadata, a nested projection. Searching the
      serialised body is the only check that covers every one of those at once.
    */
    const raw = JSON.stringify((await detailAs(answererToken)).body);

    expect(raw).not.toContain(customerName);
    expect(raw).not.toContain(COMPANY);
    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain(EMAIL);
  });

  it('gets a null name on list rows, and no contact anywhere in the list', async () => {
    const res = await api<ListBody>('GET', '/api/product-enquiries?limit=50', {
      token: answererToken,
    });
    const row = res.body.data!.enquiries.find((e) => e.id === enquiryId);

    expect(row, 'the enquiry should still be listed').toBeDefined();
    expect(row!.customer.name).toBeNull();

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(customerName);
    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain(EMAIL);
  });

  it('still sees the enquiry number and its products — their actual job', async () => {
    const enquiry = (await detailAs(answererToken)).body.data!.enquiry;

    expect(enquiry.enquiryNo).toBe(enquiryNo);
    expect(enquiry.products.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
//  Vendor responses — the EDIT half
// ===========================================================================

describe('vendor responses follow the Answerer capability alone', () => {
  it('an Answerer who is Towards may record one', async () => {
    const res = await api(
      'POST',
      `/api/product-enquiries/${enquiryId}/products/${productId}/vendor-responses`,
      { token: answererToken, body: vendorResponsePayload(vendorId) },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a Raiser may not — even on an enquiry they raised and are Towards on', async () => {
    /*
      Deliberately the enquiry the Raiser both raised and holds Towards, so a
      pass here cannot be the ownership rule doing the work. The capability is
      what refuses it.
    */
    const res = await api(
      'POST',
      `/api/product-enquiries/${ownEnquiryId}/products/${ownProductId}/vendor-responses`,
      { token: raiserToken, body: vendorResponsePayload(vendorId) },
    );

    expect(res.status).toBe(403);
  });

  it('somebody with neither capability may not', async () => {
    const res = await api(
      'POST',
      `/api/product-enquiries/${enquiryId}/products/${productId}/vendor-responses`,
      { token: neitherToken, body: vendorResponsePayload(vendorId) },
    );

    expect(res.status).toBe(403);
  });

  it('submitting is Answerer-only too', async () => {
    expect(
      (
        await api('POST', `/api/product-enquiries/${ownEnquiryId}/partial-submit`, {
          token: raiserToken,
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await api('POST', `/api/product-enquiries/${ownEnquiryId}/full-submit`, {
          token: raiserToken,
        })
      ).status,
    ).toBe(403);
  });
});

// ===========================================================================
//  Editing the enquiry itself — either capability
// ===========================================================================

describe('editing the enquiry record is open to either capability', () => {
  it('an Answerer may, and the response is redacted on the way back out', async () => {
    /*
      The path easiest to miss: a write answers with the full detail payload, so
      the redaction has to hold coming out of a write and not only on a GET.
    */
    const res = await api<DetailBody>('PATCH', `/api/product-enquiries/${enquiryId}`, {
      token: answererToken,
      body: { sourceDetail: 'zz-test answered' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.enquiry.customer.name).toBeNull();
    expect(res.body.data!.enquiry.customer.phone).toBeNull();
    // ...and the parts that are never withheld survived the write.
    expect(res.body.data!.enquiry.customer.state).toBe(STATE);
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });

  it('a Raiser may, on their own enquiry', async () => {
    const res = await api<DetailBody>('PATCH', `/api/product-enquiries/${ownEnquiryId}`, {
      token: raiserToken,
      body: { sourceDetail: 'zz-test raised' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data!.enquiry.customer.name).toBe(customerName);
  });

  it('somebody with neither capability may not', async () => {
    const res = await api('PATCH', `/api/product-enquiries/${enquiryId}`, {
      token: neitherToken,
      body: { sourceDetail: 'zz-test nobody' },
    });

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
//  The ways round it
// ===========================================================================

describe('the customer identity cannot be reached by another route', () => {
  it('search does not let an Answerer probe for a phone number', async () => {
    /*
      Matching on contact fields is a disclosure even when the row that comes
      back is redacted: a search for a phone number that returns exactly one
      enquiry confirms whose it is, one query at a time. For a Raiser the same
      search is a feature.
    */
    const asAnswerer = await api<ListBody>(
      'GET',
      `/api/product-enquiries?limit=50&q=${encodeURIComponent(PHONE)}`,
      { token: answererToken },
    );
    expect(asAnswerer.status).toBe(200);
    expect(asAnswerer.body.data!.enquiries).toHaveLength(0);

    const asRaiser = await api<ListBody>(
      'GET',
      `/api/product-enquiries?limit=50&q=${encodeURIComponent(PHONE)}`,
      { token: raiserToken },
    );
    expect(asRaiser.body.data!.enquiries.some((e) => e.id === enquiryId)).toBe(true);
  });

  it('the customer directory is closed without Raiser access and open with it', async () => {
    // The obvious way round redaction: skip the enquiry and ask the customer
    // master directly, which returns every name, phone and email in full.
    expect((await api('GET', '/api/customers?limit=50', { token: answererToken })).status).toBe(
      403,
    );
    expect((await api('GET', '/api/customers?limit=50', { token: neitherToken })).status).toBe(403);

    expect((await api('GET', '/api/customers?limit=50', { token: raiserToken })).status).toBe(200);
    expect((await api('GET', '/api/customers?limit=50', { token: bothToken })).status).toBe(200);
  });
});
