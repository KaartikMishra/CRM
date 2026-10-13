/**
 * HR Phase 5 arithmetic and authorization rules, as unit tests.
 *
 * No server and no database: `performance.calc.ts` and `performance-access.ts` are
 * both pure, which is why they are separate files from the services at all. These
 * are the rules whose failure modes are silent — an attainment that flatters every
 * goal, a separation-of-duties check whose order lets a grant through — so they are
 * tested exhaustively here rather than observed through HTTP.
 *
 * **What these tests cannot prove.** That the module is reachable at all. Phase 4
 * shipped forty-five green unit tests while `hrActor` resolved no HR_TRAINING
 * capability, so every service check returned false for everybody — only an HTTP
 * request surfaced it. The HTTP coverage lives in `performance-review.test.ts`, and
 * neither file substitutes for the other.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_TRANSITIONS,
  averageRating,
  canMoveReview,
  goalAttainment,
  isPerformanceOverdue,
  kpiAttainment,
  nextReviewStatuses,
  outcomeContradictsAttainment,
  ratingDistribution,
  suggestGoalOutcome,
  weightedCompetencyAverage,
} from '../performance.calc.js';
import {
  isReviewSettled,
  mayCancelReview,
  mayCloseGoal,
  mayCompleteDevelopmentAction,
  mayEditGoal,
  mayFinalizeReview,
  mayManageDevelopmentPlan,
  mayRateAsHr,
  mayReadManagerAssessment,
  mayReadSelfAssessment,
  mayRecordProgress,
  mayWriteManagerAssessment,
  mayWriteSelfAssessment,
  performanceScope,
  visibleGoalFilter,
  visibleReviewFilter,
} from '../performance-access.js';
import type { HrActor } from '../hr-access.js';

const d = (n: number | string): Prisma.Decimal => new Prisma.Decimal(n);

/**
 * An actor with a stated capability set.
 *
 * Built from an explicit list rather than from a role, because that is how the real
 * `hrActor` works and because these tests exist partly to prove that role is never
 * a back door: an ADMIN with the grant revoked by override must be refused.
 */
function actor(
  overrides: { employeeId?: string | null; grants?: string[]; role?: 'ADMIN' | 'USER' } = {},
): HrActor {
  const grants = new Set(overrides.grants ?? []);
  return {
    id: 'user-1',
    role: overrides.role ?? 'USER',
    can: (module, action) => grants.has(`${module}:${action}`),
    employeeId: overrides.employeeId === undefined ? 'emp-self' : overrides.employeeId,
  };
}

// ---------------------------------------------------------------------------
//  KPI attainment
// ---------------------------------------------------------------------------

describe('kpiAttainment — nothing recorded is not zero achieved', () => {
  it('returns null when no value has been recorded', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(50),
        baselineValue: null,
        currentValue: null,
      }),
    ).toBeNull();
  });

  it('returns zero — not null — for a recorded value of zero', () => {
    /*
      The distinction this phase turns on. Nothing recorded means unmeasured; a
      recorded zero means measured at nothing, and a screen must be able to tell
      them apart.
    */
    const result = kpiAttainment({
      metricKind: 'NUMBER',
      direction: 'HIGHER_IS_BETTER',
      targetValue: d(50),
      baselineValue: null,
      currentValue: d(0),
    });
    expect(result).not.toBeNull();
    expect(result?.toString()).toBe('0');
  });
});

describe('kpiAttainment — HIGHER_IS_BETTER', () => {
  it('computes a plain proportion with no baseline', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(50),
        baselineValue: null,
        currentValue: d(40),
      })?.toString(),
    ).toBe('80');
  });

  it('measures from the baseline when one is set, not from zero', () => {
    /*
      The case most worth getting right. Conversion asked to move 20% → 30%, now at
      25%: half the work is done. The naive `value / target` says 83%, which
      flatters every goal that started from a high base — and would make a team
      look successful for standing still.
    */
    expect(
      kpiAttainment({
        metricKind: 'PERCENTAGE',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(30),
        baselineValue: d(20),
        currentValue: d(25),
      })?.toString(),
    ).toBe('50');
  });

  it('does not flatter a goal that started near its target', () => {
    // Standing still at the baseline is 0%, not 95%.
    expect(
      kpiAttainment({
        metricKind: 'PERCENTAGE',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(100),
        baselineValue: d(95),
        currentValue: d(95),
      })?.toString(),
    ).toBe('0');
  });

  it('reports over-attainment rather than clamping it', () => {
    // 140% of target is a fact worth keeping.
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(50),
        baselineValue: null,
        currentValue: d(70),
      })?.toString(),
    ).toBe('140');
  });

  it('floors backward movement at zero rather than going negative', () => {
    // Below the baseline attains nothing; it does not attain minus thirty.
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(30),
        baselineValue: d(20),
        currentValue: d(17),
      })?.toString(),
    ).toBe('0');
  });

  it('treats a target equal to the baseline as met by holding the line', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(20),
        baselineValue: d(20),
        currentValue: d(20),
      })?.toString(),
    ).toBe('100');

    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(20),
        baselineValue: d(20),
        currentValue: d(19),
      })?.toString(),
    ).toBe('0');
  });
});

describe('kpiAttainment — LOWER_IS_BETTER', () => {
  it('scores reaching the target as fully met', () => {
    expect(
      kpiAttainment({
        metricKind: 'DURATION',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: d(20),
        currentValue: d(10),
      })?.toString(),
    ).toBe('100');
  });

  it('scores beating the target as fully met, not more than fully', () => {
    /*
      Deliberately asymmetric with HIGHER_IS_BETTER. Driving handling time to zero
      is not 200% of the goal — it is the goal, met. Reporting over-attainment here
      would reward a number that may indicate a different problem entirely.
    */
    expect(
      kpiAttainment({
        metricKind: 'DURATION',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: d(20),
        currentValue: d(4),
      })?.toString(),
    ).toBe('100');
  });

  it('gives credit for the distance closed from the baseline', () => {
    // 20 → 10 asked; now at 15. Half the reduction achieved.
    expect(
      kpiAttainment({
        metricKind: 'DURATION',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: d(20),
        currentValue: d(15),
      })?.toString(),
    ).toBe('50');
  });

  it('floors a worsening figure at zero', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: d(20),
        currentValue: d(26),
      })?.toString(),
    ).toBe('0');
  });

  it('falls back to target-over-value with no baseline', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: null,
        currentValue: d(20),
      })?.toString(),
    ).toBe('50');
  });

  it('treats a baseline already at target as met', () => {
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'LOWER_IS_BETTER',
        targetValue: d(10),
        baselineValue: d(8),
        currentValue: d(12),
      })?.toString(),
    ).toBe('100');
  });
});

describe('kpiAttainment — BOOLEAN and degenerate inputs', () => {
  it('scores a boolean as all or nothing', () => {
    const done = kpiAttainment({
      metricKind: 'BOOLEAN',
      direction: 'HIGHER_IS_BETTER',
      targetValue: d(1),
      baselineValue: null,
      currentValue: d(1),
    });
    const notDone = kpiAttainment({
      metricKind: 'BOOLEAN',
      direction: 'HIGHER_IS_BETTER',
      targetValue: d(1),
      baselineValue: null,
      currentValue: d(0),
    });
    expect(done?.toString()).toBe('100');
    expect(notDone?.toString()).toBe('0');
  });

  it('never reports a proportion of a boolean', () => {
    // A hand-written 0.4 against a binary target yields 0, not 40%.
    expect(
      kpiAttainment({
        metricKind: 'BOOLEAN',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(1),
        baselineValue: null,
        currentValue: d('0.4'),
      })?.toString(),
    ).toBe('0');
  });

  it('returns null for a zero target rather than dividing by it', () => {
    /*
      A CHECK forbids a zero target, so this is unreachable through the API. It is
      tested because the alternative to returning null is an exception that takes
      a whole dashboard request down over one bad row.
    */
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(0),
        baselineValue: null,
        currentValue: d(5),
      }),
    ).toBeNull();
  });

  it('keeps two decimal places and rounds half up', () => {
    // 1 of 3 is 33.333…%, stored as 33.33.
    expect(
      kpiAttainment({
        metricKind: 'NUMBER',
        direction: 'HIGHER_IS_BETTER',
        targetValue: d(3),
        baselineValue: null,
        currentValue: d(1),
      })?.toString(),
    ).toBe('33.33');
  });
});

// ---------------------------------------------------------------------------
//  Goal roll-up
// ---------------------------------------------------------------------------

describe('goalAttainment — unmeasured KPIs are excluded, not zeroed', () => {
  it('renormalises across measured KPIs only', () => {
    /*
      THE decision in this file. One KPI at 100% and three unmeasured reports
      100%, not 25% — because "barely started" is the wrong thing to say about
      work that is on track and unmeasured.
    */
    const result = goalAttainment([
      { weight: d(25), attainment: d(100) },
      { weight: d(25), attainment: null },
      { weight: d(25), attainment: null },
      { weight: d(25), attainment: null },
    ]);
    expect(result?.toString()).toBe('100');
  });

  it('returns null when nothing at all is measured', () => {
    expect(
      goalAttainment([
        { weight: d(50), attainment: null },
        { weight: d(50), attainment: null },
      ]),
    ).toBeNull();
  });

  it('returns null for a goal with no KPIs', () => {
    expect(goalAttainment([])).toBeNull();
  });

  it('weights by each KPI share', () => {
    // 80% at weight 75, 40% at weight 25 → 70%.
    expect(
      goalAttainment([
        { weight: d(75), attainment: d(80) },
        { weight: d(25), attainment: d(40) },
      ])?.toString(),
    ).toBe('70');
  });

  it('lets over-attainment lift a goal above 100 by default', () => {
    expect(
      goalAttainment([
        { weight: d(50), attainment: d(140) },
        { weight: d(50), attainment: d(100) },
      ])?.toString(),
    ).toBe('120');
  });

  it('caps at 100 only when the caller asks', () => {
    expect(
      goalAttainment(
        [
          { weight: d(50), attainment: d(140) },
          { weight: d(50), attainment: d(100) },
        ],
        { capAtHundred: true },
      )?.toString(),
    ).toBe('100');
  });

  it('falls back to an unweighted mean if every weight is zero', () => {
    // Unreachable through the API — a CHECK keeps weights above zero. Here so a
    // hand-edited row yields an answer rather than a division error.
    expect(
      goalAttainment([
        { weight: d(0), attainment: d(60) },
        { weight: d(0), attainment: d(80) },
      ])?.toString(),
    ).toBe('70');
  });
});

describe('suggestGoalOutcome — thresholds come from the cycle, never a constant', () => {
  const standard = { achievement: d(100), partial: d(50) };

  it('suggests ACHIEVED at or above the achievement threshold', () => {
    expect(suggestGoalOutcome(d(100), standard)).toBe('ACHIEVED');
    expect(suggestGoalOutcome(d(130), standard)).toBe('ACHIEVED');
  });

  it('suggests PARTIALLY_MET in the band between', () => {
    expect(suggestGoalOutcome(d(50), standard)).toBe('PARTIALLY_MET');
    expect(suggestGoalOutcome(d(99), standard)).toBe('PARTIALLY_MET');
  });

  it('suggests MISSED below the partial threshold', () => {
    expect(suggestGoalOutcome(d('49.99'), standard)).toBe('MISSED');
    expect(suggestGoalOutcome(d(0), standard)).toBe('MISSED');
  });

  it('honours a stretch cycle that defines achieved as 110%', () => {
    /*
      The reason thresholds are arguments. A cycle configured at 110 judges 100% as
      partially met — which is the whole point of a stretch target, and would be
      impossible if the function compared against DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD.
    */
    const stretch = { achievement: d(110), partial: d(80) };
    expect(suggestGoalOutcome(d(100), stretch)).toBe('PARTIALLY_MET');
    expect(suggestGoalOutcome(d(115), stretch)).toBe('ACHIEVED');
  });

  it('suggests nothing for an unmeasured goal', () => {
    // Unmeasured is not missed. The difference is the manager's to resolve.
    expect(suggestGoalOutcome(null, standard)).toBeNull();
  });
});

describe('outcomeContradictsAttainment', () => {
  const standard = { achievement: d(100), partial: d(50) };

  it('flags a stated outcome that disagrees with the figures', () => {
    const suggested = suggestGoalOutcome(d(20), standard);
    expect(outcomeContradictsAttainment('ACHIEVED', suggested)).toBe(true);
  });

  it('does not flag agreement', () => {
    const suggested = suggestGoalOutcome(d(20), standard);
    expect(outcomeContradictsAttainment('MISSED', suggested)).toBe(false);
  });

  it('never flags CANCELLED', () => {
    /*
      A goal that stopped being relevant is cancelled regardless of how far it had
      got — demanding a justification for that would be demanding one for a change
      in business priorities.
    */
    const suggested = suggestGoalOutcome(d(100), standard);
    expect(outcomeContradictsAttainment('CANCELLED', suggested)).toBe(false);
  });

  it('does not flag anything when nothing is measured', () => {
    expect(outcomeContradictsAttainment('ACHIEVED', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Ratings
// ---------------------------------------------------------------------------

describe('weightedCompetencyAverage', () => {
  it('weights each competency by its share', () => {
    // 5 at weight 75, 1 at weight 25 → 4.
    expect(
      weightedCompetencyAverage([
        { weight: d(75), rating: 5 },
        { weight: d(25), rating: 1 },
      ])?.toString(),
    ).toBe('4');
  });

  it('returns null for an unrated sheet rather than zero', () => {
    /*
      Zero is not on the 1–5 scale. A screen showing "0.00" for an unrated sheet
      reads as the worst possible score rather than as no score — which is a
      materially different thing to show somebody about their own appraisal.
    */
    expect(weightedCompetencyAverage([])).toBeNull();
  });

  it('keeps two decimal places', () => {
    expect(
      weightedCompetencyAverage([
        { weight: d(100), rating: 4 },
        { weight: d(100), rating: 3 },
        { weight: d(100), rating: 3 },
      ])?.toString(),
    ).toBe('3.33');
  });
});

describe('averageRating', () => {
  it('means the finalized ratings', () => {
    expect(averageRating([d(4), d(3), d(5)])?.toString()).toBe('4');
  });

  it('returns null with no history', () => {
    expect(averageRating([])).toBeNull();
  });
});

describe('ratingDistribution', () => {
  it('keeps every bucket, including the empty ones', () => {
    /*
      A distribution missing its empty buckets misrepresents the shape — a chart
      with two bars where there should be five reads as a different story.
    */
    const dist = ratingDistribution([d(4), d(4), d(5)]);
    expect(dist).toHaveLength(5);
    expect(dist.map((b) => b.count)).toEqual([0, 0, 0, 2, 1]);
  });

  it('rounds a fractional rating half up', () => {
    // 3.5 counts as 4. Flooring would push every x.5 down and skew the chart.
    const dist = ratingDistribution([d('3.5')]);
    expect(dist.find((b) => b.rating === 4)?.count).toBe(1);
    expect(dist.find((b) => b.rating === 3)?.count).toBe(0);
  });

  it('clamps anything outside the scale into it', () => {
    const dist = ratingDistribution([d(0), d(9)]);
    expect(dist.find((b) => b.rating === 1)?.count).toBe(1);
    expect(dist.find((b) => b.rating === 5)?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  The review state machine
// ---------------------------------------------------------------------------

describe('review transitions', () => {
  it('walks the full path from created to finalized', () => {
    expect(canMoveReview('NOT_STARTED', 'SELF_ASSESSMENT')).toBe(true);
    expect(canMoveReview('SELF_ASSESSMENT', 'PENDING_MANAGER')).toBe(true);
    expect(canMoveReview('PENDING_MANAGER', 'MANAGER_REVIEW')).toBe(true);
    expect(canMoveReview('MANAGER_REVIEW', 'PENDING_APPROVAL')).toBe(true);
    expect(canMoveReview('PENDING_APPROVAL', 'FINALIZED')).toBe(true);
  });

  it('offers no way out of FINALIZED', () => {
    /*
      The invariant the performance history depends on. Reopening a finalized
      review would change a trend line retroactively, so there is no path back —
      not to PENDING_APPROVAL, not anywhere.
    */
    expect(nextReviewStatuses('FINALIZED')).toEqual([]);
    expect(canMoveReview('FINALIZED', 'PENDING_APPROVAL')).toBe(false);
    expect(canMoveReview('FINALIZED', 'MANAGER_REVIEW')).toBe(false);
    expect(canMoveReview('FINALIZED', 'CANCELLED')).toBe(false);
  });

  it('offers no way out of CANCELLED', () => {
    expect(nextReviewStatuses('CANCELLED')).toEqual([]);
  });

  it('refuses to skip the manager stage into approval', () => {
    expect(canMoveReview('SELF_ASSESSMENT', 'PENDING_APPROVAL')).toBe(false);
    expect(canMoveReview('NOT_STARTED', 'FINALIZED')).toBe(false);
  });

  it('allows HR to move past an absent employee', () => {
    // An employee who has left must not block their manager's half forever.
    expect(canMoveReview('NOT_STARTED', 'PENDING_MANAGER')).toBe(true);
  });

  it('allows cancellation from every live status and no settled one', () => {
    for (const live of [
      'NOT_STARTED',
      'SELF_ASSESSMENT',
      'PENDING_MANAGER',
      'MANAGER_REVIEW',
      'PENDING_APPROVAL',
    ]) {
      expect(canMoveReview(live, 'CANCELLED'), live).toBe(true);
    }
    expect(canMoveReview('FINALIZED', 'CANCELLED')).toBe(false);
  });

  it('names a transition list for every status in the enum', () => {
    // A status with no entry would silently permit nothing, which looks identical
    // to a settled one — so the map must cover every member explicitly.
    for (const status of [
      'NOT_STARTED',
      'SELF_ASSESSMENT',
      'PENDING_MANAGER',
      'MANAGER_REVIEW',
      'PENDING_APPROVAL',
      'FINALIZED',
      'CANCELLED',
    ]) {
      expect(REVIEW_TRANSITIONS[status], status).toBeDefined();
    }
  });
});

describe('isReviewSettled', () => {
  it('counts FINALIZED and CANCELLED, and nothing else', () => {
    expect(isReviewSettled('FINALIZED')).toBe(true);
    expect(isReviewSettled('CANCELLED')).toBe(true);
    expect(isReviewSettled('PENDING_APPROVAL')).toBe(false);
    expect(isReviewSettled('NOT_STARTED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Overdue
// ---------------------------------------------------------------------------

describe('isPerformanceOverdue', () => {
  it('flags an unsubmitted obligation past its date', () => {
    expect(isPerformanceOverdue(new Date('2026-10-01'), '2026-10-12', null)).toBe(true);
  });

  it('does not flag one due today or later', () => {
    expect(isPerformanceOverdue(new Date('2026-10-12'), '2026-10-12', null)).toBe(false);
    expect(isPerformanceOverdue(new Date('2026-10-20'), '2026-10-12', null)).toBe(false);
  });

  it('never flags work that was submitted', () => {
    // Even late. The obligation was met; telling somebody off afterwards for work
    // they did is the wrong message.
    expect(
      isPerformanceOverdue(new Date('2026-10-01'), '2026-10-12', new Date('2026-10-05')),
    ).toBe(false);
  });

  it('is not overdue when nothing is due', () => {
    expect(isPerformanceOverdue(null, '2026-10-12', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

describe('performanceScope', () => {
  it('gives the whole company to somebody holding VIEW', () => {
    const scope = performanceScope(actor({ grants: ['HR_PERFORMANCE:VIEW'] }), {
      hasReports: false,
    });
    expect(scope.kind).toBe('all');
  });

  it('gives a manager themselves plus their reports', () => {
    const scope = performanceScope(actor({ employeeId: 'emp-mgr' }), { hasReports: true });
    expect(scope).toEqual({ kind: 'reports', employeeId: 'emp-mgr' });
  });

  it('gives an ordinary employee only themselves', () => {
    const scope = performanceScope(actor({ employeeId: 'emp-a' }), { hasReports: false });
    expect(scope).toEqual({ kind: 'selfOnly', employeeId: 'emp-a' });
  });

  it('gives nothing to an account with no grant and no employee record', () => {
    const scope = performanceScope(actor({ employeeId: null }), { hasReports: false });
    expect(scope.kind).toBe('none');
  });

  it('reads the permission and never the role', () => {
    /*
      An ADMIN whose HR_PERFORMANCE grant was revoked by a per-user override must
      actually be revoked. Deciding on `role` would make the override decorative —
      the mistake every access file in this codebase is written to avoid.
    */
    const revokedAdmin = actor({ role: 'ADMIN', grants: [], employeeId: 'emp-a' });
    expect(performanceScope(revokedAdmin, { hasReports: false }).kind).toBe('selfOnly');
  });
});

describe('visibleReviewFilter', () => {
  it('is unrestricted for the whole-company scope', () => {
    expect(visibleReviewFilter({ kind: 'all' })).toEqual({});
  });

  it('matches nothing — not everything — for the none scope', () => {
    /*
      The mistake this guards against: `{}` is Prisma for "match everything", so a
      none scope returning an empty object would hand the entire company's
      appraisals to somebody entitled to none of them.
    */
    const filter = visibleReviewFilter({ kind: 'none' });
    expect(filter).not.toEqual({});
    expect(JSON.stringify(filter)).toContain('__no_employee_matches_this__');
  });

  it('includes reviews a manager is the named reviewer of', () => {
    /*
      A manager who changed teams mid-cycle still owes the reviews they were
      assigned. A filter on the hierarchy alone would hide work they are
      accountable for.
    */
    const filter = visibleReviewFilter({ kind: 'reports', employeeId: 'emp-mgr' });
    expect(JSON.stringify(filter)).toContain('reviewerId');
  });

  it('restricts an employee to their own review', () => {
    expect(visibleReviewFilter({ kind: 'selfOnly', employeeId: 'emp-a' })).toEqual({
      employeeId: 'emp-a',
    });
  });
});

describe('visibleGoalFilter', () => {
  it('lets an employee see their department’s goals as well as their own', () => {
    /*
      Not the same filter as reviews. An employee who could not see what their unit
      is working towards could not align their own goals to it, which is the entire
      point of having department goals.
    */
    const filter = visibleGoalFilter({ kind: 'selfOnly', employeeId: 'emp-a' });
    const json = JSON.stringify(filter);
    expect(json).toContain('employeeId');
    expect(json).toContain('department');
  });

  it('matches nothing for the none scope', () => {
    const filter = visibleGoalFilter({ kind: 'none' });
    expect(filter).not.toEqual({});
    expect(JSON.stringify(filter)).toContain('__no_employee_matches_this__');
  });
});

// ---------------------------------------------------------------------------
//  Separation of duties — the rules this phase exists to enforce
// ---------------------------------------------------------------------------

const liveReview = {
  status: 'MANAGER_REVIEW' as const,
  employeeId: 'emp-subject',
  reviewerId: 'emp-mgr',
  selfSubmittedAt: new Date('2026-10-01'),
  managerSubmittedAt: null,
};

describe('RULE 2 — nobody writes their own manager review', () => {
  it('refuses the subject even holding HR_PERFORMANCE:EDIT', () => {
    /*
      An HR colleague being appraised is an ordinary situation, and they hold EDIT.
      The subject check runs FIRST for exactly this case — ordering the checks the
      other way round would let them write their own manager review.
    */
    const hrBeingAppraised = actor({
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:EDIT', 'HR_PERFORMANCE:APPROVE'],
    });
    expect(mayWriteManagerAssessment(hrBeingAppraised, liveReview)).toBe(false);
  });

  it('refuses the subject even as an ADMIN', () => {
    const adminSubject = actor({
      role: 'ADMIN',
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:EDIT'],
    });
    expect(mayWriteManagerAssessment(adminSubject, liveReview)).toBe(false);
  });

  it('allows the named reviewer with no performance grant at all', () => {
    // A manager holds no HR_PERFORMANCE permission. Being the reviewer is a fact
    // about rows, which is why it cannot live in the route table.
    const manager = actor({ employeeId: 'emp-mgr', grants: [] });
    expect(mayWriteManagerAssessment(manager, liveReview)).toBe(true);
  });

  it('allows HR to write it for an employee whose manager has left', () => {
    const hr = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:EDIT'] });
    expect(
      mayWriteManagerAssessment(hr, { ...liveReview, reviewerId: null }),
    ).toBe(true);
  });

  it('refuses an unrelated colleague', () => {
    const stranger = actor({ employeeId: 'emp-other', grants: [] });
    expect(mayWriteManagerAssessment(stranger, liveReview)).toBe(false);
  });

  it('refuses once the manager review is submitted', () => {
    // It has been shared with the employee; editing afterwards changes what they
    // were shown.
    const manager = actor({ employeeId: 'emp-mgr' });
    expect(
      mayWriteManagerAssessment(manager, {
        ...liveReview,
        managerSubmittedAt: new Date('2026-10-05'),
      }),
    ).toBe(false);
  });

  it('refuses on a finalized review, for everybody', () => {
    for (const who of [
      actor({ employeeId: 'emp-mgr' }),
      actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:EDIT'] }),
      actor({ role: 'ADMIN', employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] }),
    ]) {
      expect(
        mayWriteManagerAssessment(who, { ...liveReview, status: 'FINALIZED' }),
      ).toBe(false);
    }
  });
});

describe('self-assessment is the subject’s alone', () => {
  const review = {
    status: 'SELF_ASSESSMENT' as const,
    employeeId: 'emp-subject',
    selfSubmittedAt: null,
  };

  it('allows the subject with no grant', () => {
    expect(mayWriteSelfAssessment(actor({ employeeId: 'emp-subject' }), review)).toBe(true);
  });

  it('refuses their manager', () => {
    // An assessment written by somebody else is not a self-assessment, and there
    // is no business case for one.
    expect(mayWriteSelfAssessment(actor({ employeeId: 'emp-mgr' }), review)).toBe(false);
  });

  it('refuses HR and an administrator holding every grant', () => {
    const hr = actor({
      role: 'ADMIN',
      employeeId: 'emp-hr',
      grants: ['HR_PERFORMANCE:EDIT', 'HR_PERFORMANCE:APPROVE', 'HR_PERFORMANCE:VIEW'],
    });
    expect(mayWriteSelfAssessment(hr, review)).toBe(false);
  });

  it('refuses once submitted', () => {
    expect(
      mayWriteSelfAssessment(actor({ employeeId: 'emp-subject' }), {
        ...review,
        selfSubmittedAt: new Date('2026-10-02'),
      }),
    ).toBe(false);
  });

  it('refuses on a settled review', () => {
    expect(
      mayWriteSelfAssessment(actor({ employeeId: 'emp-subject' }), {
        ...review,
        status: 'FINALIZED',
      }),
    ).toBe(false);
  });
});

describe('RULE 1 — an employee does not read a draft manager review', () => {
  it('hides it from the subject while unsubmitted', () => {
    /*
      The Phase 5 equivalent of the answer key. A manager's draft is a private
      working document; showing it early means an employee reading half-formed
      criticism, after which managers stop drafting honestly.
    */
    expect(
      mayReadManagerAssessment(actor({ employeeId: 'emp-subject' }), {
        employeeId: 'emp-subject',
        managerSubmittedAt: null,
      }),
    ).toBe(false);
  });

  it('shows it to the subject once submitted', () => {
    expect(
      mayReadManagerAssessment(actor({ employeeId: 'emp-subject' }), {
        employeeId: 'emp-subject',
        managerSubmittedAt: new Date('2026-10-05'),
      }),
    ).toBe(true);
  });

  it('shows it to the manager and HR at any time', () => {
    // They are the people writing it.
    for (const who of [
      actor({ employeeId: 'emp-mgr' }),
      actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:VIEW'] }),
    ]) {
      expect(
        mayReadManagerAssessment(who, {
          employeeId: 'emp-subject',
          managerSubmittedAt: null,
        }),
      ).toBe(true);
    }
  });
});

describe('a draft self-assessment is not read by others either', () => {
  it('hides it from the manager while unsubmitted', () => {
    expect(
      mayReadSelfAssessment(actor({ employeeId: 'emp-mgr' }), {
        employeeId: 'emp-subject',
        selfSubmittedAt: null,
      }),
    ).toBe(false);
  });

  it('always shows it to its author', () => {
    expect(
      mayReadSelfAssessment(actor({ employeeId: 'emp-subject' }), {
        employeeId: 'emp-subject',
        selfSubmittedAt: null,
      }),
    ).toBe(true);
  });
});

describe('RULE 3 — nobody finalises their own review', () => {
  const awaiting = { status: 'PENDING_APPROVAL' as const, employeeId: 'emp-subject' };

  it('refuses the subject holding APPROVE', () => {
    /*
      The check that matters most in the phase. An HR colleague being appraised
      holds APPROVE; checking the grant first would let them lock their own rating
      and end their own right to respond to it.
    */
    const hrSubject = actor({
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:APPROVE'],
    });
    expect(mayFinalizeReview(hrSubject, awaiting)).toBe(false);
  });

  it('refuses the subject as an ADMIN holding everything', () => {
    const adminSubject = actor({
      role: 'ADMIN',
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:APPROVE', 'HR_PERFORMANCE:EDIT', 'HR_PERFORMANCE:VIEW'],
    });
    expect(mayFinalizeReview(adminSubject, awaiting)).toBe(false);
  });

  it('refuses the manager who wrote it when they hold only EDIT', () => {
    /*
      The second pair of eyes the requirement asks for. A manager trusted to
      appraise their team is not thereby trusted to close the appraisal, and
      collapsing EDIT and APPROVE into one grant would remove that.
    */
    const manager = actor({ employeeId: 'emp-mgr', grants: ['HR_PERFORMANCE:EDIT'] });
    expect(mayFinalizeReview(manager, awaiting)).toBe(false);
  });

  it('allows an approver who is not the subject', () => {
    const approver = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] });
    expect(mayFinalizeReview(approver, awaiting)).toBe(true);
  });

  it('allows an approver with no employee record at all', () => {
    // An HR administrator may hold no Employee row. They are not the subject of
    // anything, so there is nothing to protect against.
    const approver = actor({ employeeId: null, grants: ['HR_PERFORMANCE:APPROVE'] });
    expect(mayFinalizeReview(approver, awaiting)).toBe(true);
  });

  it('refuses a review that is not actually awaiting approval', () => {
    const approver = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] });
    for (const status of ['NOT_STARTED', 'SELF_ASSESSMENT', 'MANAGER_REVIEW'] as const) {
      expect(mayFinalizeReview(approver, { ...awaiting, status }), status).toBe(false);
    }
  });

  it('refuses re-finalising an already finalized review', () => {
    const approver = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] });
    expect(mayFinalizeReview(approver, { ...awaiting, status: 'FINALIZED' })).toBe(false);
  });
});

describe('cancellation', () => {
  it('refuses the subject, whatever they hold', () => {
    // Cancelling your own appraisal to avoid an unflattering one is the obvious
    // abuse.
    const subject = actor({
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:APPROVE'],
    });
    expect(
      mayCancelReview(subject, { status: 'MANAGER_REVIEW', employeeId: 'emp-subject' }),
    ).toBe(false);
  });

  it('refuses a finalized review', () => {
    const approver = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] });
    expect(
      mayCancelReview(approver, { status: 'FINALIZED', employeeId: 'emp-subject' }),
    ).toBe(false);
  });

  it('allows an approver on a live review', () => {
    const approver = actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] });
    expect(
      mayCancelReview(approver, { status: 'MANAGER_REVIEW', employeeId: 'emp-subject' }),
    ).toBe(true);
  });
});

describe('HR competency ratings', () => {
  it('refuses the subject', () => {
    const subject = actor({ employeeId: 'emp-subject', grants: ['HR_PERFORMANCE:EDIT'] });
    expect(
      mayRateAsHr(subject, { status: 'MANAGER_REVIEW', employeeId: 'emp-subject' }),
    ).toBe(false);
  });

  it('refuses a manager holding no EDIT', () => {
    expect(
      mayRateAsHr(actor({ employeeId: 'emp-mgr' }), {
        status: 'MANAGER_REVIEW',
        employeeId: 'emp-subject',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Goals — authorization
// ---------------------------------------------------------------------------

const activeGoal = {
  status: 'ACTIVE',
  employeeId: 'emp-subject',
  ownerManagerId: 'emp-mgr',
};

describe('goal editing', () => {
  it('refuses the owner editing their own target', () => {
    /*
      A goal somebody can rewrite is not a target. The whole value of agreeing one
      is that neither side changes it unilaterally.
    */
    expect(mayEditGoal(actor({ employeeId: 'emp-subject' }), activeGoal)).toBe(false);
  });

  it('allows the owner’s manager', () => {
    expect(mayEditGoal(actor({ employeeId: 'emp-mgr' }), activeGoal)).toBe(true);
  });

  it('allows HR holding EDIT', () => {
    expect(
      mayEditGoal(actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:EDIT'] }), activeGoal),
    ).toBe(true);
  });

  it('refuses every settled goal, for everybody', () => {
    for (const status of ['ACHIEVED', 'PARTIALLY_MET', 'MISSED', 'CANCELLED']) {
      expect(
        mayEditGoal(
          actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:EDIT'] }),
          { ...activeGoal, status },
        ),
        status,
      ).toBe(false);
    }
  });
});

describe('recording progress is wider than editing', () => {
  it('allows the owner to record their own figures', () => {
    /*
      They are the one who knows the number. Making them ask their manager to type
      it would mean the figures are always stale — and they still cannot change the
      target, which is the part that matters.
    */
    expect(mayRecordProgress(actor({ employeeId: 'emp-subject' }), activeGoal)).toBe(true);
  });

  it('allows their manager', () => {
    expect(mayRecordProgress(actor({ employeeId: 'emp-mgr' }), activeGoal)).toBe(true);
  });

  it('refuses an unrelated colleague', () => {
    expect(mayRecordProgress(actor({ employeeId: 'emp-other' }), activeGoal)).toBe(false);
  });

  it('refuses progress on a goal that is not ACTIVE', () => {
    // A DRAFT goal has not been agreed; a settled one is already judged, and a
    // number arriving afterwards would disagree with the recorded outcome.
    for (const status of ['DRAFT', 'ACHIEVED', 'MISSED', 'CANCELLED']) {
      expect(
        mayRecordProgress(actor({ employeeId: 'emp-subject' }), { ...activeGoal, status }),
        status,
      ).toBe(false);
    }
  });
});

describe('closing a goal', () => {
  it('refuses the owner declaring their own target achieved', () => {
    const owner = actor({
      employeeId: 'emp-subject',
      grants: ['HR_PERFORMANCE:APPROVE'],
    });
    expect(mayCloseGoal(owner, activeGoal)).toBe(false);
  });

  it('allows the manager', () => {
    expect(mayCloseGoal(actor({ employeeId: 'emp-mgr' }), activeGoal)).toBe(true);
  });

  it('allows an approver who is not the owner', () => {
    expect(
      mayCloseGoal(
        actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] }),
        activeGoal,
      ),
    ).toBe(true);
  });

  it('allows closing a department goal by its approver', () => {
    // A department goal has no employee owner, so there is no subject to exclude.
    expect(
      mayCloseGoal(actor({ employeeId: 'emp-hr', grants: ['HR_PERFORMANCE:APPROVE'] }), {
        status: 'ACTIVE',
        employeeId: null,
        ownerManagerId: null,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

const openPlan = {
  employeeId: 'emp-subject',
  subjectManagerId: 'emp-mgr',
  status: 'OPEN',
};

describe('development plans', () => {
  it('refuses the subject authoring a plan about themselves', () => {
    /*
      Not because self-development is suspect: an improvement plan is a document
      the business is accountable for, and one the subject authored would be
      neither a commitment by the business nor a record of one.
    */
    expect(
      mayManageDevelopmentPlan(
        actor({ employeeId: 'emp-subject', grants: ['HR_PERFORMANCE:EDIT'] }),
        openPlan,
      ),
    ).toBe(false);
  });

  it('allows their manager', () => {
    expect(mayManageDevelopmentPlan(actor({ employeeId: 'emp-mgr' }), openPlan)).toBe(true);
  });

  it('refuses a closed plan', () => {
    expect(
      mayManageDevelopmentPlan(actor({ employeeId: 'emp-mgr' }), {
        ...openPlan,
        status: 'COMPLETED',
      }),
    ).toBe(false);
  });

  it('lets the subject tick off their own actions', () => {
    /*
      Doing the things a plan asks for is their work. Requiring a manager to record
      each one would make the plan a tracking burden rather than a support — and
      they still cannot add, remove or reword actions.
    */
    expect(
      mayCompleteDevelopmentAction(actor({ employeeId: 'emp-subject' }), openPlan),
    ).toBe(true);
  });

  it('refuses an unrelated colleague ticking actions off', () => {
    expect(
      mayCompleteDevelopmentAction(actor({ employeeId: 'emp-other' }), openPlan),
    ).toBe(false);
  });
});
