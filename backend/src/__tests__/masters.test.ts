/**
 * The Customer and Vendor master endpoints.
 *
 * These exist only to make Product Enquiry usable from a UI: look one up, or
 * add one. The tests hold them to that scope — read and create, guarded by the
 * same permission architecture as everything else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerView, VendorView } from '@rs/shared';
import { api, mintToken, startTestServer, stopTestServer } from './helpers/test-server.js';
import {
  TEST_PREFIX,
  cleanup,
  makeCustomer,
  makeUser,
  makeVendor,
  residualTestRows,
  type TestUser,
} from './helpers/fixtures.js';

let user: TestUser;
let token: string;
const created: { customers: string[]; vendors: string[] } = { customers: [], vendors: [] };

beforeAll(async () => {
  await startTestServer();
  user = await makeUser('USER');
  token = await mintToken(user.id, { role: 'USER' });
  await makeCustomer('CORPORATE_GIFTING');
  await makeVendor();
});

afterAll(async () => {
  // Records created through the API are not tracked by the fixture helper.
  const { prisma } = await import('../config/database.js');
  if (created.customers.length) {
    await prisma.customer.deleteMany({ where: { id: { in: created.customers } } });
  }
  if (created.vendors.length) {
    await prisma.vendor.deleteMany({ where: { id: { in: created.vendors } } });
  }
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

describe('customers', () => {
  it('requires authentication', async () => {
    expect((await api('GET', '/api/customers')).status).toBe(401);
    expect((await api('POST', '/api/customers')).status).toBe(401);
  });

  it('searches by name', async () => {
    const res = await api<{ customers: CustomerView[] }>(
      'GET',
      `/api/customers?q=${TEST_PREFIX}-customer`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.customers.length).toBeGreaterThan(0);
    expect(res.body.data!.customers[0]!.name).toContain(TEST_PREFIX);
    expect(res.body.data!.customers[0]!.type).toBeTruthy();
  });

  it('filters by customer type', async () => {
    const res = await api<{ customers: CustomerView[] }>(
      'GET',
      `/api/customers?q=${TEST_PREFIX}&type=CORPORATE_GIFTING`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.customers.every((c) => c.type === 'CORPORATE_GIFTING')).toBe(true);
  });

  it('honours the result limit', async () => {
    const res = await api<{ customers: CustomerView[] }>('GET', '/api/customers?limit=1', {
      token,
    });
    expect(res.body.data!.customers).toHaveLength(1);
  });

  it('rejects a limit outside the allowed range', async () => {
    expect((await api('GET', '/api/customers?limit=500', { token })).status).toBe(422);
  });

  it('creates a customer', async () => {
    const res = await api<{ customer: CustomerView }>('POST', '/api/customers', {
      token,
      body: {
        name: `${TEST_PREFIX}-new-customer`,
        type: 'WEDDING_GIFTING',
        phone: '+91 98765 43210',
      },
    });

    expect(res.status).toBe(201);
    created.customers.push(res.body.data!.customer.id);
    expect(res.body.data!.customer.type).toBe('WEDDING_GIFTING');
    expect(res.body.data!.customer.phone).toBe('+91 98765 43210');
  });

  it('validates the create payload', async () => {
    const noType = await api('POST', '/api/customers', {
      token,
      body: { name: `${TEST_PREFIX}-invalid` },
    });
    expect(noType.status).toBe(422);

    const badEmail = await api('POST', '/api/customers', {
      token,
      body: { name: `${TEST_PREFIX}-invalid`, type: 'RETAIL', email: 'not-an-email' },
    });
    expect(badEmail.status).toBe(422);
  });

  /**
   * State and GST number arrived after customers already existed, so every
   * case below is really about one guarantee: both fields are optional, and
   * their absence has to stay as valid as their presence.
   */
  describe('state and GST number', () => {
    const create = (body: Record<string, unknown>) =>
      api<{ customer: CustomerView }>('POST', '/api/customers', { token, body });

    const base = { type: 'RETAIL' as const, phone: '+91 98765 43210' };

    it('persists and returns both', async () => {
      const res = await create({
        ...base,
        name: `${TEST_PREFIX}-state-gst`,
        state: 'Maharashtra',
        gstNumber: '27AAPFU0939F1ZV',
      });

      expect(res.status).toBe(201);
      const customer = res.body.data!.customer;
      created.customers.push(customer.id);
      expect(customer.state).toBe('Maharashtra');
      expect(customer.gstNumber).toBe('27AAPFU0939F1ZV');

      // Read back through the search endpoint: what was stored, not what was echoed.
      const found = await api<{ customers: CustomerView[] }>(
        'GET',
        `/api/customers?q=${TEST_PREFIX}-state-gst`,
        { token },
      );
      const row = found.body.data!.customers.find((c) => c.id === customer.id);
      expect(row?.state).toBe('Maharashtra');
      expect(row?.gstNumber).toBe('27AAPFU0939F1ZV');
    });

    it('accepts a state with no GST number', async () => {
      const res = await create({
        ...base,
        name: `${TEST_PREFIX}-state-only`,
        state: 'Maharashtra',
      });

      expect(res.status).toBe(201);
      created.customers.push(res.body.data!.customer.id);
      expect(res.body.data!.customer.state).toBe('Maharashtra');
      // Omitted means NULL, exactly as it already does for phone, email and address.
      expect(res.body.data!.customer.gstNumber).toBeNull();
    });

    it('accepts neither', async () => {
      const res = await create({ ...base, name: `${TEST_PREFIX}-no-state-gst` });

      expect(res.status).toBe(201);
      created.customers.push(res.body.data!.customer.id);
      expect(res.body.data!.customer.state).toBeNull();
      expect(res.body.data!.customer.gstNumber).toBeNull();
    });

    it('stores a GST number typed in lower case in upper case', async () => {
      const res = await create({
        ...base,
        name: `${TEST_PREFIX}-gst-lower`,
        gstNumber: '27aapfu0939f1zv',
      });

      expect(res.status).toBe(201);
      created.customers.push(res.body.data!.customer.id);
      expect(res.body.data!.customer.gstNumber).toBe('27AAPFU0939F1ZV');
    });

    it('accepts a Union Territory, which is a GST jurisdiction like any State', async () => {
      // Delhi used to be this suite's example of a real place deliberately off
      // the list. It is on it now: a GSTIN is issued against a Union Territory
      // exactly as against a State, so a customer there has to be recordable.
      const ut = await create({ ...base, name: `${TEST_PREFIX}-ut`, state: 'Delhi' });
      expect(ut.status).toBe(201);
      created.customers.push(ut.body.data!.customer.id);
      expect(ut.body.data!.customer.state).toBe('Delhi');
    });

    it('rejects a state outside the States and Union Territories of India', async () => {
      /*
        Pondicherry is the honest case now: a real place, and deliberately not
        the name on the list — the official one is Puducherry. It proves the
        list is closed to near-misses rather than merely typo-proof, which is
        the property Delhi used to demonstrate.
      */
      const old = await create({
        ...base,
        name: `${TEST_PREFIX}-bad-state`,
        state: 'Pondicherry',
      });
      expect(old.status).toBe(422);

      const casing = await create({
        ...base,
        name: `${TEST_PREFIX}-bad-state`,
        state: 'maharashtra',
      });
      expect(casing.status).toBe(422);

      // And the plainly invented case, so the rule is pinned at both ends:
      // a near-miss and a name that was never a place at all.
      const invented = await create({
        ...base,
        name: `${TEST_PREFIX}-bad-state`,
        state: 'NotARealState',
      });
      expect(invented.status).toBe(422);
    });

    it('rejects a malformed GST number', async () => {
      const short = await create({
        ...base,
        name: `${TEST_PREFIX}-bad-gst`,
        gstNumber: 'ABC123',
      });
      expect(short.status).toBe(422);

      // Structurally wrong in one character: the fixed 'Z' is missing.
      const wrongShape = await create({
        ...base,
        name: `${TEST_PREFIX}-bad-gst`,
        gstNumber: '27AAPFU0939F1XV',
      });
      expect(wrongShape.status).toBe(422);
    });

    it('reads back a customer created before the fields existed', async () => {
      // The fixture writes a row the way every pre-migration row looks: no
      // state, no GST number, both columns NULL.
      const legacy = await makeCustomer();

      const res = await api<{ customers: CustomerView[] }>(
        'GET',
        `/api/customers?q=${legacy.name}`,
        { token },
      );

      expect(res.status).toBe(200);
      const row = res.body.data!.customers.find((c) => c.id === legacy.id);
      expect(row).toBeDefined();
      expect(row!.state).toBeNull();
      expect(row!.gstNumber).toBeNull();
      // The rest of the record is untouched by the new columns.
      expect(row!.name).toBe(legacy.name);
      expect(row!.type).toBe('RETAIL');
    });
  });
});

describe('vendors', () => {
  it('requires authentication', async () => {
    expect((await api('GET', '/api/vendors')).status).toBe(401);
    expect((await api('POST', '/api/vendors')).status).toBe(401);
  });

  it('searches by name and returns only active vendors by default', async () => {
    await makeVendor(false);

    const res = await api<{ vendors: VendorView[] }>(
      'GET',
      `/api/vendors?q=${TEST_PREFIX}-vendor`,
      { token },
    );

    expect(res.status).toBe(200);
    expect(res.body.data!.vendors.length).toBeGreaterThan(0);
    expect(res.body.data!.vendors.every((v) => v.isActive)).toBe(true);
  });

  it('creates a vendor', async () => {
    const res = await api<{ vendor: VendorView }>('POST', '/api/vendors', {
      token,
      body: {
        name: `${TEST_PREFIX}-new-vendor-${Date.now()}`,
        contactPerson: 'Rakesh Sharma',
        city: 'Moradabad',
      },
    });

    expect(res.status).toBe(201);
    created.vendors.push(res.body.data!.vendor.id);
    expect(res.body.data!.vendor.contactPerson).toBe('Rakesh Sharma');
    expect(res.body.data!.vendor.isActive).toBe(true);
  });

  it('refuses a duplicate vendor name through the standard envelope', async () => {
    const name = `${TEST_PREFIX}-dup-vendor-${Date.now()}`;

    const first = await api<{ vendor: VendorView }>('POST', '/api/vendors', {
      token,
      body: { name },
    });
    expect(first.status).toBe(201);
    created.vendors.push(first.body.data!.vendor.id);

    const second = await api('POST', '/api/vendors', { token, body: { name } });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE_RECORD');
  });

  it('exposes no fields beyond the picker contract', async () => {
    const res = await api<{ vendors: VendorView[] }>('GET', '/api/vendors?limit=1', { token });
    const vendor = res.body.data!.vendors[0];

    if (vendor) {
      expect(Object.keys(vendor).sort()).toEqual(
        ['city', 'contactPerson', 'email', 'id', 'isActive', 'name', 'phone'].sort(),
      );
    }
  });
});
