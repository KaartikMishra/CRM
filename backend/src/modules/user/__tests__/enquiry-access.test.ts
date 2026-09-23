/**
 * Setting somebody's Product Enquiry capabilities from the Edit User screen,
 * and the behaviour that follows from it.
 *
 * The point of this suite is that the admin checkboxes and the customer
 * redaction are the SAME fact, not two settings kept in step by hand. Each
 * checkbox writes one permission row —
 *
 *   Raiser    →  PRODUCT_ENQUIRY CREATE
 *   Answerer  →  PRODUCT_ENQUIRY EDIT
 *
 * — and everything downstream reads those rows: whether a create is refused,
 * whether a vendor response is refused, and whether the customer's identity
 * reaches the payload.
 *
 * They are two independent booleans, not a choice between two jobs, so all four
 * combinations are set and read back here. Asserting the stored row alone would
 * prove only that a checkbox was saved, so every test drives the real admin
 * endpoint and then checks the real enquiry API as that person.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EnquiryAccess, EnquiryDetail, EnquirySummary, ManagedUser } from '@rs/shared';
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
  TEST_PREFIX,
  trackEnquiry,
  vendorResponsePayload,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

type UserBody = { user: ManagedUser };
type DetailBody = { enquiry: EnquiryDetail };
type ListBody = { enquiries: EnquirySummary[] };

let admin: TestUser;
let adminToken: string;

/** The person the administrator moves through the four combinations. */
let subjectId: string;
let subjectToken: string;

const PASSWORD = `Str0ng-${randomUUID().slice(0, 12)}`;
const PHONE = '9876500042';
const EMAIL = 'zz-test-access@test.invalid';
const STATE = 'Karnataka';
const GSTIN = '29ZZTEST0042Z5';

let customerId: string;
let customerName: string;
let vendorId: string;
let enquiryId: string;
let productId: string;

const createdIds: string[] = [];

const RAISER_ONLY: EnquiryAccess = { raiser: true, answerer: false };
const ANSWERER_ONLY: EnquiryAccess = { raiser: false, answerer: true };
const BOTH: EnquiryAccess = { raiser: true, answerer: true };
const NEITHER: EnquiryAccess = { raiser: false, answerer: false };

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const created = await api<UserBody>('POST', '/api/users', {
    token: adminToken,
    body: {
      name: `${TEST_PREFIX}-subject`,
      email: `${TEST_PREFIX}-${suffix}@test.invalid`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      modules: ['PRODUCT_ENQUIRY'],
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  subjectId = created.body.data!.user.id;
  createdIds.push(subjectId);
  subjectToken = await mintToken(subjectId, { role: 'USER' });

  const customer = await makeCustomer('RETAIL', {
    phone: PHONE,
    email: EMAIL,
    state: STATE,
    gstNumber: GSTIN,
  });
  customerId = customer.id;
  customerName = customer.name;
  vendorId = (await makeVendor()).id;

  // Raised by the administrator and Towards the subject, so the subject's own
  // rights never affect whether the enquiry exists or whether they are the
  // person expected to answer it — only what they are shown and allowed to do.
  const enquiry = await api<DetailBody>('POST', '/api/product-enquiries', {
    token: adminToken,
    body: enquiryPayload(customerId, subjectId),
  });
  expect(enquiry.status, JSON.stringify(enquiry.body)).toBe(201);
  enquiryId = enquiry.body.data!.enquiry.id;
  productId = enquiry.body.data!.enquiry.products[0]!.id;
  trackEnquiry(enquiryId);
});

afterAll(async () => {
  /*
    cleanup() first, and the order is load-bearing: ProductEnquiry.createdById
    is RESTRICT, so the accounts this suite created cannot go until the
    enquiries they raised have. Deleting the user first fails the whole
    teardown on a foreign key.
  */
  await cleanup();

  if (createdIds.length) {
    await prisma.userModulePermission.deleteMany({ where: { userId: { in: createdIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  }

  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/** Flips the subject through the admin endpoint, as the Edit User screen does. */
const setAccess = (enquiryAccess: EnquiryAccess) =>
  api<UserBody>('PATCH', `/api/users/${subjectId}`, {
    token: adminToken,
    body: { enquiryAccess },
  });

/** What the two capability rows actually resolve to for the subject. */
async function storedRows(): Promise<{ create: boolean | null; edit: boolean | null }> {
  const rows = await prisma.userModulePermission.findMany({
    where: { userId: subjectId, module: 'PRODUCT_ENQUIRY' },
    select: { action: true, allowed: true },
  });
  const find = (action: string) => rows.find((r) => r.action === action)?.allowed ?? null;
  return { create: find('CREATE'), edit: find('EDIT') };
}

const tryCreate = () =>
  api('POST', '/api/product-enquiries', {
    token: subjectToken,
    body: enquiryPayload(customerId, subjectId),
  });

const tryVendorResponse = () =>
  api('POST', `/api/product-enquiries/${enquiryId}/products/${productId}/vendor-responses`, {
    token: subjectToken,
    body: vendorResponsePayload(vendorId),
  });

const readDetail = () =>
  api<DetailBody>('GET', `/api/product-enquiries/${enquiryId}`, { token: subjectToken });

// ===========================================================================
//  The administrator's side
// ===========================================================================

describe('an administrator sets the capabilities from the Edit User screen', () => {
  it('a newly created user holds both', async () => {
    // Nobody's access narrows because this field arrived: granting the module
    // has always meant CREATE and EDIT, and it still does unless asked
    // otherwise.
    const res = await api<UserBody>('GET', `/api/users/${subjectId}`, { token: adminToken });

    expect(res.body.data!.user.enquiryAccess).toEqual(BOTH);
    expect(await storedRows()).toEqual({ create: true, edit: true });
  });

  it('stores each of the four combinations, and reads it back', async () => {
    for (const access of [RAISER_ONLY, ANSWERER_ONLY, NEITHER, BOTH]) {
      const res = await setAccess(access);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data!.user.enquiryAccess).toEqual(access);
      // Stored in the existing permission table — no new column, no new table.
      expect(await storedRows()).toEqual({ create: access.raiser, edit: access.answerer });

      // Read back on a fresh request, not just echoed from the write.
      const reread = await api<UserBody>('GET', `/api/users/${subjectId}`, { token: adminToken });
      expect(reread.body.data!.user.enquiryAccess).toEqual(access);
    }
  });

  it('holds the two independently — one does not move the other', async () => {
    await setAccess(BOTH);
    await setAccess({ raiser: false, answerer: true });
    expect(await storedRows()).toEqual({ create: false, edit: true });

    await setAccess({ raiser: true, answerer: true });
    expect(await storedRows()).toEqual({ create: true, edit: true });

    await setAccess({ raiser: true, answerer: false });
    expect(await storedRows()).toEqual({ create: true, edit: false });
  });

  it('leaves VIEW alone whatever the capabilities are', async () => {
    // Reading is not one of the two capabilities: everybody granted the module
    // may read every enquiry.
    await setAccess(NEITHER);
    const view = await prisma.userModulePermission.findFirst({
      where: { userId: subjectId, module: 'PRODUCT_ENQUIRY', action: 'VIEW' },
      select: { allowed: true },
    });

    expect(view?.allowed).toBe(true);
    expect((await readDetail()).status).toBe(200);
  });

  it('leaves the module grant alone when only the capabilities change', async () => {
    // The rows are written all-or-nothing, so changing a capability without
    // resending `modules` must not quietly revoke the module.
    await setAccess(ANSWERER_ONLY);
    const res = await api<UserBody>('GET', `/api/users/${subjectId}`, { token: adminToken });

    expect(res.body.data!.user.modules).toContain('PRODUCT_ENQUIRY');
  });

  it('refuses to touch an administrator', async () => {
    // An override row on an ADMIN reads as a restriction, so their access is
    // set by role alone — the existing guard, unchanged.
    const res = await api('PATCH', `/api/users/${admin.id}`, {
      token: adminToken,
      body: { enquiryAccess: ANSWERER_ONLY },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ADMIN_MODULES_IMMUTABLE');
  });

  it('reports an administrator as holding both, from the role defaults', async () => {
    const res = await api<UserBody>('GET', `/api/users/${admin.id}`, { token: adminToken });
    expect(res.body.data!.user.enquiryAccess).toEqual(BOTH);
  });

  it('is administrator-only', async () => {
    const res = await api('PATCH', `/api/users/${subjectId}`, {
      token: subjectToken,
      body: { enquiryAccess: BOTH },
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
//  What each capability actually does
// ===========================================================================

describe('as a Raiser only', () => {
  beforeAll(async () => {
    expect((await setAccess(RAISER_ONLY)).status).toBe(200);
  });

  it('may create an enquiry', async () => {
    const res = await tryCreate();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    trackEnquiry((res.body.data as { enquiry: { id: string } }).enquiry.id);
  });

  it('sees the customer name, phone and email', async () => {
    const customer = (await readDetail()).body.data!.enquiry.customer;

    expect(customer.name).toBe(customerName);
    expect(customer.phone).toBe(PHONE);
    expect(customer.email).toBe(EMAIL);
  });

  it('may not record a vendor response, though they are Towards on it', async () => {
    // Answering is the other capability. Being the person the enquiry sits with
    // does not supply it.
    expect((await tryVendorResponse()).status).toBe(403);
  });
});

describe('as an Answerer only', () => {
  beforeAll(async () => {
    expect((await setAccess(ANSWERER_ONLY)).status).toBe(200);
  });

  it('may not create an enquiry', async () => {
    expect((await tryCreate()).status).toBe(403);
  });

  it('may still view it', async () => {
    expect((await readDetail()).status).toBe(200);
  });

  it('sees no customer name, phone or email', async () => {
    const customer = (await readDetail()).body.data!.enquiry.customer;

    expect(customer.name).toBeNull();
    expect(customer.phone).toBeNull();
    expect(customer.email).toBeNull();
  });

  it('DOES see the state, GST number and customer type', async () => {
    // Exactly three fields are withheld. Taking the rest away would remove what
    // the answering job itself needs.
    const customer = (await readDetail()).body.data!.enquiry.customer;

    expect(customer.state).toBe(STATE);
    expect(customer.gstNumber).toBe(GSTIN);
    expect(customer.type).toBe('RETAIL');
  });

  it('carries none of the three anywhere in the raw payload', async () => {
    const raw = JSON.stringify((await readDetail()).body);

    expect(raw).not.toContain(customerName);
    expect(raw).not.toContain(PHONE);
    expect(raw).not.toContain(EMAIL);
  });

  it('may record a vendor response — the work the capability is for', async () => {
    const res = await tryVendorResponse();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('keeps the edit rights answering needs', async () => {
    const res = await api('PATCH', `/api/product-enquiries/${enquiryId}`, {
      token: subjectToken,
      body: { sourceDetail: `${TEST_PREFIX} answered` },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // ...and the write's own response is redacted too.
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });

  it('cannot reach the customer through search or the directory', async () => {
    const search = await api<ListBody>(
      'GET',
      `/api/product-enquiries?limit=50&q=${encodeURIComponent(PHONE)}`,
      { token: subjectToken },
    );
    expect(search.body.data!.enquiries).toHaveLength(0);

    expect((await api('GET', '/api/customers?limit=5', { token: subjectToken })).status).toBe(403);
  });
});

describe('holding both is a union, never a subtraction', () => {
  beforeAll(async () => {
    expect((await setAccess(BOTH)).status).toBe(200);
  });

  it('sees the customer and may create', async () => {
    expect((await readDetail()).body.data!.enquiry.customer.name).toBe(customerName);

    const created = await tryCreate();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    trackEnquiry((created.body.data as { enquiry: { id: string } }).enquiry.id);
  });

  it('may record a vendor response as well', async () => {
    expect((await tryVendorResponse()).status).toBe(201);
  });
});

describe('holding neither leaves reading, and nothing else', () => {
  beforeAll(async () => {
    expect((await setAccess(NEITHER)).status).toBe(200);
  });

  it('may read the enquiry', async () => {
    expect((await readDetail()).status).toBe(200);
  });

  it('sees no customer identity, but still sees the state', async () => {
    const customer = (await readDetail()).body.data!.enquiry.customer;

    expect(customer.name).toBeNull();
    expect(customer.state).toBe(STATE);
  });

  it('may neither create nor answer', async () => {
    expect((await tryCreate()).status).toBe(403);
    expect((await tryVendorResponse()).status).toBe(403);
  });
});

// ===========================================================================
//  Switching, both ways
// ===========================================================================

describe('switching the capabilities changes the behaviour', () => {
  it('Raiser → Answerer takes the customer away and refuses creates', async () => {
    await setAccess(RAISER_ONLY);
    expect((await readDetail()).body.data!.enquiry.customer.name).toBe(customerName);

    await setAccess(ANSWERER_ONLY);
    expect((await readDetail()).body.data!.enquiry.customer.name).toBeNull();
    expect((await tryCreate()).status).toBe(403);
  });

  it('Answerer → Raiser gives it back and allows creates', async () => {
    await setAccess(ANSWERER_ONLY);
    expect((await readDetail()).body.data!.enquiry.customer.name).toBeNull();

    await setAccess(RAISER_ONLY);
    const customer = (await readDetail()).body.data!.enquiry.customer;
    expect(customer.name).toBe(customerName);
    expect(customer.phone).toBe(PHONE);

    const created = await tryCreate();
    expect(created.status).toBe(201);
    trackEnquiry((created.body.data as { enquiry: { id: string } }).enquiry.id);
  });
});
