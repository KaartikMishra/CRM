/**
 * The Procurement Clock UI, asserted structurally.
 *
 * Four things this file exists to stop, all of them ways a correct backend gets
 * undone by the screen in front of it:
 *
 *   1. A SECOND ARITHMETIC. The API derives every quantity and the state from the
 *      order's lines. The moment a component subtracts one figure from another,
 *      there are two answers to "how much is still owed" and they will diverge.
 *
 *   2. THE TWO DELAYED OUTCOMES COLLAPSING. "Late, still short" and "covered
 *      late" mean different things to act on. One amber "Delayed" for both would
 *      hide which of the two a reader is looking at.
 *
 *   3. AN APPROVAL READING AS A PARDON. Approving a delay reason does not make a
 *      late order on time. The screen has to say so, because the number beside it
 *      will not change and somebody will wonder why.
 *
 *   4. AN ESTIMATE READING AS A FACT. Historical orders covered before the clock
 *      existed carry an inferred completion time. It must be labelled.
 *
 * Structural rather than rendered: these are Server Components and layout
 * classes, and this directory's established style is to assert the source. What
 * the browser actually paints is a separate, manual check.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The same file with its comments removed, for assertions about code. */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = read('app/(app)/procurement/clock/page.tsx');
const board = read('components/procurement/clock-board.tsx');
const dialog = read('components/procurement/clock-detail-dialog.tsx');
const queues = read('components/procurement/delay-queues.tsx');
const badges = read('components/procurement/procurement-badges.tsx');
const actions = read('app/(app)/procurement/actions.ts');
const navItems = read('components/layout/nav-items.ts');

const clockUi = [board, dialog, queues].map(codeOf).join('\n');

/* ----------------------------------------------------- it is a submodule */

describe('the clock stays a submodule of Purchase & Procurement', () => {
  it('lives under the procurement route, not beside it', () => {
    // The file's own path is the assertion; reading it proves it exists there.
    expect(page).toContain('Procurement Clock');
  });

  it('is still not a top-level sidebar module', () => {
    const topLevel = navItems.slice(navItems.indexOf('export const NAV_ITEMS'));
    // It appears only as a child entry, never as an item of its own.
    expect(topLevel).toContain("href: '/procurement/clock'");
    expect(topLevel).toContain('children:');
  });

  it('gates on the parent module and invents no new one', () => {
    expect(page).toContain("requireModule('PROCUREMENT')");
    expect(page).not.toContain('PROCUREMENT_CLOCK');
  });
});

/* ------------------------------------------------------- one arithmetic */

describe('the UI recomputes nothing the API already decided', () => {
  it('never derives a state in the browser', () => {
    // Every state string reaching the screen comes from `state`, via the badge.
    expect(clockUi).not.toContain("'UNFULFILLED_WITH_DELAY'");
    expect(clockUi).not.toContain("'FULFILLED_ON_TIME'");
    expect(clockUi).not.toContain("'FULFILLED_DELAYED'");
  });

  it('never compares a deadline against the clock itself', () => {
    expect(clockUi).not.toContain('Date.now()');
    expect(clockUi).not.toMatch(/new Date\(.*deadline/);
  });

  it('does no quantity arithmetic', () => {
    // No subtraction or addition of the API's figures anywhere in the clock UI.
    for (const field of ['outstandingQty', 'requiredQty', 'allocatedQty', 'alreadyFulfilled']) {
      expect(clockUi, field).not.toMatch(new RegExp(`${field}\\s*[-+]\\s*`));
      expect(clockUi, field).not.toMatch(new RegExp(`[-+]\\s*\\w*\\.${field}`));
    }
  });

  it('touches no stock figure at all — that is Procurement’s to write', () => {
    for (const forbidden of ['crmStockQty', 'stockedQty', 'receivedQty', 'reconcileLineStock']) {
      expect(clockUi, forbidden).not.toContain(forbidden);
    }
  });

  it('is not a ticking timer', () => {
    expect(clockUi).not.toContain('setInterval');
    expect(clockUi).not.toContain('setTimeout');
    expect(board).toContain('not a countdown');
  });
});

/* --------------------------------------------- the four states, worded apart */

describe('the two delayed outcomes are worded apart', () => {
  it('gives each of the four states its own label', () => {
    const labels = ['Unfulfilled', 'Late, still short', 'Covered on time', 'Covered late'];
    for (const text of labels) expect(badges, text).toContain(text);
  });

  it('never labels both delayed outcomes the same', () => {
    const map = badges.slice(badges.indexOf('const CLOCK_STATE'), badges.indexOf('ClockStateBadge'));
    const short = map.match(/UNFULFILLED_WITH_DELAY: \{ label: '([^']+)'/);
    const late = map.match(/FULFILLED_DELAYED: \{ label: '([^']+)'/);
    expect(short).not.toBeNull();
    expect(late).not.toBeNull();
    expect(short![1]).not.toBe(late![1]);
  });

  it('shows nothing rather than a state for a cancelled order', () => {
    expect(badges).toContain('if (!state) return null;');
  });

  it('separates a cancelled order’s own badge from the clock state', () => {
    expect(board).toContain("order.orderStatus === 'CANCELLED'");
  });
});

/* ----------------------------------------- an approval is not a pardon */

describe('the screen says that approving a reason does not clear the delay', () => {
  it('spells it out where procurement submits its account', () => {
    expect(dialog).toMatch(/does not change when[\s\S]{0,80}covered/);
    expect(dialog).toContain('covered late');
  });

  it('spells it out in the administrator’s queue too', () => {
    expect(queues).toMatch(/still reads/);
    expect(queues).toContain('covered late');
  });

  it('offers the order-level reason only on a late-covered order', () => {
    expect(dialog).toContain("order.verdict === 'DELAYED'");
  });

  it('never offers it for an order that is merely late and still short', () => {
    expect(codeOf(dialog)).not.toContain('UNFULFILLED_WITH_DELAY');
  });
});

/* ------------------------------------------------------- estimates labelled */

describe('an inferred completion time is labelled as inferred', () => {
  it('shows an Estimated marker on the board', () => {
    expect(board).toContain('completionEstimated');
    expect(board).toContain('Estimated');
  });

  it('says why in words, not just a badge', () => {
    expect(board).toMatch(/estimated, because/);
  });
});

/* ---------------------------------------------------------- the endpoints */

describe('the clock calls only its own endpoints', () => {
  const clockCalls = [...actions.matchAll(/`(\/api\/procurement\/clock[^`]*)`/g)].map((m) => m[1]);

  it('addresses each of the six clock paths and nothing else', () => {
    const shapes = new Set(
      clockCalls.map((path) => path.replace(/\$\{[^}]+\}/g, ':id')),
    );
    expect([...shapes].sort()).toEqual(
      [
        '/api/procurement/clock/:id',
        '/api/procurement/clock/:id/delay-reason',
        '/api/procurement/clock/items/:id/delay-reason',
        '/api/procurement/clock/procurement-delays/:id/${decision}'.replace('${decision}', ':id'),
        '/api/procurement/clock/purchase-delays/:id/${decision}'.replace('${decision}', ':id'),
      ].sort(),
    );
  });

  it('never posts to a sales endpoint from the clock UI', () => {
    expect(clockUi).not.toContain('/api/sales');
  });

  it('relays the API’s message rather than inventing one', () => {
    // Every failure path in the clock UI surfaces result.message.
    expect(dialog).toContain('setError(result.message)');
    expect(queues).toContain('setError(result.message)');
  });
});

/* ------------------------------------------------------------ permissions */

describe('permissions are read, never decided', () => {
  it('resolves each capability through can(), not through the role', () => {
    expect(page).toContain("can(access.user, 'PROCUREMENT', 'EDIT')");
    expect(page).toContain("can(access.user, 'PROCUREMENT', 'ASSIGN')");
  });

  it('reads the role only for the one thing that sits above the module', () => {
    // Comments stripped: the page's own doc comment names the rule it is
    // following, and counting that would be counting the explanation.
    const roleChecks = codeOf(page).split("role === 'ADMIN'").length - 1;
    expect(roleChecks).toBe(1);
    expect(page).toContain('isAdmin');
  });

  it('skips a queue entirely for somebody who could not act on it', () => {
    expect(page).toContain('canReview ? fetchPurchaseDelayQueue()');
    expect(page).toContain('isAdmin ? fetchProcurementDelayQueue()');
  });

  it('hides each queue behind the capability that decides it', () => {
    expect(page).toContain('{canReview && <PurchaseDelayQueue');
    expect(page).toContain('{isAdmin && <ProcurementDelayQueue');
  });

  it('keeps rejection available when approval is blocked, as the module already does', () => {
    // Both buttons are rendered together and neither is conditionally dropped.
    expect(queues).toContain('Reject');
    expect(queues).toContain('Approve');
  });
});
