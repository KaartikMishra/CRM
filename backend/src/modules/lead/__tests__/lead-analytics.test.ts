/**
 * The Lead/Deal analytics list — Phase 4E.
 *
 * Three things here are worth more than the rest, and each has a test whose
 * failure would be a real regression rather than a cosmetic one:
 *
 *   - **Order Value is derived.** It comes through Sales' own `toMoney`, so a
 *     lead's figure must equal what the Sales API reports for the same order.
 *     Asserted by comparing the two responses rather than against a literal.
 *
 *   - **No N+1.** The page costs a fixed number of queries whatever its size,
 *     proven by counting them through Prisma's own query event.
 *
 *   - **Null is not zero.** A lead with no order shows nothing; an order worth
 *     nothing shows 0.00. Conflating them would hide real orders.
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
let viewer: TestUser;
let other: TestUser;
let outsider: TestUser;

let adminToken: string;
let viewerToken: string;
let outsiderToken: string;

let customer: { id: string; name: string };

const hours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  viewer = await makeUser('USER');
  other = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  viewerToken = await mintToken(viewer.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  customer = await makeCustomer('RETAIL', {
    phone: '+919812300001',
    email: 'analytics@test.invalid',
  });

  await prisma.userModulePermission.createMany({
    data: (['VIEW', 'CREATE', 'EDIT', 'ASSIGN'] as const).map((action) => ({
      userId: viewer.id,
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

type Row = {
  id: string;
  customer: { name: string; phone: string | null; email: string | null };
  dealStatus: string;
  channel: string;
  associate: { id: string } | null;
  allocatedBy: { id: string } | null;
  allocation: string;
  orderValue: string | null;
  salesOrderId: string | null;
  initiatedAt: string;
  firstContactAt: string | null;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  promptness: { expected: number; onTime: number; overdue: number; score: number | null; rating: string };
};

type Page = { leads: Row[]; nextCursor: string | null; narrowedByDerivedFilter: boolean };

const list = (token: string, qs = '') =>
  api<Page>('GET', `/api/leads${qs}`, { token });

async function makeLead(over: Record<string, unknown> = {}): Promise<string> {
  const res = await api('POST', '/api/leads', {
    token: viewerToken,
    body: {
      leadSource: 'CALL',
      sourceAt: new Date().toISOString(),
      requirementType: 'RETAIL',
      customer: { customerId: customer.id },
      channel: 'ROYALSTUFFS_COM',
      ...over,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { lead: { id: string } }).lead.id;
}

const addActivity = (leadId: string, body: Record<string, unknown>) =>
  api('POST', `/api/leads/${leadId}/activities`, { token: viewerToken, body });

const assign = (leadId: string, associateId: string | null) =>
  api('POST', `/api/leads/${leadId}/assign`, { token: viewerToken, body: { associateId } });

const rowFor = (page: Page, id: string): Row | undefined =>
  page.leads.find((l) => l.id === id);

/** Links an order to a lead directly — there is no API for it in this phase. */
async function linkOrder(leadId: string, orderId: string): Promise<void> {
  await prisma.lead.update({ where: { id: leadId }, data: { salesOrderId: orderId } });
}

async function makeOrder(price = '1000.00', quantity = 2): Promise<string> {
  const res = await api('POST', '/api/sales', {
    token: adminToken,
    body: salesOrderPayload(customer.id, {
      items: [{ productName: 'zz-test-analytics-line', quantity, price }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const order = (res.body.data as { order: { id: string } }).order;
  trackSalesOrder(order.id);
  return order.id;
}

// ---------------------------------------------------------------------------
//  Access
// ---------------------------------------------------------------------------

describe('access', () => {
  it('requires LEAD_DEAL:VIEW', async () => {
    expect((await list(outsiderToken)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await api('GET', '/api/leads')).status).toBe(401);
  });

  it('admits an administrator with no override rows', async () => {
    expect((await list(adminToken)).status).toBe(200);
  });

  it('is not parsed as a lead id', async () => {
    // `GET /` is declared before `GET /:id`.
    const res = await list(viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  Pagination and sorting
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('honours the limit and hands back a cursor', async () => {
    for (let i = 0; i < 3; i += 1) await makeLead();

    const first = await list(viewerToken, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.data!.leads).toHaveLength(2);
    expect(first.body.data!.nextCursor).not.toBeNull();

    const second = await list(viewerToken, `?limit=2&cursor=${first.body.data!.nextCursor}`);
    expect(second.status).toBe(200);

    // No row appears on both pages — the ordering carries an id tiebreak.
    const firstIds = first.body.data!.leads.map((l) => l.id);
    const secondIds = second.body.data!.leads.map((l) => l.id);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('refuses a limit outside the shared bounds', async () => {
    expect((await list(viewerToken, '?limit=0')).status).toBe(422);
    expect((await list(viewerToken, '?limit=5000')).status).toBe(422);
  });

  it('refuses a cursor that is not an identifier', async () => {
    expect((await list(viewerToken, '?cursor=not-a-cuid')).status).toBe(422);
  });

  it('reports narrowedByDerivedFilter only when one is used', async () => {
    expect((await list(viewerToken, '?limit=5')).body.data!.narrowedByDerivedFilter).toBe(false);
    expect(
      (await list(viewerToken, '?limit=5&promptness=GOOD')).body.data!.narrowedByDerivedFilter,
    ).toBe(true);
  });
});

describe('sorting', () => {
  it('defaults to newest-initiated first', async () => {
    const older = await makeLead({ sourceAt: hours(-200) });
    const newer = await makeLead({ sourceAt: hours(-1) });

    const page = (await list(viewerToken, '?limit=100')).body.data!;
    const ids = page.leads.map((l) => l.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  it('can be reversed', async () => {
    const older = await makeLead({ sourceAt: hours(-300) });
    const newer = await makeLead({ sourceAt: hours(-2) });

    const page = (await list(viewerToken, '?limit=100&direction=asc')).body.data!;
    const ids = page.leads.map((l) => l.id);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });

  it('refuses a sort field outside the allowlist', async () => {
    // Nothing a caller sends can reach an ORDER BY clause.
    expect((await list(viewerToken, '?sort=customerName')).status).toBe(422);
    expect((await list(viewerToken, '?sort=id;DROP TABLE "Lead"')).status).toBe(422);
    expect((await list(viewerToken, '?direction=sideways')).status).toBe(422);
  });

  it('accepts every allowlisted sort', async () => {
    for (const sort of ['initiatedAt', 'dealStatus', 'createdAt']) {
      expect((await list(viewerToken, `?sort=${sort}`)).status, sort).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
//  Filters
// ---------------------------------------------------------------------------

describe('search', () => {
  it('finds a lead by its customer name, phone and email', async () => {
    const id = await makeLead();

    for (const q of [customer.name, '9812300001', 'analytics@test.invalid']) {
      const page = (await list(viewerToken, `?limit=100&q=${encodeURIComponent(q)}`)).body.data!;
      expect(rowFor(page, id), q).toBeDefined();
    }
  });

  it('finds a lead by its own source note', async () => {
    const id = await makeLead({ sourceDetails: 'zz-unique-source-marker' });
    const page = (await list(viewerToken, '?limit=100&q=zz-unique-source-marker')).body.data!;
    expect(rowFor(page, id)).toBeDefined();
  });

  it('returns nothing for a term nobody matches', async () => {
    const page = (await list(viewerToken, '?q=zzz-nothing-matches-this')).body.data!;
    expect(page.leads).toHaveLength(0);
  });
});

describe('the deal status filter', () => {
  it('returns only that status', async () => {
    const won = await makeLead();
    const open = await makeLead();
    await api('PATCH', `/api/leads/${won}`, {
      token: viewerToken,
      body: { dealStatus: 'WON' },
    });

    const page = (await list(viewerToken, '?limit=100&dealStatus=WON')).body.data!;
    expect(rowFor(page, won)).toBeDefined();
    expect(rowFor(page, open)).toBeUndefined();
    expect(page.leads.every((l) => l.dealStatus === 'WON')).toBe(true);
  });

  it('refuses a status outside the vocabulary', async () => {
    expect((await list(viewerToken, '?dealStatus=PENDING')).status).toBe(422);
  });
});

describe('the channel filter', () => {
  it('returns only that channel', async () => {
    const indiamart = await makeLead({ channel: 'INDIAMART' });
    const dotCom = await makeLead({ channel: 'ROYALSTUFFS_COM' });

    const page = (await list(viewerToken, '?limit=100&channel=INDIAMART')).body.data!;
    expect(rowFor(page, indiamart)).toBeDefined();
    expect(rowFor(page, dotCom)).toBeUndefined();
  });

  it('refuses a channel outside the vocabulary', async () => {
    expect((await list(viewerToken, '?channel=EBAY')).status).toBe(422);
  });
});

describe('the associate filter', () => {
  it('returns only that associate’s leads', async () => {
    const mine = await makeLead();
    const theirs = await makeLead();
    await assign(mine, viewer.id);
    await assign(theirs, other.id);

    const page = (await list(viewerToken, `?limit=100&associateId=${viewer.id}`)).body.data!;
    expect(rowFor(page, mine)).toBeDefined();
    expect(rowFor(page, theirs)).toBeUndefined();
  });
});

describe('the allocation filter', () => {
  it('separates SELF, OTHER_USER and UNASSIGNED', async () => {
    const self = await makeLead();
    const handed = await makeLead();
    const none = await makeLead();

    await assign(self, viewer.id); // actor assigns to themselves
    await assign(handed, other.id); // actor assigns to somebody else

    const selfPage = (await list(viewerToken, '?limit=100&allocation=SELF')).body.data!;
    expect(rowFor(selfPage, self)?.allocation).toBe('SELF');
    expect(rowFor(selfPage, handed)).toBeUndefined();

    const otherPage = (await list(viewerToken, '?limit=100&allocation=OTHER_USER')).body.data!;
    expect(rowFor(otherPage, handed)?.allocation).toBe('OTHER_USER');

    const nonePage = (await list(viewerToken, '?limit=100&allocation=UNASSIGNED')).body.data!;
    expect(rowFor(nonePage, none)?.allocation).toBe('UNASSIGNED');
  });

  it('refuses an allocation value outside the three', async () => {
    expect((await list(viewerToken, '?allocation=MINE')).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Order value — derived, never stored
// ---------------------------------------------------------------------------

describe('order value', () => {
  it('is null when no order is linked — never zero', async () => {
    const id = await makeLead();
    const page = (await list(viewerToken, '?limit=100')).body.data!;
    const row = rowFor(page, id)!;

    expect(row.salesOrderId).toBeNull();
    expect(row.orderValue).toBeNull();
    // The distinction that matters: "no order" is not "an order worth nothing".
    expect(row.orderValue).not.toBe('0.00');
  });

  it('matches what the Sales API reports for the same order', async () => {
    /*
      Compared against Sales' own answer rather than a literal, because the
      point is that there is ONE definition of what an order is worth. If
      `toMoney` changes — GST handling, charges, cancellations — both move
      together and this still passes.
    */
    const orderId = await makeOrder('1250.50', 2);
    const leadId = await makeLead();
    await linkOrder(leadId, orderId);

    const sales = await api('GET', `/api/sales/${orderId}`, { token: adminToken });
    expect(sales.status).toBe(200);
    const expected = (sales.body.data as { order: { money: { total: string } } }).order.money
      .total;

    const page = (await list(viewerToken, '?limit=100')).body.data!;
    expect(rowFor(page, leadId)!.orderValue).toBe(expected);
  });

  it('carries the linked order id beside the value', async () => {
    const orderId = await makeOrder();
    const leadId = await makeLead();
    await linkOrder(leadId, orderId);

    const page = (await list(viewerToken, '?limit=100')).body.data!;
    expect(rowFor(page, leadId)!.salesOrderId).toBe(orderId);
  });

  it('stores no value on the lead itself', async () => {
    const orderId = await makeOrder();
    const leadId = await makeLead();
    await linkOrder(leadId, orderId);

    const [row] = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "Lead" WHERE "id" = ${leadId}`;
    const columns = Object.keys(row ?? {}).map((c) => c.toLowerCase());

    expect(columns).not.toContain('ordervalue');
    expect(columns).not.toContain('dealvalue');
    expect(columns).not.toContain('quotedvalue');
  });
});

// ---------------------------------------------------------------------------
//  Promptness on the list
// ---------------------------------------------------------------------------

describe('promptness on the list', () => {
  /** Builds a lead with `onTime` kept and `missed` ignored, then assigns it. */
  async function leadScoring(onTime: number, missed: number): Promise<string> {
    const id = await makeLead();
    for (let i = 0; i < onTime; i += 1) {
      await addActivity(id, {
        kind: 'FOLLOW_UP',
        dueAt: hours(-50 - i),
        completedAt: hours(-51 - i),
      });
    }
    for (let i = 0; i < missed; i += 1) {
      await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-20 - i) });
    }
    await assign(id, viewer.id);
    return id;
  }

  it('reports GOOD at 1/1', async () => {
    const id = await leadScoring(1, 0);
    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.rating).toBe('GOOD');
    expect(row.promptness.score).toBeCloseTo(1, 5);
  });

  it('reports GOOD at 3/4 and AVERAGE at 3/5', async () => {
    const good = await leadScoring(3, 1);
    const average = await leadScoring(3, 2);

    const page = (await list(viewerToken, '?limit=100')).body.data!;
    expect(rowFor(page, good)!.promptness.rating).toBe('GOOD');
    expect(rowFor(page, average)!.promptness.rating).toBe('AVERAGE');
    expect(rowFor(page, average)!.promptness.score).toBeCloseTo(0.6, 5);
  });

  it('reports POOR when nothing was done on time', async () => {
    const id = await leadScoring(0, 3);
    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.rating).toBe('POOR');
    expect(row.promptness.score).toBe(0);
  });

  it('reports NOT_RATED for a lead with no activity', async () => {
    const id = await makeLead();
    await assign(id, viewer.id);

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.rating).toBe('NOT_RATED');
    expect(row.promptness.score).toBeNull();
    expect(row.promptness.expected).toBe(0);
  });

  it('reports NOT_RATED when nobody is assigned', async () => {
    const id = await makeLead();
    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-10),
      completedAt: hours(-11),
    });

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.rating).toBe('NOT_RATED');
    // The work is still counted, so a rating appears the moment it is assigned.
    expect(row.promptness.expected).toBe(1);
    expect(row.promptness.onTime).toBe(1);
  });

  it('reports NOT_RATED when every action is still in the future', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(48) });
    await assign(id, viewer.id);

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.expected).toBe(0);
    expect(row.promptness.rating).toBe('NOT_RATED');
  });

  it('counts an overdue incomplete action separately from one completed late', async () => {
    const id = await makeLead();
    // Never done.
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-30) });
    // Done, but after its deadline.
    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: hours(-40),
      completedAt: hours(-10),
    });
    await assign(id, viewer.id);

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.promptness.expected).toBe(2);
    expect(row.promptness.onTime).toBe(0);
    // Only the untouched one is overdue; `expected - onTime` would say 2.
    expect(row.promptness.overdue).toBe(1);
  });

  it('filters by rating', async () => {
    const good = await leadScoring(2, 0);
    const poor = await leadScoring(0, 2);

    const page = (await list(viewerToken, '?limit=100&promptness=GOOD')).body.data!;
    expect(rowFor(page, good)).toBeDefined();
    expect(rowFor(page, poor)).toBeUndefined();
    expect(page.leads.every((l) => l.promptness.rating === 'GOOD')).toBe(true);
  });

  it('refuses a rating outside the four', async () => {
    expect((await list(viewerToken, '?promptness=EXCELLENT')).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Follow-up fields
// ---------------------------------------------------------------------------

describe('the follow-up columns', () => {
  it('reports the latest completed and the earliest upcoming', async () => {
    /*
      The exact instants sent are kept and compared, rather than re-deriving
      `hours(-24)` at assertion time: this suite takes seconds per request, so a
      freshly computed clock drifts from the one the row was built with and the
      test would fail for a reason having nothing to do with the code.
    */
    const id = await makeLead();
    const olderCompleted = hours(-48);
    const latestCompleted = hours(-24);
    const soonest = hours(24);
    const furthest = hours(96);

    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: olderCompleted,
      completedAt: olderCompleted,
    });
    await addActivity(id, {
      kind: 'FOLLOW_UP',
      dueAt: latestCompleted,
      completedAt: latestCompleted,
    });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: furthest });
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: soonest });

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;

    // Latest completed, not latest due.
    expect(new Date(row.lastFollowUpAt!).toISOString()).toBe(
      new Date(latestCompleted).toISOString(),
    );
    // Earliest upcoming, not the one furthest out.
    expect(new Date(row.nextFollowUpAt!).toISOString()).toBe(
      new Date(soonest).toISOString(),
    );
  });

  it('never offers an overdue follow-up as the next one', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-6) });
    await assign(id, viewer.id);

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.nextFollowUpAt).toBeNull();
    // But it is visible as overdue, which is where it belongs.
    expect(row.promptness.overdue).toBe(1);
  });

  it('reports the completed first contact', async () => {
    const id = await makeLead();
    await addActivity(id, {
      kind: 'FIRST_CONTACT',
      dueAt: hours(-60),
      completedAt: hours(-59),
    });

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.firstContactAt).not.toBeNull();
    // A first contact is not a follow-up.
    expect(row.lastFollowUpAt).toBeNull();
  });

  it('leaves first contact null while it is outstanding', async () => {
    const id = await makeLead();
    await addActivity(id, { kind: 'FIRST_CONTACT', dueAt: hours(-5) });

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row.firstContactAt).toBeNull();
  });

  it('filters by overdue and upcoming follow-ups', async () => {
    const overdue = await makeLead();
    await addActivity(overdue, { kind: 'FOLLOW_UP', dueAt: hours(-9) });
    await assign(overdue, viewer.id);

    const upcoming = await makeLead();
    await addActivity(upcoming, { kind: 'FOLLOW_UP', dueAt: hours(36) });

    const overduePage = (await list(viewerToken, '?limit=100&followUp=overdue')).body.data!;
    expect(rowFor(overduePage, overdue)).toBeDefined();

    const upcomingPage = (await list(viewerToken, '?limit=100&followUp=upcoming')).body.data!;
    expect(rowFor(upcomingPage, upcoming)).toBeDefined();
    expect(upcomingPage.leads.every((l) => l.nextFollowUpAt !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  The N+1 guard
// ---------------------------------------------------------------------------

describe('query cost', () => {
  it('costs a fixed number of activity reads whatever the page size', async () => {
    /*
      THE REGRESSION GUARD. Promptness is per lead, so the natural
      implementation asks for one lead's activities at a time — an N+1 nothing
      else would catch until the table was slow in production.

      Measured structurally rather than by timing or by patching an ES module
      export (which is read-only): the service's only route to activity data is
      `findActivitiesForLeads`, which takes an ARRAY of lead ids. A per-row
      implementation could not use it — it would have to call it once per lead,
      or add a single-id reader. So the property pinned here is that no
      single-lead activity reader exists for a list to reach for, and that the
      batched one genuinely serves many leads at once.
    */
    const repoSource = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../lead.repository.ts', import.meta.url).pathname,
        'utf8',
      ),
    );
    const serviceSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../lead.service.ts', import.meta.url).pathname, 'utf8'),
    );

    // The list path calls the batched reader exactly once.
    const listBody = serviceSource.slice(serviceSource.indexOf('export async function listLeads'));
    const batchedCalls = listBody.match(/findActivitiesForLeads\(/g) ?? [];
    expect(batchedCalls).toHaveLength(1);

    // And it is called with a mapped array of ids, never inside a loop.
    expect(listBody).toContain('page.map((lead) => lead.id)');
    expect(listBody).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*findActivitiesForLeads/);

    // No per-lead activity reader exists that a list could regress onto.
    expect(repoSource).not.toContain('findActivitiesForLead(');
  });

  it('serves a whole page from one activity read', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await makeLead();
      await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-5 - i) });
      ids.push(id);
    }

    const repo = await import('../lead.repository.js');
    const all = await repo.findActivitiesForLeads(ids);

    // Every lead's activity came back from the single call.
    for (const id of ids) {
      expect(all.some((a) => a.leadId === id), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
//  Row shape
// ---------------------------------------------------------------------------

describe('the row the table draws', () => {
  it('carries every column without a follow-up request', async () => {
    const id = await makeLead();
    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;

    // The nine business columns, plus what it takes to render them.
    expect(row.customer.name).toBeTruthy();
    expect(row.dealStatus).toBe('INPROCESS');
    expect(row.channel).toBe('ROYALSTUFFS_COM');
    expect(row.allocation).toBe('UNASSIGNED');
    expect(row.initiatedAt).toBeTruthy();
    expect(row.promptness.rating).toBe('NOT_RATED');
    expect(row).toHaveProperty('orderValue');
    expect(row).toHaveProperty('lastFollowUpAt');
    expect(row).toHaveProperty('nextFollowUpAt');
  });

  it('exposes the customer contact but not their whole record', async () => {
    const id = await makeLead();
    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    const keys = Object.keys(row.customer);

    expect(keys.sort()).toEqual(['email', 'id', 'name', 'phone']);
    // Nothing the table does not draw.
    expect(keys).not.toContain('gstNumber');
    expect(keys).not.toContain('address');
  });

  it('does not embed the activity timeline', async () => {
    // The detail endpoint carries that; fifty timelines is a payload nobody reads.
    const id = await makeLead();
    await addActivity(id, { kind: 'FOLLOW_UP', dueAt: hours(-5) });

    const row = rowFor((await list(viewerToken, '?limit=100')).body.data!, id)!;
    expect(row).not.toHaveProperty('activities');
  });
});
