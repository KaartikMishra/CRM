/**
 * Order Value versus Requirement Value, and the follow-up workflow end to end.
 *
 * Written after browser testing raised two questions: why a lead carrying a
 * ₹20,000 requirement reported no Order Value, and why Last and Next Follow-up
 * stayed empty. The first turned out to be correct semantics with a labelling
 * gap; the second was a missing UI over a working API.
 *
 * These tests pin the distinction so it cannot be "fixed" later by making a
 * requirement estimate masquerade as a sale, and they walk the follow-up
 * lifecycle the way an associate actually does.
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
let editor: TestUser;
let adminToken: string;
let editorToken: string;
let customer: { id: string; name: string };

const hours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  editor = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  editorToken = await mintToken(editor.id, { role: 'USER' });

  customer = await makeCustomer('RETAIL', { phone: '+919876700001' });

  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT', 'ASSIGN'] as const).map((action) => ({
      userId: editor.id,
      module: 'LEAD_DEAL' as const,
      action,
      allowed: true,
    })),
  });
});

afterAll(async () => {
  await prisma.leadProductRequirement.updateMany({
    // See lead-requirements.test.ts: SET NULL on the product collides with the
    // match-kind CHECK, so matched rows are unmatched before teardown.
    where: { rsProductId: { not: null }, lead: { createdById: { in: [admin.id, editor.id] } } },
    data: { rsProductId: null, matchKind: null },
  });

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type ActivityResponse = {
  id: string;
  kind: string;
  dueAt: string;
  completedAt: string | null;
  performedBy: { id: string; name: string } | null;
  note: string | null;
};

type LeadResponse = {
  id: string;
  salesOrderId: string | null;
  orderValue: string | null;
  requirementValue: string | null;
  firstContactAt: string | null;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  promptness: {
    expected: number;
    onTime: number;
    overdue: number;
    score: number | null;
    rating: string;
  };
  activities: ActivityResponse[];
  requirements: { id: string; productValue: string | null }[];
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

const get = async (id: string): Promise<LeadResponse> => {
  const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return lead(res);
};

const addRequirement = (leadId: string, body: Record<string, unknown>) =>
  api('POST', `/api/leads/${leadId}/requirements`, { token: editorToken, body });

const addActivity = (leadId: string, body: Record<string, unknown>) =>
  api('POST', `/api/leads/${leadId}/activities`, { token: editorToken, body });

const patchActivity = (leadId: string, activityId: string, body: Record<string, unknown>) =>
  api('PATCH', `/api/leads/${leadId}/activities/${activityId}`, { token: editorToken, body });

/** Assigns an associate, so promptness has somebody to attribute a score to. */
const assign = (leadId: string) =>
  api('POST', `/api/leads/${leadId}/assign`, {
    token: editorToken,
    body: { associateId: editor.id },
  });

const requirement = (over: Record<string, unknown> = {}) => ({
  productName: 'Pure kansa dinner set - 5 pieces',
  quantity: 3,
  ...over,
});

// ===========================================================================
//  Order Value versus Requirement Value
// ===========================================================================

describe('a lead with no sales order', () => {
  it('reports orderValue null, not zero', async () => {
    /*
      The question the browser testing raised. Null is the honest answer: this
      lead has not become an order, which is different from an order totalling
      nothing. A UI that printed ₹0.00 here would be claiming a sale.
    */
    const id = await makeLead();
    const l = await get(id);

    expect(l.salesOrderId).toBeNull();
    expect(l.orderValue).toBeNull();
    expect(l.orderValue).not.toBe('0.00');
  });

  it('still reports the requirement value beside it', async () => {
    const id = await makeLead();
    await addRequirement(id, requirement({ productValue: 20000 }));

    const l = await get(id);
    expect(l.orderValue).toBeNull();
    expect(Number(l.requirementValue)).toBe(20000);
  });

  it('does not let the requirement value become the order value', async () => {
    // The architectural line this suite exists to hold.
    const id = await makeLead();
    await addRequirement(id, requirement({ productValue: 20000 }));

    const l = await get(id);
    expect(l.orderValue).toBeNull();
    expect(l.requirementValue).not.toBeNull();
    expect(l.orderValue).not.toBe(l.requirementValue);
  });

  it('reports requirementValue null when nothing has been priced', async () => {
    // Unpriced is not zero either.
    const id = await makeLead();
    await addRequirement(id, requirement());

    const l = await get(id);
    expect(l.requirementValue).toBeNull();
  });

  it('distinguishes unpriced from priced at zero', async () => {
    const unpriced = await makeLead();
    await addRequirement(unpriced, requirement());

    const free = await makeLead();
    await addRequirement(free, requirement({ productValue: 0 }));

    expect((await get(unpriced)).requirementValue).toBeNull();
    expect(Number((await get(free)).requirementValue)).toBe(0);
  });
});

describe('the derived requirement total', () => {
  it('sums several requirements', async () => {
    // The brief's own example: 20,000 + 8,000 + 12,500 = 40,500.
    const id = await makeLead();
    await addRequirement(id, requirement({ productName: 'One', productValue: 20000 }));
    await addRequirement(id, requirement({ productName: 'Two', productValue: 8000 }));
    await addRequirement(id, requirement({ productName: 'Three', productValue: 12500 }));

    expect(Number((await get(id)).requirementValue)).toBe(40500);
  });

  it('skips unpriced lines rather than counting them as zero', async () => {
    const id = await makeLead();
    await addRequirement(id, requirement({ productName: 'Priced', productValue: 15000 }));
    await addRequirement(id, requirement({ productName: 'Unpriced' }));

    expect(Number((await get(id)).requirementValue)).toBe(15000);
  });

  it('adds decimal paise exactly, without floating-point drift', async () => {
    const id = await makeLead();
    await addRequirement(id, requirement({ productName: 'A', productValue: 20000.1 }));
    await addRequirement(id, requirement({ productName: 'B', productValue: 8000.2 }));

    // 0.1 + 0.2 is the classic float trap; string decimal arithmetic avoids it.
    expect((await get(id)).requirementValue).toBe('28000.30');
  });

  it('follows the requirements as they change', async () => {
    const id = await makeLead();
    const first = await addRequirement(id, requirement({ productValue: 20000 }));
    const reqId = (first.body.data as { requirement: { id: string } }).requirement.id;

    expect(Number((await get(id)).requirementValue)).toBe(20000);

    await api('PATCH', `/api/leads/${id}/requirements/${reqId}`, {
      token: editorToken,
      body: { productValue: 25000 },
    });
    expect(Number((await get(id)).requirementValue)).toBe(25000);

    await api('DELETE', `/api/leads/${id}/requirements/${reqId}`, { token: editorToken });
    expect((await get(id)).requirementValue).toBeNull();
  });

  it('stores no total column — it is summed on read', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'Lead'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());

    for (const absent of ['ordervalue', 'dealvalue', 'requirementvalue', 'quotedvalue', 'total']) {
      expect(names, absent).not.toContain(absent);
    }
  });

  it('appears on the analytics board too', async () => {
    const id = await makeLead();
    await addRequirement(id, requirement({ productValue: 20000 }));

    const res = await api('GET', '/api/leads?limit=100', { token: editorToken });
    const rows = (
      res.body.data as { leads: { id: string; orderValue: string | null; requirementValue: string | null }[] }
    ).leads;
    const row = rows.find((r) => r.id === id);

    expect(row).toBeDefined();
    expect(row!.orderValue).toBeNull();
    expect(Number(row!.requirementValue)).toBe(20000);
  });
});

describe('a lead linked to a sales order', () => {
  it('takes orderValue from the order, not from the requirements', async () => {
    const id = await makeLead();
    await addRequirement(id, requirement({ productValue: 50000 }));

    // A real order, through Sales' own endpoint so its total is canonical.
    const created = await api('POST', '/api/sales', {
      token: adminToken,
      body: salesOrderPayload(customer.id, {
        items: [{ productName: 'zz-test-followup-line', quantity: 2, price: '1000.00' }],
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = (created.body.data as { order: { id: string } }).order.id;
    trackSalesOrder(orderId);

    // No API links a lead to an order yet, so the FK is set directly — which is
    // exactly what a future conversion flow will do.
    await prisma.lead.update({ where: { id }, data: { salesOrderId: orderId } });

    const l = await get(id);
    expect(l.salesOrderId).toBe(orderId);
    expect(l.orderValue).not.toBeNull();
    // Both present, independently, and free to differ.
    expect(Number(l.requirementValue)).toBe(50000);
    expect(l.orderValue).not.toBe(l.requirementValue);
  });

  it('leaves the order untouched by the requirement', async () => {
    const id = await makeLead();

    const created = await api('POST', '/api/sales', {
      token: adminToken,
      body: salesOrderPayload(customer.id, {
        items: [{ productName: 'zz-test-followup-line2', quantity: 1, price: '500.00' }],
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = (created.body.data as { order: { id: string } }).order.id;
    trackSalesOrder(orderId);
    await prisma.lead.update({ where: { id }, data: { salesOrderId: orderId } });

    const before = await get(id);
    await addRequirement(id, requirement({ productValue: 99999 }));
    const after = await get(id);

    // The requirement moved the estimate and nothing else.
    expect(after.orderValue).toBe(before.orderValue);
    expect(Number(after.requirementValue)).toBe(99999);
  });
});

// ===========================================================================
//  The follow-up workflow
// ===========================================================================

describe('creating activities', () => {
  it('records a first contact', async () => {
    const id = await makeLead();
    const res = await addActivity(id, {
      kind: 'FIRST_CONTACT',
      dueAt: hours(-1),
      note: 'Called customer.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const a = lead(res).activities[0]!;
    expect(a.kind).toBe('FIRST_CONTACT');
    expect(a.note).toBe('Called customer.');
    expect(a.completedAt).toBeNull();
  });

  it('records a follow-up and does not complete it automatically', async () => {
    /*
      The rule that makes the whole measurement work: scheduling an action is not
      performing it, so a new activity is outstanding until somebody says
      otherwise.
    */
    const id = await makeLead();
    const due = hours(24);
    const res = await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: due,
      note: 'Call customer and confirm dinner set quantity.',
    });

    const a = lead(res).activities[0]!;
    expect(a.kind).toBe('FOLLOW_UP');
    expect(a.completedAt).toBeNull();
    expect(a.performedBy).toBeNull();
    expect(new Date(a.dueAt).toISOString()).toBe(new Date(due).toISOString());
  });

  it('records a result', async () => {
    const id = await makeLead();
    const res = await addActivity(id, { kind: 'RESULT', dueAt: hours(-2), note: 'Won.' });
    expect(res.status).toBe(201);
    expect(lead(res).activities[0]!.kind).toBe('RESULT');
  });

  it('saves a completion when the work already happened', async () => {
    const id = await makeLead();
    const at = hours(-1);
    const res = await addActivity(id, {
      kind: 'FIRST_CONTACT',
      dueAt: at,
      completedAt: at,
    });

    const a = lead(res).activities[0]!;
    expect(a.completedAt).not.toBeNull();
    // The actor is stamped from the token, never taken from the body.
    expect(a.performedBy?.id).toBe(editor.id);
  });

  it('takes the performer from the session, not the payload', async () => {
    const id = await makeLead();
    const at = hours(-1);
    const res = await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: at,
      completedAt: at,
      performedById: admin.id,
    });

    expect(lead(res).activities[0]!.performedBy?.id).toBe(editor.id);
  });

  it('refuses an activity with no due moment', async () => {
    const id = await makeLead();
    expect((await addActivity(id, { kind: 'FOLLOW_UP' })).status).toBe(422);
  });

  it('refuses an invented kind', async () => {
    const id = await makeLead();
    expect((await addActivity(id, { kind: 'REMINDER', dueAt: hours(1) })).status).toBe(422);
  });

  it('refuses a lead that does not exist', async () => {
    const res = await addActivity('cuikzzzzzzzzzzzzzzzzzzzzz', {
      kind: 'FOLLOW_UP',
      dueAt: hours(1),
    });
    expect([404, 422]).toContain(res.status);
  });

  it('keeps activities scoped to their own lead', async () => {
    const a = await makeLead();
    const b = await makeLead();
    await addActivity(a, { kind: 'FOLLOW_UP', dueAt: hours(1), note: 'A only' });

    expect((await get(a)).activities).toHaveLength(1);
    expect((await get(b)).activities).toHaveLength(0);
  });
});

describe('next follow-up', () => {
  it('becomes the scheduled follow-up once one exists', async () => {
    const id = await makeLead();
    expect((await get(id)).nextFollowUpAt).toBeNull();

    const due = hours(24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: due });

    const l = await get(id);
    expect(new Date(l.nextFollowUpAt!).toISOString()).toBe(new Date(due).toISOString());
  });

  it('picks the earliest of several future follow-ups', async () => {
    const id = await makeLead();
    const soon = hours(24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(72) });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: soon });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(48) });

    expect(new Date((await get(id)).nextFollowUpAt!).toISOString()).toBe(
      new Date(soon).toISOString(),
    );
  });

  it('never offers an overdue follow-up as the next one', async () => {
    /*
      The distinction the UI now surfaces: something already missed is
      outstanding, not planned. Reporting it as "next" would make a neglected
      lead look managed.
    */
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-24) });

    const l = await get(id);
    expect(l.nextFollowUpAt).toBeNull();
    // And it is still counted as owed.
    expect(l.promptness.overdue).toBe(1);
  });

  it('prefers tomorrow over yesterday when both are incomplete', async () => {
    const id = await makeLead();
    const tomorrow = hours(24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-24) });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: tomorrow });

    const l = await get(id);
    expect(new Date(l.nextFollowUpAt!).toISOString()).toBe(new Date(tomorrow).toISOString());
    expect(l.promptness.overdue).toBe(1);
  });

  it('ignores FIRST_CONTACT and RESULT', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(24) });
    await addActivity(id, { kind: 'RESULT', dueAt: hours(48) });

    expect((await get(id)).nextFollowUpAt).toBeNull();
  });
});

describe('marking a follow-up completed', () => {
  it('stamps the completion and the performer', async () => {
    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    const at = new Date().toISOString();
    const res = await patchActivity(id, activityId, { completedAt: at });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const a = lead(res).activities[0]!;
    expect(a.completedAt).not.toBeNull();
    expect(a.performedBy?.id).toBe(editor.id);
  });

  it('moves it out of next and into last', async () => {
    // The lifecycle the board reflects.
    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    expect((await get(id)).nextFollowUpAt).not.toBeNull();
    expect((await get(id)).lastFollowUpAt).toBeNull();

    await patchActivity(id, activityId, { completedAt: new Date().toISOString() });

    const after = await get(id);
    expect(after.nextFollowUpAt).toBeNull();
    expect(after.lastFollowUpAt).not.toBeNull();
  });

  it('promotes the next future follow-up when the current one is done', async () => {
    const id = await makeLead();
    const firstDue = hours(24);
    const secondDue = hours(48);

    const a = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: firstDue });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: secondDue });

    const firstId = lead(a).activities.find((x) => x.dueAt.startsWith(firstDue.slice(0, 13)))!.id;

    expect(new Date((await get(id)).nextFollowUpAt!).toISOString()).toBe(
      new Date(firstDue).toISOString(),
    );

    await patchActivity(id, firstId, { completedAt: new Date().toISOString() });

    expect(new Date((await get(id)).nextFollowUpAt!).toISOString()).toBe(
      new Date(secondDue).toISOString(),
    );
  });

  it('can be reopened, which clears the performer too', async () => {
    const id = await makeLead();
    const created = await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(24),
      completedAt: hours(24),
    });
    const activityId = lead(created).activities[0]!.id;

    const res = await patchActivity(id, activityId, { completedAt: null });
    expect(res.status).toBe(200);

    const a = lead(res).activities[0]!;
    expect(a.completedAt).toBeNull();
    // An action that did not happen was performed by nobody.
    expect(a.performedBy).toBeNull();
  });
});

describe('last follow-up', () => {
  it('is the latest by completion, not by due date', async () => {
    /*
      The brief's example: A due 1 Oct done 1 Oct, B due 3 Oct done 3 Oct — last
      is B's completion. Ordering by dueAt would be the same here, so the test
      below inverts them to prove which field is read.
    */
    const id = await makeLead();
    const earlierDue = hours(-72);
    const laterDue = hours(-48);
    const laterCompletion = hours(-1);

    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: laterDue,
      completedAt: hours(-47),
    });
    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: earlierDue,
      completedAt: laterCompletion,
    });

    // The one due earliest was completed most recently, so it is "last".
    expect(new Date((await get(id)).lastFollowUpAt!).toISOString()).toBe(
      new Date(laterCompletion).toISOString(),
    );
  });

  it('ignores an incomplete follow-up however overdue', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-48) });
    expect((await get(id)).lastFollowUpAt).toBeNull();
  });

  it('is not set by a first contact', async () => {
    // FIRST_CONTACT counts toward promptness but is not a follow-up.
    const id = await makeLead();
    const at = hours(-2);
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: at, completedAt: at });

    const l = await get(id);
    expect(l.lastFollowUpAt).toBeNull();
    expect(l.firstContactAt).not.toBeNull();
  });

  it('is not set by a result', async () => {
    const id = await makeLead();
    const at = hours(-2);
    await addActivity(id, { kind: 'RESULT', dueAt: at, completedAt: at });
    expect((await get(id)).lastFollowUpAt).toBeNull();
  });
});

describe('first contact', () => {
  it('reports when the customer was actually reached', async () => {
    const id = await makeLead();
    const at = hours(-3);
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: at, completedAt: at });

    expect(new Date((await get(id)).firstContactAt!).toISOString()).toBe(
      new Date(at).toISOString(),
    );
  });

  it('stays null while the contact is still outstanding', async () => {
    // Scheduled is not made.
    const id = await makeLead();
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(-3) });
    expect((await get(id)).firstContactAt).toBeNull();
  });

  it('counts toward promptness', async () => {
    const id = await makeLead();
    await assign(id);
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(-24) });

    const l = await get(id);
    expect(l.promptness.expected).toBe(1);
    expect(l.promptness.overdue).toBe(1);
  });
});

describe('promptness is unchanged by this work', () => {
  it('counts an overdue incomplete action in the denominator', async () => {
    const id = await makeLead();
    await assign(id);

    const at = hours(-24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: at, completedAt: at });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-12) });

    const p = (await get(id)).promptness;
    expect(p.expected).toBe(2);
    expect(p.onTime).toBe(1);
    expect(p.overdue).toBe(1);
    expect(p.score).toBeCloseTo(0.5, 5);
    expect(p.rating).toBe('AVERAGE');
  });

  it('excludes a future action from the denominator', async () => {
    const id = await makeLead();
    await assign(id);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(48) });

    const p = (await get(id)).promptness;
    expect(p.expected).toBe(0);
    expect(p.rating).toBe('NOT_RATED');
    expect(p.score).toBeNull();
  });

  it('treats early completion as on time', async () => {
    const id = await makeLead();
    await assign(id);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-24), completedAt: hours(-30) });

    const p = (await get(id)).promptness;
    expect(p.onTime).toBe(1);
    expect(p.rating).toBe('GOOD');
  });

  it('does not treat late completion as on time', async () => {
    const id = await makeLead();
    await assign(id);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-24), completedAt: hours(-2) });

    const p = (await get(id)).promptness;
    expect(p.expected).toBe(1);
    expect(p.onTime).toBe(0);
    // Done, so not outstanding — which is why overdue is not expected - onTime.
    expect(p.overdue).toBe(0);
    expect(p.rating).toBe('POOR');
  });

  it('stays NOT_RATED with no associate, however much happened', async () => {
    const id = await makeLead();
    const at = hours(-24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: at, completedAt: at });

    const p = (await get(id)).promptness;
    expect(p.rating).toBe('NOT_RATED');
    expect(p.score).toBeNull();
    // The counts are still reported, so the UI can explain why.
    expect(p.expected).toBe(1);
  });

  it('persists no score anywhere', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'Lead'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());
    for (const absent of ['promptness', 'promptnessscore', 'rating', 'score']) {
      expect(names, absent).not.toContain(absent);
    }
  });
});

describe('editing an activity', () => {
  it('reschedules the due moment', async () => {
    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    const moved = hours(72);
    const res = await patchActivity(id, activityId, { dueAt: moved });
    expect(res.status).toBe(200);

    expect(new Date(lead(res).nextFollowUpAt!).toISOString()).toBe(new Date(moved).toISOString());
  });

  it('edits the note, and clears it with null', async () => {
    const id = await makeLead();
    const created = await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(24),
      note: 'Original',
    });
    const activityId = lead(created).activities[0]!.id;

    const edited = await patchActivity(id, activityId, { note: 'Corrected' });
    expect(lead(edited).activities[0]!.note).toBe('Corrected');

    const cleared = await patchActivity(id, activityId, { note: null });
    expect(lead(cleared).activities[0]!.note).toBeNull();
  });

  it('cannot change the kind — the contract has no such field', async () => {
    /*
      Immutable by design: turning a FIRST_CONTACT into a RESULT rewrites history
      rather than correcting it. An extra key is ignored rather than honoured.
    */
    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    const res = await patchActivity(id, activityId, { kind: 'RESULT', note: 'try it' });

    if (res.status === 200) {
      expect(lead(res).activities[0]!.kind).toBe('FIRST_CONTACT');
    } else {
      expect(res.status).toBe(422);
    }

    const after = await get(id);
    expect(after.activities[0]!.kind).toBe('FIRST_CONTACT');
  });

  it('cannot be moved to another lead', async () => {
    const a = await makeLead();
    const b = await makeLead();
    const created = await addActivity(a, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    // Through B's URL: refused.
    expect((await patchActivity(b, activityId, { note: 'hijack' })).status).toBe(404);
    // And a leadId in the body changes nothing.
    await patchActivity(a, activityId, { leadId: b, note: 'still A' });

    expect((await get(a)).activities).toHaveLength(1);
    expect((await get(b)).activities).toHaveLength(0);
  });

  it('refuses an empty patch', async () => {
    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    expect((await patchActivity(id, activityId, {})).status).toBe(422);
  });

  it('requires EDIT', async () => {
    const viewer = await makeUser('USER');
    const viewerToken = await mintToken(viewer.id, { role: 'USER' });
    await prisma.userModulePermission.create({
      data: { userId: viewer.id, module: 'LEAD_DEAL', action: 'VIEW', allowed: true },
    });

    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    const activityId = lead(created).activities[0]!.id;

    const read = await api('GET', `/api/leads/${id}`, { token: viewerToken });
    expect(read.status).toBe(200);

    const write = await api('PATCH', `/api/leads/${id}/activities/${activityId}`, {
      token: viewerToken,
      body: { note: 'nope' },
    });
    expect(write.status).toBe(403);
  });
});

// ===========================================================================
//  The whole workflow, as an associate walks it
// ===========================================================================

describe('the intended workflow end to end', () => {
  it('walks from empty, through a follow-up, to the next one', async () => {
    const id = await makeLead();
    await assign(id);

    // 1. Nothing recorded: both figures empty.
    let l = await get(id);
    expect(l.lastFollowUpAt).toBeNull();
    expect(l.nextFollowUpAt).toBeNull();

    // 2. Schedule one: it becomes next, and is not yet measurable.
    const firstDue = hours(24);
    const created = await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: firstDue,
      note: 'Call customer and confirm dinner set quantity.',
    });
    const firstId = lead(created).activities[0]!.id;

    l = await get(id);
    expect(new Date(l.nextFollowUpAt!).toISOString()).toBe(new Date(firstDue).toISOString());
    expect(l.lastFollowUpAt).toBeNull();
    expect(l.promptness.rating).toBe('NOT_RATED');

    // 3. Complete it: next empties, last fills.
    await patchActivity(id, firstId, { completedAt: new Date().toISOString() });

    l = await get(id);
    expect(l.lastFollowUpAt).not.toBeNull();
    expect(l.nextFollowUpAt).toBeNull();

    // 4. Schedule the next: both populated, which is the steady state.
    const secondDue = hours(72);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: secondDue });

    l = await get(id);
    expect(l.lastFollowUpAt).not.toBeNull();
    expect(new Date(l.nextFollowUpAt!).toISOString()).toBe(new Date(secondDue).toISOString());
  });

  it('reaches the analytics board with the same figures', async () => {
    const id = await makeLead();
    const due = hours(24);
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: due });

    const detail = await get(id);
    const res = await api('GET', '/api/leads?limit=100', { token: editorToken });
    const row = (
      res.body.data as { leads: { id: string; nextFollowUpAt: string | null }[] }
    ).leads.find((r) => r.id === id)!;

    // One derivation, two surfaces — the board cannot disagree with the detail.
    expect(row.nextFollowUpAt).toBe(detail.nextFollowUpAt);
  });

  it('needs one request for the whole detail page', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(-1), completedAt: hours(-1) });
    await addRequirement(id, requirement({ productValue: 20000 }));

    const l = await get(id);

    // Activities, requirements and both values all on one response.
    expect(l.activities).toHaveLength(2);
    expect(l.requirements).toHaveLength(1);
    expect(l.requirementValue).not.toBeNull();
    expect(l.promptness).toBeDefined();
  });

  it('changes no order and no stock', async () => {
    const orders = await prisma.salesOrder.count();
    const items = await prisma.salesOrderItem.count();
    const stock = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });

    const id = await makeLead();
    const created = await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(24) });
    await patchActivity(id, lead(created).activities[0]!.id, {
      completedAt: new Date().toISOString(),
    });
    await addRequirement(id, requirement({ productValue: 20000 }));

    expect(await prisma.salesOrder.count()).toBe(orders);
    expect(await prisma.salesOrderItem.count()).toBe(items);

    const after = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });
    expect(Number(after._sum.crmStockQty ?? 0)).toBe(Number(stock._sum.crmStockQty ?? 0));
    expect(Number(after._sum.inventoryQty ?? 0)).toBe(Number(stock._sum.inventoryQty ?? 0));
  });
});
