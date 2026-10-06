/**
 * Associate promptness, as pure arithmetic.
 *
 * No database and no HTTP: these are the functions the detail page and the
 * future analytics table both read through, and the point of testing them alone
 * is that the rules they encode are business rules, not plumbing.
 *
 * The four ratios from the business's own notebook are asserted by name below,
 * because they are the shapes the feature exists to tell apart.
 */

import { describe, expect, it } from 'vitest';
import {
  allocationKind,
  lastFollowUpAt,
  nextFollowUpAt,
  promptness,
  rate,
  type PromptnessInput,
} from '../lead.calc.js';

/** A fixed "now", so nothing here depends on when the suite runs. */
const NOW = new Date('2026-10-05T12:00:00.000Z');

const hoursFromNow = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

/** An action that was due in the past and was done by its deadline. */
const onTimeAction = (over: Partial<PromptnessInput> = {}): PromptnessInput => ({
  kind: 'FOLLOW_UP',
  dueAt: hoursFromNow(-24),
  completedAt: hoursFromNow(-25),
  ...over,
});

/** Due in the past, never done. */
const missedAction = (over: Partial<PromptnessInput> = {}): PromptnessInput => ({
  kind: 'FOLLOW_UP',
  dueAt: hoursFromNow(-24),
  completedAt: null,
  ...over,
});

/** Due in the future, so not yet measurable either way. */
const futureAction = (over: Partial<PromptnessInput> = {}): PromptnessInput => ({
  kind: 'FOLLOW_UP',
  dueAt: hoursFromNow(48),
  completedAt: null,
  ...over,
});

const score = (acts: PromptnessInput[]) => promptness(acts, NOW, true);

// ---------------------------------------------------------------------------
//  The examples the business gave
// ---------------------------------------------------------------------------

describe('the worked examples from the brief', () => {
  it('1 / 1 = 1.00 → GOOD', () => {
    const p = score([onTimeAction()]);
    expect(p.expected).toBe(1);
    expect(p.onTime).toBe(1);
    expect(p.score).toBeCloseTo(1.0, 5);
    expect(p.rating).toBe('GOOD');
  });

  it('2 / 3 = 0.66 → GOOD', () => {
    const p = score([onTimeAction(), onTimeAction(), missedAction()]);
    expect(p.expected).toBe(3);
    expect(p.onTime).toBe(2);
    expect(p.score).toBeCloseTo(0.6667, 3);
    expect(p.rating).toBe('GOOD');
  });

  it('3 / 4 = 0.75 → GOOD', () => {
    const p = score([onTimeAction(), onTimeAction(), onTimeAction(), missedAction()]);
    expect(p.expected).toBe(4);
    expect(p.onTime).toBe(3);
    expect(p.score).toBeCloseTo(0.75, 5);
    expect(p.rating).toBe('GOOD');
  });

  it('3 / 5 = 0.60 → AVERAGE', () => {
    const p = score([
      onTimeAction(),
      onTimeAction(),
      onTimeAction(),
      missedAction(),
      missedAction(),
    ]);
    expect(p.expected).toBe(5);
    expect(p.onTime).toBe(3);
    expect(p.score).toBeCloseTo(0.6, 5);
    expect(p.rating).toBe('AVERAGE');
  });
});

// ---------------------------------------------------------------------------
//  The denominator rule
// ---------------------------------------------------------------------------

describe('an overdue action nobody completed', () => {
  it('stays in the denominator and fails the numerator', () => {
    /*
      The rule that stops neglect from looking like success. Five expected,
      three done on time, two simply ignored — 0.60, not 1.00.
    */
    const p = score([
      onTimeAction(),
      onTimeAction(),
      onTimeAction(),
      missedAction(),
      missedAction(),
    ]);
    expect(p.expected).toBe(5);
    expect(p.onTime).toBe(3);
    expect(p.score).toBeCloseTo(0.6, 5);
  });

  it('cannot be escaped by ignoring every action', () => {
    const p = score([missedAction(), missedAction(), missedAction()]);
    expect(p.expected).toBe(3);
    expect(p.onTime).toBe(0);
    expect(p.score).toBe(0);
    expect(p.rating).toBe('POOR');
  });
});

describe('an action still in the future', () => {
  it('counts in neither part of the fraction', () => {
    const p = score([onTimeAction(), futureAction(), futureAction()]);
    // One measurable action, done on time. The two to come are not yet missed.
    expect(p.expected).toBe(1);
    expect(p.onTime).toBe(1);
    expect(p.rating).toBe('GOOD');
  });

  it('leaves a lead with only future actions NOT_RATED', () => {
    const p = score([futureAction(), futureAction()]);
    expect(p.expected).toBe(0);
    expect(p.score).toBeNull();
    expect(p.rating).toBe('NOT_RATED');
  });
});

describe('completing early or late', () => {
  it('counts an early completion as on time', () => {
    const p = score([
      { kind: 'FOLLOW_UP', dueAt: hoursFromNow(-24), completedAt: hoursFromNow(-48) },
    ]);
    expect(p.onTime).toBe(1);
  });

  it('counts a completion exactly on the deadline as on time', () => {
    const at = hoursFromNow(-24);
    const p = score([{ kind: 'FOLLOW_UP', dueAt: at, completedAt: at }]);
    expect(p.onTime).toBe(1);
  });

  it('counts a late completion as expected but not on time', () => {
    const p = score([
      { kind: 'FOLLOW_UP', dueAt: hoursFromNow(-48), completedAt: hoursFromNow(-24) },
    ]);
    expect(p.expected).toBe(1);
    expect(p.onTime).toBe(0);
    expect(p.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  NOT_RATED
// ---------------------------------------------------------------------------

describe('NOT_RATED', () => {
  it('is the answer for a lead with no activity at all — never 0/0', () => {
    const p = score([]);
    expect(p.expected).toBe(0);
    expect(p.onTime).toBe(0);
    expect(p.score).toBeNull();
    expect(p.rating).toBe('NOT_RATED');
  });

  it('is never POOR for a fresh lead', () => {
    // The specific confusion this guards: zero expected is not zero scored.
    expect(score([]).rating).not.toBe('POOR');
  });

  it('is the answer when nobody is assigned, however much was done', () => {
    const acts = [onTimeAction(), onTimeAction(), onTimeAction()];
    const unassigned = promptness(acts, NOW, false);

    expect(unassigned.rating).toBe('NOT_RATED');
    expect(unassigned.score).toBeNull();
    // The activity is not discarded — the counts still report what happened, so
    // the rating appears the moment an associate is named.
    expect(unassigned.expected).toBe(3);
    expect(unassigned.onTime).toBe(3);
  });

  it('becomes a real rating once an associate exists', () => {
    const acts = [onTimeAction(), onTimeAction(), onTimeAction()];
    expect(promptness(acts, NOW, true).rating).toBe('GOOD');
  });

  it('reports null rather than zero, so the two are distinguishable', () => {
    // score 0 means "nothing was done on time"; null means "nothing to measure".
    expect(score([]).score).toBeNull();
    expect(score([missedAction()]).score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  Banding
// ---------------------------------------------------------------------------

describe('the thresholds', () => {
  it('treats 0.65 as GOOD — the boundary is inclusive', () => {
    expect(rate(0.65)).toBe('GOOD');
  });

  it('treats 0.50 as AVERAGE — the boundary is inclusive', () => {
    expect(rate(0.5)).toBe('AVERAGE');
  });

  it('places just below each boundary in the band beneath', () => {
    expect(rate(0.6499)).toBe('AVERAGE');
    expect(rate(0.4999)).toBe('POOR');
  });

  it('bands the extremes', () => {
    expect(rate(1)).toBe('GOOD');
    expect(rate(0)).toBe('POOR');
  });
});

// ---------------------------------------------------------------------------
//  Follow-up summary
// ---------------------------------------------------------------------------

describe('the last follow-up', () => {
  it('is the most recently completed one', () => {
    const older = hoursFromNow(-72);
    const newer = hoursFromNow(-24);

    const result = lastFollowUpAt([
      { kind: 'FOLLOW_UP', dueAt: hoursFromNow(-80), completedAt: older },
      { kind: 'FOLLOW_UP', dueAt: hoursFromNow(-30), completedAt: newer },
    ]);

    expect(result?.toISOString()).toBe(newer.toISOString());
  });

  it('ignores FIRST_CONTACT, which is not a follow-up', () => {
    /*
      A lead contacted once and then neglected must not read as followed up.
    */
    const result = lastFollowUpAt([
      { kind: 'FIRST_CONTACT', dueAt: hoursFromNow(-48), completedAt: hoursFromNow(-48) },
    ]);
    expect(result).toBeNull();
  });

  it('ignores RESULT', () => {
    const result = lastFollowUpAt([
      { kind: 'RESULT', dueAt: hoursFromNow(-10), completedAt: hoursFromNow(-10) },
    ]);
    expect(result).toBeNull();
  });

  it('is null when no follow-up has been completed', () => {
    expect(lastFollowUpAt([missedAction(), futureAction()])).toBeNull();
    expect(lastFollowUpAt([])).toBeNull();
  });
});

describe('the next follow-up', () => {
  it('is the earliest incomplete one still to come', () => {
    const soon = hoursFromNow(12);
    const later = hoursFromNow(72);

    const result = nextFollowUpAt(
      [
        { kind: 'FOLLOW_UP', dueAt: later, completedAt: null },
        { kind: 'FOLLOW_UP', dueAt: soon, completedAt: null },
      ],
      NOW,
    );

    expect(result?.toISOString()).toBe(soon.toISOString());
  });

  it('is NOT an overdue incomplete follow-up', () => {
    /*
      The distinction worth stating twice. "Next" means a scheduled future
      action; something already missed is outstanding, not upcoming, and
      returning it here would make a neglected lead look as though it had a plan.
    */
    const result = nextFollowUpAt([missedAction()], NOW);
    expect(result).toBeNull();
  });

  it('still lets that overdue action count toward promptness', () => {
    // Same row, two questions: not "next", but very much "expected".
    const acts = [missedAction()];
    expect(nextFollowUpAt(acts, NOW)).toBeNull();
    expect(promptness(acts, NOW, true).expected).toBe(1);
    expect(promptness(acts, NOW, true).onTime).toBe(0);
  });

  it('skips a future follow-up that is already completed', () => {
    const result = nextFollowUpAt(
      [{ kind: 'FOLLOW_UP', dueAt: hoursFromNow(24), completedAt: hoursFromNow(-1) }],
      NOW,
    );
    expect(result).toBeNull();
  });

  it('ignores FIRST_CONTACT and RESULT', () => {
    const result = nextFollowUpAt(
      [
        { kind: 'FIRST_CONTACT', dueAt: hoursFromNow(6), completedAt: null },
        { kind: 'RESULT', dueAt: hoursFromNow(8), completedAt: null },
      ],
      NOW,
    );
    expect(result).toBeNull();
  });

  it('is null when there is nothing scheduled', () => {
    expect(nextFollowUpAt([], NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

describe('SELF versus OTHER USER', () => {
  it('is SELF when the allocator is the associate', () => {
    expect(allocationKind('u1', 'u1')).toBe('SELF');
  });

  it('is OTHER_USER when somebody else allocated it', () => {
    expect(allocationKind('u1', 'u2')).toBe('OTHER_USER');
  });

  it('is UNASSIGNED when there is no associate', () => {
    expect(allocationKind(null, null)).toBe('UNASSIGNED');
  });

  it('is UNASSIGNED even if an allocator somehow remains', () => {
    // A lead with no owner has no allocation to describe, whatever else is set.
    expect(allocationKind(null, 'u2')).toBe('UNASSIGNED');
  });

  it('is OTHER_USER when an associate exists with no recorded allocator', () => {
    // Not SELF: nobody recorded taking it, so it cannot be claimed as their own.
    expect(allocationKind('u1', null)).toBe('OTHER_USER');
  });
});
