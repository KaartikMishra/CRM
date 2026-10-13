/**
 * Performance arithmetic, as pure functions.
 *
 * No database access, no Prisma types beyond Decimal, no request context. Every
 * figure that feeds an appraisal — KPI attainment, goal roll-up, weighted
 * competency averages, the suggested goal outcome — lives here, where it can be
 * tested exhaustively without a server. Following `attendance.calc.ts`,
 * `leave.calc.ts` and `training.calc.ts`.
 *
 * ### Everything is Decimal, never float
 *
 * `Prisma.Decimal` throughout. An attainment of 99.995 must not round into "target
 * met", and `0.1 + 0.2 !== 0.3` is exactly the arithmetic not to do when the answer
 * feeds a pay conversation. The columns are NUMERIC for the same reason.
 *
 * ### Thresholds are never constants
 *
 * `DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD` and `DEFAULT_GOAL_PARTIAL_THRESHOLD` appear
 * nowhere in this file. `suggestGoalOutcome` takes the thresholds as arguments and
 * the service reads them off the cycle — so a cycle that defines "achieved" as 110%
 * is judged at 110. Comparing against a constant would make every cycle's
 * configuration decorative, which is the mistake Phase 4 was careful to avoid.
 *
 * ### Attainment is uncapped above
 *
 * Somebody who reached 140% of target did so, and clamping it to 100 would erase
 * exactly the information an appraisal exists to surface. The *goal* roll-up is
 * where a business decision about over-attainment belongs, and `goalAttainment`
 * takes a flag for it rather than deciding silently.
 */

import { Prisma } from '@prisma/client';
import type { GoalStatus, KpiDirection, KpiMetricKind } from '@rs/shared';

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/** Two decimal places, matching the NUMERIC columns. Half-up, like money. */
function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// ---------------------------------------------------------------------------
//  KPI attainment
// ---------------------------------------------------------------------------

/**
 * How far a KPI has got towards its target, as a percentage.
 *
 * ### The four cases, and why each is what it is
 *
 * **BOOLEAN.** Done is 100, not done is 0. No proportion: a half-completed
 * yes/no is not a thing, and dividing 0.4 by a target of 1 would report 40% of a
 * binary.
 *
 * **HIGHER_IS_BETTER with a baseline.** Progress is measured from where it started:
 * `(value - baseline) / (target - baseline)`. A team asked to lift conversion from
 * 20% to 30% who reached 25% has done half the work, not 83% of it — and the naive
 * `value / target` says 83%, which flatters every goal that started from a high
 * base. This is the case most worth getting right.
 *
 * **HIGHER_IS_BETTER without a baseline.** `value / target`. The honest reading
 * when nobody recorded a starting point.
 *
 * **LOWER_IS_BETTER.** Reaching or beating the target is 100%. Above it, credit is
 * given for the distance closed from the baseline: `(baseline - value) / (baseline
 * - target)`. Without a baseline there is nothing to measure the reduction against,
 * so the fallback is `target / value` — which reaches 100% exactly at target and
 * degrades sensibly above it.
 *
 * Returns null when the inputs cannot produce a meaningful answer rather than
 * guessing, because a fabricated attainment is worse than an absent one on a screen
 * somebody makes decisions from.
 */
export function kpiAttainment(input: {
  metricKind: KpiMetricKind;
  direction: KpiDirection;
  targetValue: Prisma.Decimal;
  baselineValue: Prisma.Decimal | null;
  currentValue: Prisma.Decimal | null;
}): Prisma.Decimal | null {
  const { metricKind, direction, targetValue, baselineValue, currentValue } = input;

  // Nothing recorded is not zero achieved. The caller must show these differently.
  if (currentValue === null) return null;

  if (metricKind === 'BOOLEAN') {
    return currentValue.gte(1) ? HUNDRED : ZERO;
  }

  // A zero target has no proportion — a CHECK forbids it, and this is the belt to
  // that braces: a row that somehow holds one yields null rather than a division
  // error that takes a request down.
  if (targetValue.isZero()) return null;

  if (direction === 'HIGHER_IS_BETTER') {
    if (baselineValue !== null) {
      const span = targetValue.minus(baselineValue);
      /*
        A target equal to the baseline asks for no movement, so there is no
        proportion to compute. Reaching the baseline counts as met; falling below
        it does not. Guarded rather than divided, because `span` is zero here.
      */
      if (span.isZero()) return currentValue.gte(baselineValue) ? HUNDRED : ZERO;

      const progressed = currentValue.minus(baselineValue);
      const ratio = progressed.dividedBy(span).times(HUNDRED);
      // Moving the wrong way attains zero, not a negative: a KPI cannot be worse
      // than unstarted for the purpose of a percentage.
      return round2(ratio.lessThan(ZERO) ? ZERO : ratio);
    }

    const ratio = currentValue.dividedBy(targetValue).times(HUNDRED);
    return round2(ratio.lessThan(ZERO) ? ZERO : ratio);
  }

  // LOWER_IS_BETTER.
  if (currentValue.lte(targetValue)) return HUNDRED;

  if (baselineValue !== null) {
    const span = baselineValue.minus(targetValue);
    // A baseline at or below target means the goal was already met when set.
    if (span.lte(ZERO)) return HUNDRED;

    const reduced = baselineValue.minus(currentValue);
    const ratio = reduced.dividedBy(span).times(HUNDRED);
    return round2(ratio.lessThan(ZERO) ? ZERO : ratio);
  }

  // No baseline: target over value. Reaches 100 at target, falls away above it.
  if (currentValue.isZero()) return HUNDRED;
  return round2(targetValue.dividedBy(currentValue).times(HUNDRED));
}

// ---------------------------------------------------------------------------
//  Goal roll-up
// ---------------------------------------------------------------------------

/**
 * A goal's attainment, weighted across its KPIs.
 *
 * ### KPIs with nothing recorded are excluded, not counted as zero
 *
 * This is the decision that matters most here. A goal with four KPIs where one has
 * been measured at 100% would report 25% if the unmeasured three counted as zero —
 * which says "barely started" about work that is on track and unmeasured. So the
 * weights are renormalised across the KPIs that actually have a value, and a goal
 * with none at all returns null.
 *
 * ### `capAtHundred` is a parameter, not a decision taken here
 *
 * Whether a KPI at 140% should pull a goal above 100 is a business question with
 * two defensible answers. The caller passes the cycle's preference; this function
 * does not invent one.
 */
export function goalAttainment(
  kpis: { weight: Prisma.Decimal; attainment: Prisma.Decimal | null }[],
  options: { capAtHundred?: boolean } = {},
): Prisma.Decimal | null {
  const measured = kpis.filter(
    (k): k is { weight: Prisma.Decimal; attainment: Prisma.Decimal } =>
      k.attainment !== null,
  );

  if (measured.length === 0) return null;

  const totalWeight = measured.reduce((sum, k) => sum.plus(k.weight), ZERO);

  /*
    Weights that sum to zero cannot renormalise. A CHECK keeps each weight above
    zero so this is unreachable through the API — it is here so a hand-edited row
    yields an unweighted mean rather than a division error.
  */
  if (totalWeight.isZero()) {
    const sum = measured.reduce((acc, k) => acc.plus(k.attainment), ZERO);
    const mean = sum.dividedBy(new Prisma.Decimal(measured.length));
    return round2(options.capAtHundred === true && mean.greaterThan(HUNDRED) ? HUNDRED : mean);
  }

  const weighted = measured.reduce(
    (acc, k) => acc.plus(k.attainment.times(k.weight)),
    ZERO,
  );
  const result = weighted.dividedBy(totalWeight);

  return round2(
    options.capAtHundred === true && result.greaterThan(HUNDRED) ? HUNDRED : result,
  );
}

/**
 * The same roll-up one level up: a review's attainment across its goals.
 *
 * Identical arithmetic and identical exclusion rule, kept as its own function
 * rather than reusing `goalAttainment` with a cast — the two operate on different
 * things, and a shared helper would make a future divergence (goals weighted by
 * cycle, say) a change in two callers' behaviour at once.
 */
export function reviewGoalAttainment(
  goals: { weight: Prisma.Decimal; attainment: Prisma.Decimal | null }[],
  options: { capAtHundred?: boolean } = {},
): Prisma.Decimal | null {
  return goalAttainment(goals, options);
}

/**
 * Which outcome the recorded attainment suggests.
 *
 * ### A suggestion, not a decision
 *
 * The service offers this and the closing manager states the outcome. That split is
 * deliberate: a target missed because the market moved is a different thing from
 * one missed through inattention, and a system that auto-graded it would be wrong
 * in exactly the cases a human appraisal exists to handle. The arithmetic is the
 * server's and the judgement is theirs, and both are recorded — the service
 * requires a note when the two disagree.
 *
 * Thresholds are arguments. Nothing here reads a constant.
 */
export function suggestGoalOutcome(
  attainment: Prisma.Decimal | null,
  thresholds: { achievement: Prisma.Decimal; partial: Prisma.Decimal },
): Extract<GoalStatus, 'ACHIEVED' | 'PARTIALLY_MET' | 'MISSED'> | null {
  // Nothing recorded suggests nothing. A goal with no measurements is not "missed";
  // it is unmeasured, and the difference is the manager's to resolve.
  if (attainment === null) return null;

  if (attainment.gte(thresholds.achievement)) return 'ACHIEVED';
  if (attainment.gte(thresholds.partial)) return 'PARTIALLY_MET';
  return 'MISSED';
}

/** Whether a stated outcome disagrees with what the figures suggest. */
export function outcomeContradictsAttainment(
  stated: GoalStatus,
  suggested: ReturnType<typeof suggestGoalOutcome>,
): boolean {
  // CANCELLED is never a contradiction: a goal that stopped being relevant is
  // cancelled regardless of how far it had got.
  if (stated === 'CANCELLED') return false;
  if (suggested === null) return false;

  return stated !== suggested;
}

// ---------------------------------------------------------------------------
//  Competency and overall ratings
// ---------------------------------------------------------------------------

/**
 * The weighted mean of a set of competency ratings, on the 1–5 scale.
 *
 * Used to suggest an overall rating from a completed sheet. A suggestion again:
 * both assessment forms accept an overall figure, and a reviewer who rates every
 * competency 3 but judges the year a 4 overall is saying something the arithmetic
 * cannot — perhaps the competencies missed what mattered.
 *
 * Returns null for an empty set rather than zero. Zero is not on the scale, and a
 * screen showing "0.00" for an unrated sheet would read as the worst possible
 * score rather than as no score.
 */
export function weightedCompetencyAverage(
  ratings: { weight: Prisma.Decimal; rating: number }[],
): Prisma.Decimal | null {
  if (ratings.length === 0) return null;

  const totalWeight = ratings.reduce((sum, r) => sum.plus(r.weight), ZERO);

  if (totalWeight.isZero()) {
    const sum = ratings.reduce((acc, r) => acc.plus(new Prisma.Decimal(r.rating)), ZERO);
    return round2(sum.dividedBy(new Prisma.Decimal(ratings.length)));
  }

  const weighted = ratings.reduce(
    (acc, r) => acc.plus(new Prisma.Decimal(r.rating).times(r.weight)),
    ZERO,
  );
  return round2(weighted.dividedBy(totalWeight));
}

/**
 * The mean of a set of final ratings, for a history or a cycle report.
 *
 * Plain mean, unweighted: each finalized review counts once. Weighting an average
 * of appraisals by anything would need a stated rule nobody has asked for.
 */
export function averageRating(ratings: Prisma.Decimal[]): Prisma.Decimal | null {
  if (ratings.length === 0) return null;

  const sum = ratings.reduce((acc, r) => acc.plus(r), ZERO);
  return round2(sum.dividedBy(new Prisma.Decimal(ratings.length)));
}

/**
 * Finalized ratings bucketed 1–5 for a distribution.
 *
 * Every bucket is present even at zero, so a chart has five bars rather than
 * however many happened to occur — a distribution missing its empty buckets
 * misrepresents the shape.
 *
 * A fractional rating buckets by rounding half-up: 3.5 counts as 4. Stated here
 * because the alternative (floor) would put every x.5 in the lower bucket and
 * skew the whole chart downwards.
 */
export function ratingDistribution(
  ratings: Prisma.Decimal[],
): { rating: number; count: number }[] {
  const buckets = new Map<number, number>([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
  ]);

  for (const rating of ratings) {
    const bucket = Number(rating.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP));
    const clamped = bucket < 1 ? 1 : bucket > 5 ? 5 : bucket;
    buckets.set(clamped, (buckets.get(clamped) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .map(([rating, count]) => ({ rating, count }))
    .sort((a, b) => a.rating - b.rating);
}

// ---------------------------------------------------------------------------
//  Review state machine
// ---------------------------------------------------------------------------

/**
 * Which statuses a review may move to from where it is.
 *
 * Written out in full rather than derived from the enum's order, for the same
 * reason Phase 3's ATS transition map is: "forward" is not a property of an array
 * index, and a reader needs to see which moves exist without simulating the code.
 *
 * Note what is absent. There is no path back from FINALIZED — not to
 * PENDING_APPROVAL, not anywhere. A finalized review is the record of a
 * conversation that happened; the performance history is built from it, and
 * reopening one would change a trend line retroactively. A review finalized in
 * error is a matter for a correction note on the next cycle, not a quiet rewrite.
 */
export const REVIEW_TRANSITIONS: Record<string, readonly string[]> = {
  NOT_STARTED: ['SELF_ASSESSMENT', 'PENDING_MANAGER', 'CANCELLED'],
  // PENDING_MANAGER directly from NOT_STARTED covers the employee who has left or
  // is unavailable: HR moves it on so the manager's half is not blocked forever.
  SELF_ASSESSMENT: ['PENDING_MANAGER', 'CANCELLED'],
  PENDING_MANAGER: ['MANAGER_REVIEW', 'CANCELLED'],
  MANAGER_REVIEW: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['FINALIZED', 'CANCELLED'],
  FINALIZED: [],
  CANCELLED: [],
};

/** Whether a review may move from one status to another. */
export function canMoveReview(from: string, to: string): boolean {
  return (REVIEW_TRANSITIONS[from] ?? []).includes(to);
}

/** Where a review may go next. Empty for a settled one. */
export function nextReviewStatuses(from: string): readonly string[] {
  return REVIEW_TRANSITIONS[from] ?? [];
}

// ---------------------------------------------------------------------------
//  Overdue
// ---------------------------------------------------------------------------

/**
 * Whether a dated obligation is overdue, against a day the caller supplies.
 *
 * The reference day is a parameter rather than read from the clock inside — which
 * makes it testable, and lets the caller pass the *company-time* day so a colleague
 * abroad is not told their self-assessment is late a day early.
 *
 * Already-submitted work is never overdue, whatever the date says: the obligation
 * was met, and flagging it afterwards would be telling somebody off for work they
 * did.
 */
export function isPerformanceOverdue(
  dueOn: Date | null,
  todayKey: string,
  submittedAt: Date | string | null,
): boolean {
  if (dueOn === null) return false;
  if (submittedAt !== null) return false;

  return dueOn.toISOString().slice(0, 10) < todayKey;
}
