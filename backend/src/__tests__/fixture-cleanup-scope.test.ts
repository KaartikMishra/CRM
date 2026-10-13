/**
 * The scope of fixture cleanup: which rows a run may delete, and which it must
 * not.
 *
 * ### The two requirements, and why one mechanism cannot serve both
 *
 * `sweepTestOwnedRows` deletes by name rather than by tracked id, and it has to:
 * if the database commits an insert and the connection drops before the client
 * sees the result, the row exists and no id was ever recorded, so an id-based
 * cleanup can never reach it. The same applies to rows the API creates.
 *
 * That sweep has to satisfy two things at once:
 *
 *   1. **Never delete a concurrent run's fixtures.** Tearing somebody's rows out
 *      mid-test surfaces as an inexplicable flake, in their suite, not this one.
 *   2. **Never leave an orphan behind.** `residualTestRows()` is asserted in
 *      every suite's `afterAll`, so a row the sweep cannot reclaim fails every
 *      suite that runs afterwards — one stray customer becomes dozens of file
 *      failures with nothing actually wrong.
 *
 * A bare prefix filter satisfies (2) and violates (1). A pure age bound satisfies
 * (1) and violates (2), because age cannot tell "young because a concurrent run
 * just made this" from "young because a run died a minute ago" — the two are the
 * same observation. **This file shipped that second bug**, and these tests exist
 * so it cannot come back.
 *
 * The resolution is ownership encoded in the name (`zz-test-r<runId>-…`), with
 * age as a fallback only for rows whose owner cannot be identified.
 *
 * Mostly structural assertions, reading the source: what matters is the *shape of
 * every filter*, and running the sweep could at best show it did not delete
 * anything on one particular occasion. The behavioural tests at the bottom use
 * real rows for the three cases that actually need proving.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../config/database.js';
import {
  RUN_PREFIX,
  TEST_PREFIX,
  TEST_RUN_ID,
  cleanup,
  fixtureOwnership,
  residualTestRows,
} from './helpers/fixtures.js';

const source = readFileSync(join(import.meta.dirname, 'helpers', 'fixtures.ts'), 'utf8');

/** The body of sweepTestOwnedRows, which is what most of this file inspects. */
function sweepBody(): string {
  const start = source.indexOf('async function sweepTestOwnedRows');
  expect(start, 'sweepTestOwnedRows has been renamed or removed').toBeGreaterThan(-1);
  const end = source.indexOf('\n/**', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Rows these tests create by hand, removed in afterAll regardless of outcome. */
const strays: { customers: string[]; users: string[] } = { customers: [], users: [] };

afterAll(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: strays.customers } } });
  await prisma.user.deleteMany({ where: { id: { in: strays.users } } });
  await cleanup();
  expect(await residualTestRows()).toBe(0);
});

describe('the run marker', () => {
  it('is unique per process and carries the pid for traceability', () => {
    // The pid is not for uniqueness — randomUUID covers that. It is so somebody
    // staring at a stray row in the database can tell which process made it.
    expect(TEST_RUN_ID).toMatch(/^[0-9a-f]{6}-\d+$/);
    expect(TEST_RUN_ID.endsWith(`-${process.pid}`)).toBe(true);
  });

  it('keeps TEST_PREFIX as its leading segment', () => {
    /*
      Essential, not cosmetic: the sweep's outer guard and the "is this a test
      row" checks are all `startsWith(TEST_PREFIX)`. If the run marker replaced
      the prefix rather than extending it, real business data would come within
      reach of those filters.
    */
    expect(RUN_PREFIX.startsWith(`${TEST_PREFIX}-r`)).toBe(true);
  });

  it('classifies mine, another run’s, and unmarked names', () => {
    expect(fixtureOwnership(`${RUN_PREFIX}-customer-abc`)).toBe('mine');
    // A different run id — the case that must never be deleted while young.
    expect(fixtureOwnership('zz-test-r9f0e1d-99999-customer-abc')).toBe('other-run');
    // Pre-dating this scheme, or hand-built.
    expect(fixtureOwnership('zz-test-legacy-customer')).toBe('unmarked');
    expect(fixtureOwnership('zz-test-customer')).toBe('unmarked');
  });

  it('does not mistake a real business name for a fixture', () => {
    for (const name of ['Royal Brass Works', 'zz-production', 'test-customer']) {
      expect(fixtureOwnership(name), name).toBe('unmarked');
    }
    // And "unmarked" alone never authorises deletion — the sweep's outer
    // TEST_PREFIX guard is what keeps these unreachable. Asserted below.
  });
});

describe('every fixture this run creates carries the marker', () => {
  it('builds all fixture names from RUN_PREFIX, not the bare prefix', () => {
    /*
      The guarantee the whole design rests on: if even one fixture is named with
      the bare prefix, that row is "unmarked", so it is swept only on age and is
      not counted by residualTestRows — silently reintroducing the orphan it was
      meant to prevent.
    */
    const helperSection = source.slice(0, source.indexOf('async function sweepTestOwnedRows'));
    const bareNameBuilds = [
      ...helperSection.matchAll(/(?:name|productName|title|billNumber|email):\s*`\$\{TEST_PREFIX\}/g),
    ];
    expect(bareNameBuilds.map((m) => m[0])).toEqual([]);
  });

  it('counts residuals by this run’s marker, not globally', () => {
    /*
      The exact regression. A global count holds each suite responsible for rows
      it never created, so one unreclaimable orphan fails every later suite's
      afterAll. Counting by marker keeps the check doing its real job — proving
      THIS suite tidied up — while making it immune to debris it cannot clean.
    */
    const residual = source.slice(source.indexOf('export async function residualTestRows'));
    expect(residual).toContain('const mine = { startsWith: `${RUN_PREFIX}-` }');
    // And no global name filter survives in it.
    expect(residual).not.toMatch(/name:\s*\{\s*startsWith:\s*TEST_PREFIX\s*\}/);
    expect(residual).not.toMatch(/title:\s*\{\s*startsWith:\s*TEST_PREFIX\s*\}/);
  });
});

describe('the sweep deletes by ownership, with age only as a fallback', () => {
  it('scopes every owner match to mine-at-any-age OR stale', () => {
    const body = sweepBody();
    // The two-branch rule, which is the heart of the fix.
    expect(body).toMatch(/OR:\s*\[\s*\{\s*name:\s*\{\s*startsWith:\s*`\$\{RUN_PREFIX\}-`/s);
    expect(body).toContain('createdAt: { lt: staleBefore }');
  });

  it('keeps the outer TEST_PREFIX guard, so business data stays unreachable', () => {
    /*
      The age branch alone would match ANY row older than an hour. The outer
      `name: { startsWith: TEST_PREFIX }` is what stops that reaching real
      customers — it is redundant against the "mine" branch and load-bearing
      against the stale one.
    */
    const body = sweepBody();
    expect(body).toMatch(/const owned = \{\s*name: \{ startsWith: TEST_PREFIX \},/s);
  });

  it('does not reclaim another run’s rows on ownership alone', () => {
    // There must be no branch that deletes a non-mine row without an age test.
    const body = sweepBody();
    const ownedDecl = body.slice(body.indexOf('const owned = {'), body.indexOf('const ownedName'));
    expect(ownedDecl).toContain('staleBefore');
  });

  it('gives the sales-order line branch the same two-branch rule', () => {
    /*
      The loosest filter here: it matches an order because a *line item* is named
      zz-test…, so it can reach an order whose customer and creator are both real
      business records. There is no owner row to inherit a marker from, so the
      rule is applied to the line name itself.
    */
    const body = sweepBody();
    const branch = body.slice(body.indexOf('prisma.salesOrder.deleteMany'));
    const window = branch.slice(0, 700);
    expect(window).toContain('productName: { startsWith: `${RUN_PREFIX}-` }');
    expect(window).toContain('createdAt: { lt: staleBefore }');
  });

  it('sweeps RS Products, which residualTestRows counts but the sweep once missed', () => {
    /*
      A real gap this fix closes. RsProduct was cleaned only by tracked id while
      residualTestRows counted it globally by title — so an untracked one had
      nothing to reclaim it and would fail every later suite indefinitely.
    */
    const body = sweepBody();
    expect(body).toContain('prisma.rsProduct.deleteMany');
    const branch = body.slice(body.indexOf('prisma.rsProduct.deleteMany'));
    expect(branch).toContain('title: { startsWith: TEST_PREFIX }');
    expect(branch).toContain('title: { startsWith: `${RUN_PREFIX}-` }');
  });

  it('applies age only to rows it does not own', () => {
    // SWEEP_MIN_AGE_MS must not be the only ownership mechanism (it was, and that
    // was the bug). It survives strictly as the fallback branch.
    expect(source).toContain('SWEEP_MIN_AGE_MS');
    expect(source).toMatch(/staleBefore\s*=\s*new Date\(Date\.now\(\) - SWEEP_MIN_AGE_MS\)/);
  });
});

describe('the sweep still cannot reach real business data', () => {
  it('qualifies every delete', () => {
    const body = sweepBody();
    const deletes = body.match(/prisma\.\w+\.deleteMany\(\{/g) ?? [];
    expect(deletes.length).toBeGreaterThan(8);
    // No unqualified deleteMany anywhere — that would empty a production table.
    expect(body).not.toMatch(/deleteMany\(\{\s*\}\)/);
    expect(body).not.toMatch(/where:\s*\{\s*\}/);
  });

  it('keeps the deletes ordered so foreign keys are satisfied', () => {
    const body = sweepBody();
    // Leads before customers: Lead -> Customer is Restrict.
    expect(body.indexOf('prisma.lead.deleteMany')).toBeLessThan(
      body.indexOf('prisma.customer.deleteMany'),
    );
    // Users last: nearly everything points at one.
    expect(body.indexOf('prisma.user.deleteMany')).toBeGreaterThan(
      body.indexOf('prisma.customer.deleteMany'),
    );
  });

  it('preserves the orphan-recovery rationale in the docs', () => {
    /*
      Requirement: the sweep exists because tracking happens *after* the create
      resolves, so a committed row whose id was lost is unreachable by id. If that
      explanation goes, somebody will "simplify" the sweep away.
    */
    expect(source).toContain('created.userIds.push(user.id)');
    expect(source).toContain('fileParallelism');
  });
});

describe('the cross-cutting foundation tables are cleaned up', () => {
  it('removes approval requests from both sides', () => {
    // ApprovalRequest and SecureDocument are Restrict on User, so an orphaned row
    // pins a fixture user and teardown fails on a constraint.
    expect(source).toContain('prisma.approvalRequest.deleteMany');
    expect(source).toContain('requestedById: { in: created.userIds }');
    expect(source).toContain('decidedById: { in: created.userIds }');
  });

  it('removes secure documents by uploader and by owner', () => {
    expect(source).toContain('prisma.secureDocument.deleteMany');
    expect(source).toContain("ownerType: 'User'");
  });

  it('removes HR settings, which collide on (module, key)', () => {
    expect(source).toContain('prisma.hRSetting.deleteMany');
  });

  it('removes all three in the sweep as well as the tracked teardown', () => {
    const body = sweepBody();
    for (const call of [
      'prisma.approvalRequest.deleteMany',
      'prisma.secureDocument.deleteMany',
      'prisma.hRSetting.deleteMany',
    ]) {
      expect(body, call).toContain(call);
      expect(body.indexOf(call)).toBeLessThan(body.indexOf('prisma.user.deleteMany'));
    }
  });
});

// ---------------------------------------------------------------------------
//  Behaviour against real rows — the three cases that must actually hold
// ---------------------------------------------------------------------------

describe('current-run cleanup reclaims an untracked row immediately', () => {
  it('deletes a row this run created but never tracked, at any age', async () => {
    /*
      The orphan class the sweep exists for: created directly, so no fixture
      helper recorded its id — exactly what happens when the API creates a row, or
      when a commit succeeds and the response is lost in flight.

      It is seconds old. Under the age-only rule this survived and then failed
      every later suite's residual check. Under ownership it goes now.
    */
    const stray = await prisma.customer.create({
      data: { name: `${RUN_PREFIX}-untracked-orphan`, type: 'RETAIL' },
      select: { id: true, name: true },
    });
    strays.customers.push(stray.id);

    expect(fixtureOwnership(stray.name)).toBe('mine');

    await cleanup();

    expect(await prisma.customer.findUnique({ where: { id: stray.id } })).toBeNull();
  });
});

describe('a concurrent run’s fixtures are preserved', () => {
  it('leaves a young row belonging to another run untouched', async () => {
    /*
      Requirement (1). This row is named as another run's and is seconds old — the
      signature of a suite currently in progress in another process. Deleting it
      would tear that run's fixtures out mid-test.
    */
    const theirs = await prisma.customer.create({
      data: { name: 'zz-test-r9f0e1d-999999-concurrent-customer', type: 'RETAIL' },
      select: { id: true, name: true },
    });
    strays.customers.push(theirs.id);

    expect(fixtureOwnership(theirs.name)).toBe('other-run');

    await cleanup();

    const survived = await prisma.customer.findUnique({ where: { id: theirs.id } });
    expect(survived, 'a concurrent run’s fixture was deleted').not.toBeNull();
  });

  it('does not count another run’s row as this run’s residual', async () => {
    /*
      Requirement (2) from the other direction, and the precise fix for the
      cascade: the orphan that broke the suite was a *different* run's customer,
      21 minutes old. A global count blamed this suite for it. It must not.
    */
    const theirs = await prisma.customer.create({
      data: { name: 'zz-test-r1a2b3c-888888-previous-run-orphan', type: 'RETAIL' },
      select: { id: true },
    });
    strays.customers.push(theirs.id);

    await cleanup();

    // The row is still there (not mine, and young), and residual is still zero.
    expect(await prisma.customer.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    expect(await residualTestRows()).toBe(0);
  });

  it('does not count an unmarked legacy orphan as this run’s residual', async () => {
    // Rows named before the run-marker scheme existed. Reclaimed on age, never
    // blamed on a suite that did not create them.
    const legacy = await prisma.customer.create({
      data: { name: `${TEST_PREFIX}-legacy-unmarked-orphan`, type: 'RETAIL' },
      select: { id: true, name: true },
    });
    strays.customers.push(legacy.id);

    expect(fixtureOwnership(legacy.name)).toBe('unmarked');

    await cleanup();
    expect(await residualTestRows()).toBe(0);
  });
});

describe('residualTestRows still catches this run’s own escapes', () => {
  it('reports a row this run created that cleanup did not remove', async () => {
    /*
      The check must not have been weakened into uselessness. A marked row that
      survives cleanup is still a failure — proven by making one unreachable to
      the sweep's own ordering and confirming the count sees it.
    */
    const escaped = await prisma.customer.create({
      data: { name: `${RUN_PREFIX}-deliberate-escape`, type: 'RETAIL' },
      select: { id: true },
    });
    strays.customers.push(escaped.id);

    expect(await residualTestRows()).toBeGreaterThan(0);

    // And cleanup does reclaim it, returning the count to zero.
    await cleanup();
    expect(await residualTestRows()).toBe(0);
  });
});
