/**
 * Create Lead / Deal — Phase 1.
 *
 * Two rules carry most of the weight here, and both are asserted from every
 * side because both are easy to get subtly wrong:
 *
 *   - **"Other" plus a written name is one answer.** Choosing OTHER without
 *     naming it is refused, and so is naming something while choosing a listed
 *     value. The shared schema states it, the table's CHECK constraints enforce
 *     it, and these tests prove the pair agree.
 *
 *   - **A lead never creates a duplicate customer.** Linking an existing one
 *     must add no Customer row at all, which is checked by counting before and
 *     after rather than by trusting the response.
 *
 * The phone lookup is tested against deliberately messy spellings of one
 * number, because that is the whole reason normalization exists — and against
 * two customers sharing a number, because the live data has exactly that and
 * the API must hand back both rather than silently pick one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  TEST_PREFIX,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let leadUser: TestUser;
let outsider: TestUser;
let adminToken: string;
let leadToken: string;
let outsiderToken: string;

/** A number written the awkward way, to prove the fold does its job. */
const PHONE_CANONICAL = '+919812345678';
const PHONE_SPACED = '+91 98123 45678';
const PHONE_HYPHENS = '+91-98123-45678';
const PHONE_PARENS = '(91) 98123.45678';

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  leadUser = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  leadToken = await mintToken(leadUser.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  // USER holds nothing on LEAD_DEAL by default, so the module tests grant it
  // explicitly — exercising the same override rows an administrator writes.
  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE'] as const).map((action) => ({
      userId: leadUser.id,
      module: 'LEAD_DEAL' as const,
      action,
      allowed: true,
    })),
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type LeadResponse = {
  id: string;
  leadSource: string;
  leadSourceOther: string | null;
  sourceDetails: string | null;
  sourceAt: string;
  requirementType: string;
  channel: string;
  channelOther: string | null;
  customer: { id: string; name: string; phone: string | null };
  createdBy: { id: string };
};

const leadPayload = (customerId: string, over: Record<string, unknown> = {}) => ({
  leadSource: 'CALL',
  sourceDetails: 'Rang about a bulk thali order',
  sourceAt: new Date().toISOString(),
  requirementType: 'RETAIL',
  customer: { customerId },
  channel: 'ROYALSTUFFS_COM',
  ...over,
});

const createLead = (token: string, body: Record<string, unknown>) =>
  api('POST', '/api/leads', { token, body });

const lookup = (token: string, phone: string) =>
  api('GET', `/api/leads/customer-lookup?phone=${encodeURIComponent(phone)}`, { token });

/** Tracked by the fixture through its customer, which cleanup removes. */
async function makeCustomerWithPhone(phone: string): Promise<{ id: string; name: string }> {
  return makeCustomer('RETAIL', { phone });
}

// ---------------------------------------------------------------------------
//  Creating a lead
// ---------------------------------------------------------------------------

describe('creating a lead against an existing customer', () => {
  it('records every field it was given', async () => {
    const customer = await makeCustomerWithPhone(PHONE_CANONICAL);
    const at = new Date('2026-09-30T09:15:00.000Z').toISOString();

    const res = await createLead(leadToken, leadPayload(customer.id, { sourceAt: at }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const lead = (res.body.data as { lead: LeadResponse }).lead;
    expect(lead.leadSource).toBe('CALL');
    expect(lead.sourceDetails).toBe('Rang about a bulk thali order');
    expect(lead.sourceAt).toBe(at);
    expect(lead.requirementType).toBe('RETAIL');
    expect(lead.channel).toBe('ROYALSTUFFS_COM');
    expect(lead.customer.id).toBe(customer.id);
    // Who entered it comes from the session, never from the body.
    expect(lead.createdBy.id).toBe(leadUser.id);
    // Nothing was invented for the fields that were not supplied.
    expect(lead.leadSourceOther).toBeNull();
    expect(lead.channelOther).toBeNull();
  });

  it('creates no second customer — the whole point of linking one', async () => {
    const customer = await makeCustomerWithPhone('+919800000001');

    const before = await prisma.customer.count();
    const res = await createLead(leadToken, leadPayload(customer.id));
    const after = await prisma.customer.count();

    expect(res.status).toBe(201);
    expect(after, 'linking an existing customer must add no Customer row').toBe(before);
  });

  it('accepts a lead with no source details — the field is optional', async () => {
    const customer = await makeCustomerWithPhone('+919800000002');
    const res = await createLead(leadToken, leadPayload(customer.id, { sourceDetails: undefined }));

    expect(res.status).toBe(201);
    expect((res.body.data as { lead: LeadResponse }).lead.sourceDetails).toBeNull();
  });

  it('refuses a customer that does not exist', async () => {
    const res = await createLead(leadToken, leadPayload('clx0000000000000000000000'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('creating a lead and the customer together', () => {
  it('creates exactly one customer and links it', async () => {
    const before = await prisma.customer.count();

    const res = await createLead(leadToken, {
      ...leadPayload('placeholder'),
      customer: {
        newCustomer: {
          name: `${TEST_PREFIX}-new-lead-customer`,
          type: 'RETAIL',
          phone: '+919700000001',
          // An Indian customer must name a State — the existing Customer rule,
          // reused here rather than restated, which is the point of pointing
          // `newCustomer` at createCustomerSchema.
          country: 'India',
          state: 'Uttar Pradesh',
        },
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await prisma.customer.count()).toBe(before + 1);

    const lead = (res.body.data as { lead: LeadResponse }).lead;
    expect(lead.customer.phone).toBe('+919700000001');
  });

  it('refuses both an id and a new customer at once', async () => {
    const customer = await makeCustomerWithPhone('+919800000003');
    const res = await createLead(leadToken, {
      ...leadPayload(customer.id),
      customer: {
        customerId: customer.id,
        newCustomer: { name: 'zz-test-both', type: 'RETAIL', phone: '+919700000002' },
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses neither', async () => {
    const customer = await makeCustomerWithPhone('+919800000004');
    const res = await createLead(leadToken, { ...leadPayload(customer.id), customer: {} });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  The vocabularies
// ---------------------------------------------------------------------------

describe('every lead source', () => {
  it('is accepted, and OTHER carries its written name', async () => {
    const customer = await makeCustomerWithPhone('+919600000001');

    for (const source of ['CALL', 'WHATSAPP', 'EMAIL', 'ABANDONED_CART', 'SOCIAL_MEDIA']) {
      const res = await createLead(leadToken, leadPayload(customer.id, { leadSource: source }));
      expect(res.status, `${source}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    const other = await createLead(
      leadToken,
      leadPayload(customer.id, { leadSource: 'OTHER', leadSourceOther: 'Trade fair' }),
    );
    expect(other.status).toBe(201);
    expect((other.body.data as { lead: LeadResponse }).lead.leadSourceOther).toBe('Trade fair');
  });

  it('refuses OTHER with no name, and a named listed source', async () => {
    const customer = await makeCustomerWithPhone('+919600000002');

    const unnamed = await createLead(leadToken, leadPayload(customer.id, { leadSource: 'OTHER' }));
    expect(unnamed.status).toBe(422);

    // The other direction: naming something while choosing a listed value is
    // two contradictory statements about where the lead came from.
    const overNamed = await createLead(
      leadToken,
      leadPayload(customer.id, { leadSource: 'CALL', leadSourceOther: 'Trade fair' }),
    );
    expect(overNamed.status).toBe(422);
  });

  it('refuses a source that is not in the vocabulary', async () => {
    const customer = await makeCustomerWithPhone('+919600000003');
    const res = await createLead(leadToken, leadPayload(customer.id, { leadSource: 'PIGEON' }));
    expect(res.status).toBe(422);
  });
});

describe('every requirement type', () => {
  it('is accepted', async () => {
    const customer = await makeCustomerWithPhone('+919500000001');

    for (const type of [
      'RETAIL',
      'WHOLESALE',
      'EXPORT_RETAIL',
      'EXPORT_WHOLESALE',
      'CORPORATE_GIFTING',
      'PERSONAL_GIFTING',
    ]) {
      const res = await createLead(leadToken, leadPayload(customer.id, { requirementType: type }));
      expect(res.status, `${type}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it('refuses one outside the list', async () => {
    const customer = await makeCustomerWithPhone('+919500000002');
    const res = await createLead(
      leadToken,
      leadPayload(customer.id, { requirementType: 'BARTER' }),
    );
    expect(res.status).toBe(422);
  });
});

describe('every channel', () => {
  it('is accepted, and OTHER carries its written name', async () => {
    const customer = await makeCustomerWithPhone('+919400000001');

    for (const channel of [
      'ROYALSTUFFS_COM',
      'ROYALSTUFFS_STORE',
      'INDIAMART',
      'AMAZON',
      'FLIPKART',
    ]) {
      const res = await createLead(leadToken, leadPayload(customer.id, { channel }));
      expect(res.status, `${channel}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    const other = await createLead(
      leadToken,
      leadPayload(customer.id, { channel: 'OTHER', channelOther: 'Walk-in' }),
    );
    expect(other.status).toBe(201);
    expect((other.body.data as { lead: LeadResponse }).lead.channelOther).toBe('Walk-in');
  });

  it('refuses OTHER with no name, and a named listed channel', async () => {
    const customer = await makeCustomerWithPhone('+919400000002');

    expect((await createLead(leadToken, leadPayload(customer.id, { channel: 'OTHER' }))).status).toBe(
      422,
    );
    expect(
      (
        await createLead(
          leadToken,
          leadPayload(customer.id, { channel: 'AMAZON', channelOther: 'Walk-in' }),
        )
      ).status,
    ).toBe(422);
  });
});

describe('the required fields', () => {
  it('refuse a lead with no source date and time', async () => {
    const customer = await makeCustomerWithPhone('+919300000001');
    const res = await createLead(leadToken, leadPayload(customer.id, { sourceAt: undefined }));
    expect(res.status).toBe(422);
  });

  it('refuse a source date and time that is not a real instant', async () => {
    const customer = await makeCustomerWithPhone('+919300000002');
    const res = await createLead(leadToken, leadPayload(customer.id, { sourceAt: 'last Tuesday' }));
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Finding the customer by phone
// ---------------------------------------------------------------------------

describe('the phone lookup', () => {
  it('finds one customer however the number is punctuated', async () => {
    const customer = await makeCustomerWithPhone(PHONE_CANONICAL);

    for (const spelling of [PHONE_CANONICAL, PHONE_SPACED, PHONE_HYPHENS, PHONE_PARENS]) {
      const res = await lookup(leadToken, spelling);
      expect(res.status, spelling).toBe(200);

      const body = res.body.data as { normalizedPhone: string; customers: { id: string }[] };
      expect(body.normalizedPhone, spelling).toBe('919812345678');
      expect(
        body.customers.some((c) => c.id === customer.id),
        `${spelling} should find the customer`,
      ).toBe(true);
    }
  });

  it('returns nothing for a number nobody has', async () => {
    const res = await lookup(leadToken, '+919000000999');
    expect(res.status).toBe(200);
    expect((res.body.data as { customers: unknown[] }).customers).toHaveLength(0);
  });

  it('returns EVERY customer sharing a number, never just one', async () => {
    /*
      The case the live data actually contains. Phone is meant to identify one
      customer, but duplicates exist from dummy and historical rows — so the
      API hands back all of them and somebody has to choose, rather than
      silently linking a lead to whichever row came first.
    */
    const shared = '+919212121212';
    const first = await makeCustomerWithPhone(shared);
    const second = await makeCustomerWithPhone(shared);

    const res = await lookup(leadToken, shared);
    expect(res.status).toBe(200);

    const ids = (res.body.data as { customers: { id: string }[] }).customers.map((c) => c.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('does not match a bare local number against one stored with a country code', async () => {
    // Phase 1 is digits-only and deliberately has no country intelligence.
    // Stated as a test so the limitation is visible rather than surprising.
    await makeCustomerWithPhone('+919112345678');

    const res = await lookup(leadToken, '9112345678');
    const ids = (res.body.data as { customers: { id: string }[] }).customers;
    expect(ids).toHaveLength(0);
  });

  it('refuses a phone that is not a plausible number', async () => {
    expect((await lookup(leadToken, 'abc')).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Who may do what
// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('refuses a user with no LEAD_DEAL access', async () => {
    const customer = await makeCustomerWithPhone('+919100000001');

    expect((await createLead(outsiderToken, leadPayload(customer.id))).status).toBe(403);
    expect((await lookup(outsiderToken, PHONE_CANONICAL)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await api('POST', '/api/leads', { body: leadPayload('x') });
    expect(res.status).toBe(401);
  });

  it('admits an administrator with no override rows', async () => {
    const customer = await makeCustomerWithPhone('+919100000002');
    const res = await createLead(adminToken, leadPayload(customer.id));
    expect(res.status).toBe(201);
  });
});

describe('reading one back', () => {
  it('returns the lead with its customer attached', async () => {
    const customer = await makeCustomerWithPhone('+919000000001');
    const created = await createLead(leadToken, leadPayload(customer.id));
    const id = (created.body.data as { lead: LeadResponse }).lead.id;

    const res = await api('GET', `/api/leads/${id}`, { token: leadToken });
    expect(res.status).toBe(200);
    expect((res.body.data as { lead: LeadResponse }).lead.customer.id).toBe(customer.id);
  });

  it('is not confused by the literal lookup path', async () => {
    // `/customer-lookup` is declared before `/:id`, so it is never read as one.
    const res = await lookup(leadToken, PHONE_CANONICAL);
    expect(res.status).toBe(200);
  });
});
