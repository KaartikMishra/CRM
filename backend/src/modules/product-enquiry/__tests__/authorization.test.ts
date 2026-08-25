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

/**
 * Four actors, chosen so every ownership rule in §23 has both a case that
 * should pass and a case that should fail:
 *
 *   creator  — created the enquiry, is not Towards
 *   towards  — holds the enquiry, did not create it
 *   stranger — an ordinary employee with no relationship to it
 *   admin    — bypasses ownership, per the approved permission model
 */
let admin: TestUser;
let creator: TestUser;
let towards: TestUser;
let stranger: TestUser;
let adminToken: string;
let creatorToken: string;
let towardsToken: string;
let strangerToken: string;
let customerId: string;
let vendor: { id: string };

beforeAll(async () => {
  await startTestServer();
  [admin, creator, towards, stranger] = await Promise.all([
    makeUser('ADMIN'),
    makeUser('USER'),
    makeUser('USER'),
    makeUser('USER'),
  ]);
  [adminToken, creatorToken, towardsToken, strangerToken] = await Promise.all([
    mintToken(admin.id, { role: 'ADMIN' }),
    mintToken(creator.id, { role: 'USER' }),
    mintToken(towards.id, { role: 'USER' }),
    mintToken(stranger.id, { role: 'USER' }),
  ]);
  customerId = (await makeCustomer()).id;
  vendor = await makeVendor();
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

/** Created by `creator`, assigned to `towards` — the interesting split. */
async function splitEnquiry(count = 1): Promise<EnquiryDetail> {
  const res = await api<Wrapped>('POST', '/api/product-enquiries', {
    token: creatorToken,
    body: enquiryPayload(customerId, towards.id, count),
  });
  const enquiry = res.body.data!.enquiry;
  trackEnquiry(enquiry.id);
  return enquiry;
}

describe('authentication', () => {
  it('refuses every enquiry route without a token', async () => {
    for (const [method, path] of [
      ['GET', '/api/product-enquiries'],
      ['POST', '/api/product-enquiries'],
      ['GET', '/api/product-enquiries/clzzzzzzzzzzzzzzzzzzzzzzz'],
      ['POST', '/api/product-enquiries/clzzzzzzzzzzzzzzzzzzzzzzz/full-submit'],
    ] as const) {
      const res = await api(method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = await mintToken(creator.id, { secret: 'x'.repeat(48) });
    const res = await api('GET', '/api/product-enquiries', { token: forged });
    expect(res.status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const expired = await mintToken(creator.id, {
      expiresIn: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await api('GET', '/api/product-enquiries', { token: expired });
    expect(res.status).toBe(401);
  });

  it('refuses a malformed enquiry id before touching the database', async () => {
    const res = await api('GET', '/api/product-enquiries/not-a-cuid', { token: creatorToken });
    expect(res.status).toBe(422);
  });
});

describe('ownership — §23', () => {
  it('lets every employee view any enquiry', async () => {
    const enquiry = await splitEnquiry();

    for (const token of [creatorToken, towardsToken, strangerToken, adminToken]) {
      const res = await api<Wrapped>('GET', `/api/product-enquiries/${enquiry.id}`, { token });
      expect(res.status).toBe(200);
    }
  });

  it('lets the creator add a product', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/products`, {
      token: creatorToken,
      body: { name: 'by creator', quantity: 1, similarOptionNeeded: false },
    });
    expect(res.status).toBe(201);
  });

  it('lets Towards add a product', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/products`, {
      token: towardsToken,
      body: { name: 'by towards', quantity: 1, similarOptionNeeded: false },
    });
    expect(res.status).toBe(201);
  });

  it('refuses an unrelated employee adding a product', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/products`, {
      token: strangerToken,
      body: { name: 'by stranger', quantity: 1, similarOptionNeeded: false },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ENQUIRY_ACCESS');
  });

  it('restricts vendor responses to Towards, not the creator', async () => {
    const enquiry = await splitEnquiry();
    const path = `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}/vendor-responses`;

    const byCreator = await api('POST', path, {
      token: creatorToken,
      body: vendorResponsePayload(vendor.id),
    });
    expect(byCreator.status).toBe(403);

    const byStranger = await api('POST', path, {
      token: strangerToken,
      body: vendorResponsePayload(vendor.id),
    });
    expect(byStranger.status).toBe(403);

    const byTowards = await api('POST', path, {
      token: towardsToken,
      body: vendorResponsePayload(vendor.id),
    });
    expect(byTowards.status).toBe(201);
  });

  it('restricts submitting to Towards', async () => {
    const enquiry = await splitEnquiry();
    await api(
      'POST',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}/vendor-responses`,
      { token: towardsToken, body: vendorResponsePayload(vendor.id) },
    );

    const byCreator = await api('POST', `/api/product-enquiries/${enquiry.id}/partial-submit`, {
      token: creatorToken,
    });
    expect(byCreator.status).toBe(403);

    const byTowards = await api('POST', `/api/product-enquiries/${enquiry.id}/partial-submit`, {
      token: towardsToken,
    });
    expect(byTowards.status).toBe(200);
  });

  it('lets an ADMIN act on an enquiry they have no relationship to', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/products`, {
      token: adminToken,
      body: { name: 'by admin', quantity: 1, similarOptionNeeded: false },
    });
    expect(res.status).toBe(201);
  });
});

describe('assignment — §22', () => {
  it('refuses reassignment by a USER, even the creator', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: creatorToken,
      body: { assignedToId: stranger.id },
    });
    expect(res.status).toBe(403);
  });

  it('lets an ADMIN reassign and records both sides on the timeline', async () => {
    const enquiry = await splitEnquiry();
    const res = await api<Wrapped>('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: adminToken,
      body: { assignedToId: stranger.id, note: 'Covering leave' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.enquiry.assignedTo.id).toBe(stranger.id);

    const event = res.body.data!.enquiry.events.find((e) => e.type === 'REASSIGNED');
    expect(event?.oldValue).toBe(towards.id);
    expect(event?.newValue).toBe(stranger.id);
    expect(event?.actor?.id).toBe(admin.id);
  });

  it('treats reassignment to the current holder as a no-op', async () => {
    const enquiry = await splitEnquiry();
    await api('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: adminToken,
      body: { assignedToId: towards.id },
    });

    const events = await prisma.enquiryEvent.count({
      where: { enquiryId: enquiry.id, type: 'REASSIGNED' },
    });
    expect(events).toBe(0);
  });

  it('refuses assigning to a deactivated employee', async () => {
    const enquiry = await splitEnquiry();
    const inactive = await makeUser('USER', false);

    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: adminToken,
      body: { assignedToId: inactive.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ASSIGNEE');
  });
});

describe('closed enquiries and reopen — §24', () => {
  async function closedEnquiry(): Promise<EnquiryDetail> {
    const enquiry = await splitEnquiry();
    await api(
      'POST',
      `/api/product-enquiries/${enquiry.id}/products/${enquiry.products[0]!.id}/vendor-responses`,
      { token: towardsToken, body: vendorResponsePayload(vendor.id) },
    );
    await api('POST', `/api/product-enquiries/${enquiry.id}/full-submit`, { token: towardsToken });
    return enquiry;
  }

  it('refuses edits to a closed enquiry for USER and ADMIN alike', async () => {
    const enquiry = await closedEnquiry();

    for (const token of [towardsToken, adminToken]) {
      const res = await api('POST', `/api/product-enquiries/${enquiry.id}/products`, {
        token,
        body: { name: 'after close', quantity: 1, similarOptionNeeded: false },
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ENQUIRY_CLOSED');
    }
  });

  it('refuses a reopen by a USER', async () => {
    const enquiry = await closedEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/reopen`, {
      token: towardsToken,
      body: { reason: 'Customer came back with changes' },
    });
    expect(res.status).toBe(403);
  });

  it('requires a reason even from an ADMIN', async () => {
    const enquiry = await closedEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/reopen`, {
      token: adminToken,
      body: {},
    });
    expect(res.status).toBe(422);
  });

  it('lets an ADMIN reopen, audits it, and leaves the frozen SLA untouched', async () => {
    const enquiry = await closedEnquiry();
    const before = await api<Wrapped>('GET', `/api/product-enquiries/${enquiry.id}`, {
      token: adminToken,
    });
    const frozen = before.body.data!.enquiry.sla;

    const res = await api<Wrapped>('POST', `/api/product-enquiries/${enquiry.id}/reopen`, {
      token: adminToken,
      body: { reason: 'Customer came back with changes' },
    });

    expect(res.status).toBe(200);
    const after = res.body.data!.enquiry;
    expect(after.status).toBe('OPEN');
    expect(after.closedAt).toBeNull();
    expect(after.closedBy).toBeNull();

    // §20 — reopening does not un-answer the enquiry.
    expect(after.sla.efficiency).toBe(frozen.efficiency);
    expect(after.sla.firstSubmitAt).toBe(frozen.firstSubmitAt);
    expect(after.sla.responseSeconds).toBe(frozen.responseSeconds);

    const event = after.events.find((e) => e.type === 'REOPENED');
    expect(event?.actor?.id).toBe(admin.id);
  });

  it('refuses reopening an enquiry that is not closed', async () => {
    const enquiry = await splitEnquiry();
    const res = await api('POST', `/api/product-enquiries/${enquiry.id}/reopen`, {
      token: adminToken,
      body: { reason: 'Nothing to reopen here' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('permission overrides — §20', () => {
  it('refuses creation when CREATE is revoked for one person', async () => {
    await prisma.userModulePermission.create({
      data: { userId: stranger.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: false },
    });

    const res = await api('POST', '/api/product-enquiries', {
      token: strangerToken,
      body: enquiryPayload(customerId, stranger.id, 1),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');

    await prisma.userModulePermission.deleteMany({ where: { userId: stranger.id } });
  });

  it('lets an override grant ASSIGN beyond the USER default', async () => {
    const enquiry = await splitEnquiry();

    const before = await api('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: creatorToken,
      body: { assignedToId: stranger.id },
    });
    expect(before.status).toBe(403);

    await prisma.userModulePermission.create({
      data: { userId: creator.id, module: 'PRODUCT_ENQUIRY', action: 'ASSIGN', allowed: true },
    });

    // The permission gate opens, but the ownership policy is a separate rule
    // and still reserves reassignment for ADMIN (§22).
    const after = await api('POST', `/api/product-enquiries/${enquiry.id}/assign`, {
      token: creatorToken,
      body: { assignedToId: stranger.id },
    });
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('FORBIDDEN_ENQUIRY_ACCESS');

    await prisma.userModulePermission.deleteMany({ where: { userId: creator.id } });
  });
});

describe('listing — §10', () => {
  it('filters by status, assignee and efficiency, and paginates', async () => {
    await splitEnquiry();
    await splitEnquiry();
    await splitEnquiry();

    const mine = await api<{ enquiries: unknown[] }>(
      'GET',
      `/api/product-enquiries?assignedToId=${towards.id}&status=OPEN&limit=2`,
      { token: creatorToken },
    );

    expect(mine.status).toBe(200);
    expect(mine.body.data!.enquiries.length).toBeLessThanOrEqual(2);
    expect(mine.body.meta?.serverTime).toBeTruthy();
    expect(mine.body.meta).toHaveProperty('nextCursor');
  });

  it('rejects a sort column that is not on the allowlist', async () => {
    const res = await api('GET', '/api/product-enquiries?sortBy=passwordHash', {
      token: creatorToken,
    });
    expect(res.status).toBe(422);
  });

  it('never returns a password hash', async () => {
    await splitEnquiry();
    const res = await api('GET', '/api/product-enquiries', { token: creatorToken });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });
});
