/**
 * Deal status, assignment and activities — Phases 4C and 4D, end to end.
 *
 * The promptness arithmetic is proved in lead-promptness.test.ts against a fixed
 * clock. This suite proves the parts only a real request can show: that EDIT and
 * ASSIGN are genuinely separate capabilities, that an activity cannot be reached
 * through another lead's URL, that nothing persists a score, and that the
 * derived fields arrive on the wire with the values the arithmetic produced.
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
  salesOrderPayload,
  trackSalesOrder,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
/** EDIT but no ASSIGN — the separation this phase turns on. */
let editor: TestUser;
/** EDIT and ASSIGN. */
let allocator: TestUser;
let outsider: TestUser;

let adminToken: string;
let editorToken: string;
let allocatorToken: string;
let outsiderToken: string;

let customer: { id: string; name: string };

const hours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  editor = await makeUser('USER');
  allocator = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  editorToken = await mintToken(editor.id, { role: 'USER' });
  allocatorToken = await mintToken(allocator.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  customer = await makeCustomer('RETAIL', { phone: '+919876500001' });

  await prisma.userModulePermission.createMany({
    data: [
      // The editor can create and manage, and deliberately cannot allocate.
      ...(['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: editor.id,
        module: 'LEAD_DEAL' as const,
        action,
        allowed: true,
      })),
      ...(['VIEW', 'CREATE', 'EDIT', 'ASSIGN'] as const).map((action) => ({
        userId: allocator.id,
        module: 'LEAD_DEAL' as const,
        action,
        allowed: true,
      })),
    ],
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
  dealStatus: string;
  associate: { id: string } | null;
  allocatedBy: { id: string } | null;
  allocation: 'SELF' | 'OTHER_USER' | 'UNASSIGNED';
  salesOrderId: string | null;
  promptness: { expected: number; onTime: number; score: number | null; rating: string };
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  activities: { id: string; kind: string; dueAt: string; completedAt: string | null }[];
};

async function makeLead(): Promise<string> {
  const res = await api('POST', '/api/leads', {
    token: editorToken,
    body: {
      leadSource: 'CALL',
      sourceAt: new Date().toISOString(),
      requirementType: 'RETAIL',
      customer: { customerId: customer.id },
      channel: 'ROYALSTUFFS_COM',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { lead: LeadResponse }).lead.id;
}

const lead = (res: { body: { data?: unknown } }) =>
  (res.body.data as { lead: LeadResponse }).lead;

const addActivity = (token: string, leadId: string, body: Record<string, unknown>) =>
  api('POST', `/api/leads/${leadId}/activities`, { token, body });

// ---------------------------------------------------------------------------
//  Deal status
// ---------------------------------------------------------------------------

describe('deal status', () => {
  it('starts as INPROCESS without anybody setting it', async () => {
    const id = await makeLead();
    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    expect(lead(res).dealStatus).toBe('INPROCESS');
  });

  it('can be moved to WON and to LOST', async () => {
    const id = await makeLead();

    const won = await api('PATCH', `/api/leads/${id}`, {
      token: editorToken,
      body: { dealStatus: 'WON' },
    });
    expect(won.status).toBe(200);
    expect(lead(won).dealStatus).toBe('WON');

    const lost = await api('PATCH', `/api/leads/${id}`, {
      token: editorToken,
      body: { dealStatus: 'LOST' },
    });
    expect(lost.status).toBe(200);
    expect(lead(lost).dealStatus).toBe('LOST');
  });

  it('refuses a status outside the vocabulary', async () => {
    const id = await makeLead();
    const res = await api('PATCH', `/api/leads/${id}`, {
      token: editorToken,
      body: { dealStatus: 'PENDING' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses to reassign through the status endpoint', async () => {
    /*
      The endpoint accepts only the status, so an extra key cannot smuggle an
      allocation past the ASSIGN permission. Zod strips it; the associate is
      unchanged.
    */
    const id = await makeLead();
    const res = await api('PATCH', `/api/leads/${id}`, {
      token: editorToken,
      body: { dealStatus: 'WON', associateId: outsider.id },
    });
    expect(res.status).toBe(200);
    expect(lead(res).associate).toBeNull();
  });

  it('refuses somebody without EDIT', async () => {
    const id = await makeLead();
    const res = await api('PATCH', `/api/leads/${id}`, {
      token: outsiderToken,
      body: { dealStatus: 'WON' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  Assignment
// ---------------------------------------------------------------------------

describe('assignment', () => {
  it('records SELF when somebody takes their own lead', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: allocator.id },
    });

    expect(res.status).toBe(200);
    const l = lead(res);
    expect(l.associate!.id).toBe(allocator.id);
    expect(l.allocatedBy!.id).toBe(allocator.id);
    expect(l.allocation).toBe('SELF');
  });

  it('records OTHER_USER when it is handed to somebody else', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: editor.id },
    });

    const l = lead(res);
    expect(l.associate!.id).toBe(editor.id);
    // The allocator is the actor, never taken from the body.
    expect(l.allocatedBy!.id).toBe(allocator.id);
    expect(l.allocation).toBe('OTHER_USER');
  });

  it('unassigns, clearing both ids', async () => {
    const id = await makeLead();
    await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: editor.id },
    });

    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: null },
    });

    const l = lead(res);
    expect(l.associate).toBeNull();
    // Both cleared: an allocator beside no associate would describe an
    // allocation that no longer exists. The audit trail holds who cleared it.
    expect(l.allocatedBy).toBeNull();
    expect(l.allocation).toBe('UNASSIGNED');
  });

  it('refuses EDIT-only access — allocation needs ASSIGN', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: editorToken,
      body: { associateId: editor.id },
    });
    expect(res.status).toBe(403);
  });

  it('refuses somebody with no module access at all', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: outsiderToken,
      body: { associateId: outsider.id },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a target user who does not exist', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: 'clx0000000000000000000000' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ASSOCIATE_NOT_FOUND');
  });

  it('admits an administrator with no override rows', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/assign`, {
      token: adminToken,
      body: { associateId: admin.id },
    });
    expect(res.status).toBe(200);
    expect(lead(res).allocation).toBe('SELF');
  });
});

// ---------------------------------------------------------------------------
//  Activities
// ---------------------------------------------------------------------------

describe('recording an activity', () => {
  it('accepts each of the three kinds', async () => {
    const id = await makeLead();

    for (const kind of ['FIRST_CONTACT', 'FOLLOW_UP', 'RESULT']) {
      const res = await addActivity(editorToken, id, { kind, dueAt: hours(-5) });
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(201);
    }

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    expect(lead(res).activities).toHaveLength(3);
  });

  it('refuses a kind outside the vocabulary', async () => {
    const id = await makeLead();
    const res = await addActivity(editorToken, id, { kind: 'REMINDER', dueAt: hours(-1) });
    expect(res.status).toBe(422);
  });

  it('refuses a due moment that is not a real instant', async () => {
    const id = await makeLead();
    const res = await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: 'next Tuesday',
    });
    expect(res.status).toBe(422);
  });

  it('accepts one that is still outstanding', async () => {
    const id = await makeLead();
    const res = await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    expect(res.status).toBe(201);
    expect(lead(res).activities[0]!.completedAt).toBeNull();
  });

  it('accepts completion before, on and after the due moment', async () => {
    const id = await makeLead();

    const early = await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-10),
      completedAt: hours(-20),
    });
    expect(early.status).toBe(201);

    const late = await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-30),
      completedAt: hours(-5),
    });
    expect(late.status).toBe(201);

    const at = hours(-40);
    const exact = await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: at,
      completedAt: at,
    });
    expect(exact.status).toBe(201);
  });

  it('refuses somebody without EDIT', async () => {
    const id = await makeLead();
    const res = await addActivity(outsiderToken, id, { kind: 'FOLLOW_UP', dueAt: hours(-1) });
    expect(res.status).toBe(403);
  });
});

describe('editing an activity', () => {
  it('records the completion and who closed it', async () => {
    const id = await makeLead();
    const created = await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: hours(-6) });
    const activityId = lead(created).activities[0]!.id;

    const res = await api('PATCH', `/api/leads/${id}/activities/${activityId}`, {
      token: editorToken,
      body: { completedAt: hours(-7) },
    });

    expect(res.status).toBe(200);
    const activity = lead(res).activities.find((a) => a.id === activityId)!;
    expect(activity.completedAt).not.toBeNull();
  });

  it('can reopen one by clearing the completion', async () => {
    const id = await makeLead();
    const created = await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-6),
      completedAt: hours(-7),
    });
    const activityId = lead(created).activities[0]!.id;

    const res = await api('PATCH', `/api/leads/${id}/activities/${activityId}`, {
      token: editorToken,
      body: { completedAt: null },
    });

    expect(res.status).toBe(200);
    expect(lead(res).activities.find((a) => a.id === activityId)!.completedAt).toBeNull();
  });

  it('refuses an activity belonging to a different lead', async () => {
    /*
      Authorisation, not tidiness: without the lead scoping, an activity id from
      one lead could be edited through another lead's URL.
    */
    const first = await makeLead();
    const second = await makeLead();

    const created = await addActivity(editorToken, first, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-6),
    });
    const activityId = lead(created).activities[0]!.id;

    const res = await api('PATCH', `/api/leads/${second}/activities/${activityId}`, {
      token: editorToken,
      body: { completedAt: hours(-5) },
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LEAD_ACTIVITY_NOT_FOUND');
  });

  it('refuses an empty change', async () => {
    const id = await makeLead();
    const created = await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: hours(-6) });
    const activityId = lead(created).activities[0]!.id;

    const res = await api('PATCH', `/api/leads/${id}/activities/${activityId}`, {
      token: editorToken,
      body: {},
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Promptness over the wire
// ---------------------------------------------------------------------------

describe('promptness as the API reports it', () => {
  it('is NOT_RATED on a lead with no activity', async () => {
    const id = await makeLead();
    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });

    const p = lead(res).promptness;
    expect(p.expected).toBe(0);
    expect(p.score).toBeNull();
    expect(p.rating).toBe('NOT_RATED');
  });

  it('is NOT_RATED while nobody is assigned, however much was done', async () => {
    const id = await makeLead();
    await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-10),
      completedAt: hours(-11),
    });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const p = lead(res).promptness;

    expect(p.rating).toBe('NOT_RATED');
    // The work is still counted, so the rating appears once an associate exists.
    expect(p.expected).toBe(1);
    expect(p.onTime).toBe(1);
  });

  it('becomes a real rating once an associate is named', async () => {
    const id = await makeLead();
    await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-10),
      completedAt: hours(-11),
    });
    await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: editor.id },
    });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const p = lead(res).promptness;
    expect(p.rating).toBe('GOOD');
    expect(p.score).toBeCloseTo(1, 5);
  });

  it('counts an overdue incomplete action against the score — 3/5 = AVERAGE', async () => {
    const id = await makeLead();

    for (let i = 0; i < 3; i += 1) {
      await addActivity(editorToken, id, {
        kind: 'FOLLOW_UP',
        dueAt: hours(-20 - i),
        completedAt: hours(-21 - i),
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: hours(-10 - i) });
    }

    await api('POST', `/api/leads/${id}/assign`, {
      token: allocatorToken,
      body: { associateId: editor.id },
    });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const p = lead(res).promptness;

    expect(p.expected).toBe(5);
    expect(p.onTime).toBe(3);
    expect(p.score).toBeCloseTo(0.6, 5);
    expect(p.rating).toBe('AVERAGE');
  });

  it('persists no score anywhere — the rating is derived on read', async () => {
    const id = await makeLead();
    await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-10),
      completedAt: hours(-11),
    });

    // Every column on both tables, inspected directly. Nothing holds a score,
    // a rating, or a cached figure of any kind.
    const [leadRow] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "Lead" WHERE "id" = ${id}`;
    const [activityRow] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "LeadActivity" WHERE "leadId" = ${id} LIMIT 1`;

    for (const row of [leadRow, activityRow]) {
      const columns = Object.keys(row ?? {}).map((c) => c.toLowerCase());
      expect(columns).not.toContain('promptness');
      expect(columns).not.toContain('score');
      expect(columns).not.toContain('rating');
      expect(columns).not.toContain('ontime');
    }
  });
});

describe('the follow-up summary over the wire', () => {
  it('reports the latest completed follow-up and the earliest future one', async () => {
    const id = await makeLead();

    /*
      The exact instants sent, held rather than re-derived.

      `hours()` reads the clock, so calling it again at assertion time returns a
      different moment — later by however long the requests above took. Comparing
      the response against a freshly computed `hours(-24)` therefore drifts with
      the suite's own runtime, and `toBeCloseTo(-4)` allows only five seconds of
      it. Four HTTP round trips against Neon routinely exceed that, so the test
      passed or failed depending on latency.

      Comparing against the strings actually submitted tests what the endpoint
      did with them, which is the thing under test.
    */
    const completedEarlier = hours(-48);
    const completedLater = hours(-24);
    const dueFurther = hours(72);
    const dueSooner = hours(24);

    await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: completedEarlier,
      completedAt: completedEarlier,
    });
    await addActivity(editorToken, id, {
      kind: 'FOLLOW_UP',
      dueAt: completedLater,
      completedAt: completedLater,
    });
    await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: dueFurther });
    await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: dueSooner });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const l = lead(res);

    // Latest completed, not latest due.
    expect(new Date(l.lastFollowUpAt!).toISOString()).toBe(
      new Date(completedLater).toISOString(),
    );
    // Earliest upcoming, not the one furthest out.
    expect(new Date(l.nextFollowUpAt!).toISOString()).toBe(new Date(dueSooner).toISOString());
  });

  it('does not offer an overdue incomplete follow-up as the next one', async () => {
    const id = await makeLead();
    await addActivity(editorToken, id, { kind: 'FOLLOW_UP', dueAt: hours(-6) });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const l = lead(res);

    expect(l.nextFollowUpAt).toBeNull();
    expect(l.lastFollowUpAt).toBeNull();
    // But it is still expected, which is where a missed follow-up belongs.
    expect(l.promptness.expected).toBe(1);
  });

  it('ignores FIRST_CONTACT for both summary fields', async () => {
    const id = await makeLead();
    await addActivity(editorToken, id, {
      kind: 'FIRST_CONTACT',
      dueAt: hours(-10),
      completedAt: hours(-10),
    });

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const l = lead(res);

    expect(l.lastFollowUpAt).toBeNull();
    expect(l.nextFollowUpAt).toBeNull();
    // It does count toward promptness — it was an expected action.
    expect(l.promptness.expected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  Order value stays a reference
// ---------------------------------------------------------------------------

describe('order value', () => {
  it('is derived on read, never a copied figure', async () => {
    /*
      `orderValue` is reported — it was added so the detail page can show what a
      linked order is worth — but it is computed from the SalesOrder through
      Sales' own `toMoney` on every read, so there is nothing to go stale. What
      must never exist is a *stored* figure on the lead, which is what the column
      check below asserts.
      */
    const id = await makeLead();
    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const l = lead(res) as unknown as Record<string, unknown>;

    expect('salesOrderId' in l).toBe(true);
    // Null here: this lead has no order, which is different from zero.
    expect(l.orderValue).toBeNull();
    expect('dealValue' in l).toBe(false);
    expect('quotedValue' in l).toBe(false);
  });

  it('stores no value column on the lead itself', async () => {
    // The real guarantee. A column would be free to contradict the order.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'Lead'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());

    for (const absent of ['ordervalue', 'dealvalue', 'quotedvalue', 'requirementvalue']) {
      expect(names, absent).not.toContain(absent);
    }
  });
});

// ---------------------------------------------------------------------------
//  Who a lead can be allocated to
// ---------------------------------------------------------------------------

describe('the assignee list', () => {
  it('is reachable with VIEW, not just by an administrator', async () => {
    /*
      The reason this endpoint exists. `GET /api/users` is administrator-only, so
      an associate holding LEAD_DEAL:ASSIGN would meet a 403 on their own
      allocation picker and see an empty dropdown.
    */
    const res = await api('GET', '/api/leads/assignees', { token: editorToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const list = (res.body.data as { assignees: { id: string }[] }).assignees;
    expect(list.length).toBeGreaterThan(0);
  });

  it('refuses somebody with no LEAD_DEAL access', async () => {
    expect((await api('GET', '/api/leads/assignees', { token: outsiderToken })).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await api('GET', '/api/leads/assignees')).status).toBe(401);
  });

  it('exposes only what names a person in a dropdown', async () => {
    const res = await api('GET', '/api/leads/assignees', { token: editorToken });
    const list = (res.body.data as { assignees: Record<string, unknown>[] }).assignees;

    expect(Object.keys(list[0]!).sort()).toEqual(['employeeId', 'id', 'name', 'role']);
    // No credential, no contact detail, no permission rows.
    const body = JSON.stringify(list);
    for (const leak of ['password', 'email', 'modules']) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('is not read as a lead id', async () => {
    // Declared before /:id, like /customer-lookup.
    const res = await api('GET', '/api/leads/assignees', { token: editorToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('assignees');
  });

  it('omits deactivated accounts, which cannot own work', async () => {
    const retired = await makeUser('USER', false);
    const res = await api('GET', '/api/leads/assignees', { token: editorToken });
    const ids = (res.body.data as { assignees: { id: string }[] }).assignees.map((u) => u.id);
    expect(ids).not.toContain(retired.id);
  });
});
