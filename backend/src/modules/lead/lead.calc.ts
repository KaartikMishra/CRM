/**
 * The arithmetic of the Lead/Deal module, kept apart from the database.
 *
 * Promptness is the number this module exists to get right, and it is easy to
 * get subtly wrong in three different ways — so it lives here, where it can be
 * reasoned about and tested without a Neon round trip, and where there is
 * exactly one definition of it.
 *
 * ### The rule
 *
 *     expected = activities whose dueAt has passed
 *     onTime   = those of them completed by their dueAt
 *     score    = onTime / expected
 *
 * Three things follow from that, and each is a decision rather than an accident:
 *
 *   - **An overdue, never-completed action stays in the denominator.** It is an
 *     action that was expected and did not happen, which is exactly what the
 *     score measures. Dropping it would mean ignoring a lead improved its score.
 *
 *   - **A future action counts neither way.** It has not been missed yet, so it
 *     belongs in no part of the fraction.
 *
 *   - **Early is on time.** `completedAt <= dueAt`, so finishing a day ahead is
 *     a success and not an anomaly to exclude.
 *
 * ### Why nothing here is stored
 *
 * Every figure below depends on `now`. A stored score would be wrong the moment
 * a deadline passed with nobody touching the row, and would need a sweep to keep
 * true — the same reason `clockState` in Procurement is derived rather than
 * columned. The thresholds come from @rs/shared so the band can be moved without
 * a migration, because there is no stored value to rewrite.
 */

import {
  LEAD_PROMPTNESS_THRESHOLDS,
  addAmount,
  normaliseAmount,
  type LeadActivityKind,
  type LeadPromptnessRating,
} from '@rs/shared';

/** The parts of an activity the arithmetic depends on, and nothing else. */
export type PromptnessInput = {
  kind: LeadActivityKind;
  dueAt: Date;
  completedAt: Date | null;
};

export type Promptness = {
  /** Actions whose moment has arrived — the denominator. */
  expected: number;
  /** Of those, the ones done by their deadline — the numerator. */
  onTime: number;
  /**
   * Expected actions nobody has completed at all.
   *
   * Not simply `expected - onTime`: that difference also counts work finished
   * late, which happened. This is what is still outstanding, which is the figure
   * somebody reading the table can act on.
   */
  overdue: number;
  /**
   * `onTime / expected`, or null when there is nothing to measure.
   *
   * Null rather than 0, deliberately: zero is a real score meaning "nothing was
   * done on time", and a lead with no due actions has not earned it.
   */
  score: number | null;
  rating: LeadPromptnessRating;
};

/**
 * One associate's promptness on one lead.
 *
 * `hasAssociate` is a parameter rather than something inferred from the
 * activities, because the rule is about attribution: a score has to belong to
 * somebody. An unassigned lead stays NOT_RATED however much activity it carries,
 * and the activity is preserved so the rating appears the moment it is assigned.
 */
export function promptness(
  activities: readonly PromptnessInput[],
  now: Date,
  hasAssociate: boolean,
): Promptness {
  const due = activities.filter((activity) => activity.dueAt <= now);

  const expected = due.length;
  const onTime = due.filter(
    (activity) => activity.completedAt !== null && activity.completedAt <= activity.dueAt,
  ).length;
  // Never done at all — distinct from done late, which `onTime` already excludes.
  const overdue = due.filter((activity) => activity.completedAt === null).length;

  /*
    Two separate reasons for NOT_RATED, both returning before any division:
    nothing measurable yet, and nobody to attribute it to. Reporting the counts
    regardless means a reader can still see what the lead holds.
  */
  if (expected === 0 || !hasAssociate) {
    return { expected, onTime, overdue, score: null, rating: 'NOT_RATED' };
  }

  const score = onTime / expected;
  return { expected, onTime, overdue, score, rating: rate(score) };
}

/**
 * Which band a score falls in.
 *
 * Both comparisons are `>=`, so each threshold is the bottom of its own band:
 * exactly 0.65 is GOOD and exactly 0.50 is AVERAGE. Separated from `promptness`
 * so the banding can be tested against bare numbers.
 */
export function rate(score: number): LeadPromptnessRating {
  if (score >= LEAD_PROMPTNESS_THRESHOLDS.GOOD) return 'GOOD';
  if (score >= LEAD_PROMPTNESS_THRESHOLDS.AVERAGE) return 'AVERAGE';
  return 'POOR';
}

// ---------------------------------------------------------------------------
//  Follow-up summary
// ---------------------------------------------------------------------------

/**
 * The most recent follow-up that actually happened.
 *
 * FIRST_CONTACT is excluded on purpose: it is the opening of the conversation,
 * not a follow-up, and folding it in would make a lead that was contacted once
 * and then neglected look as though it had been followed up.
 *
 * Ordered by `completedAt`, not `dueAt` — "last follow-up" is when somebody last
 * spoke to the customer, not when they were next meant to.
 */
export function lastFollowUpAt(activities: readonly PromptnessInput[]): Date | null {
  const completed = activities
    .filter((a) => a.kind === 'FOLLOW_UP' && a.completedAt !== null)
    .map((a) => a.completedAt as Date);

  if (completed.length === 0) return null;
  return completed.reduce((latest, at) => (at > latest ? at : latest));
}

/**
 * The next follow-up somebody is expected to make.
 *
 * **An overdue incomplete follow-up is deliberately NOT this.** "Next" means a
 * scheduled future action; something already missed is not upcoming, it is
 * outstanding. Returning it here would make an overdue lead look as though it
 * had a plan.
 *
 * That activity is not discarded — `promptness` above still counts it in
 * `expected` and fails it in `onTime`, which is where a missed follow-up belongs.
 * The two functions read the same rows and answer different questions.
 */
export function nextFollowUpAt(
  activities: readonly PromptnessInput[],
  now: Date,
): Date | null {
  const upcoming = activities
    .filter((a) => a.kind === 'FOLLOW_UP' && a.completedAt === null && a.dueAt > now)
    .map((a) => a.dueAt);

  if (upcoming.length === 0) return null;
  return upcoming.reduce((earliest, at) => (at < earliest ? at : earliest));
}

/**
 * When the customer was first actually reached.
 *
 * The completed FIRST_CONTACT, not its due moment: "first contact" is an event
 * that happened, and a scheduled-but-unmade call is not one. Null while it is
 * still outstanding.
 *
 * Earliest rather than latest, in the pathological case of more than one — the
 * first contact is the first.
 */
export function firstContactAt(activities: readonly PromptnessInput[]): Date | null {
  const completed = activities
    .filter((a) => a.kind === 'FIRST_CONTACT' && a.completedAt !== null)
    .map((a) => a.completedAt as Date);

  if (completed.length === 0) return null;
  return completed.reduce((earliest, at) => (at < earliest ? at : earliest));
}

/**
 * Whether a lead has a follow-up that has been missed.
 *
 * The follow-up filter's `overdue`, and a different question from
 * `promptness().overdue`, which counts every kind of action. A reader filtering
 * for overdue follow-ups wants the ones that needed a call.
 */
export function hasOverdueFollowUp(
  activities: readonly PromptnessInput[],
  now: Date,
): boolean {
  return activities.some(
    (a) => a.kind === 'FOLLOW_UP' && a.completedAt === null && a.dueAt <= now,
  );
}

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

/**
 * Whether a lead was taken by its own associate or handed to them.
 *
 * Derived from the two ids rather than stored, which is the whole point: a
 * third column saying SELF or OTHER could disagree with the pair it came from.
 *
 * `UNASSIGNED` is a real third answer, not an error — a lead with no associate
 * has no allocation to describe.
 */
export type AllocationKind = 'SELF' | 'OTHER_USER' | 'UNASSIGNED';

export function allocationKind(
  associateId: string | null,
  allocatedById: string | null,
): AllocationKind {
  if (associateId === null) return 'UNASSIGNED';
  return allocatedById === associateId ? 'SELF' : 'OTHER_USER';
}

// ---------------------------------------------------------------------------
//  Volume — Phase 4F
// ---------------------------------------------------------------------------

/**
 * Volume is **not defined here**, deliberately.
 *
 * It lives in `@rs/shared` as `volume()`, beside the `toMillimetres` it composes,
 * because the browser needs the same formula: the Complete the Ideal form
 * previews a volume as somebody types, and the API derives one on every read. A
 * copy in this module would be a second answer that drifts the first time one of
 * them rounds differently.
 *
 * Re-exported rather than wrapped so this module's callers import it from the one
 * place the rest of the Lead arithmetic comes from, while there remains exactly
 * one implementation.
 */
export { volume, type VolumeResult } from '@rs/shared';

// ---------------------------------------------------------------------------
//  Requirement value
// ---------------------------------------------------------------------------

/**
 * What the customer asked for, as the associate priced it.
 *
 * ### Why this is not Order Value
 *
 * Two different facts, and conflating them would be the expensive mistake:
 *
 *   - **Order Value** is what a real SalesOrder is worth, derived through Sales'
 *     own `toMoney`. A lead that never became an order has none, and that is
 *     reported as null rather than zero.
 *   - **Requirement Value** is pre-sales: an estimate against what somebody said
 *     they wanted, which may never become an order and may differ from one when
 *     it does. Quoting ₹20,000 and selling ₹18,500 is an ordinary outcome, not a
 *     discrepancy to reconcile.
 *
 * So this never fills in for a missing order value, and a lead can legitimately
 * report both.
 *
 * ### Null versus zero
 *
 * Null when no requirement carries a value at all — nobody has priced this yet.
 * Zero when they have and the answer is zero, which a sample or a replacement
 * legitimately is. Unpriced requirements are skipped rather than counted as
 * zero, so one priced line among four still totals that line.
 *
 * ### Why nothing stores it
 *
 * A stored total would be a figure free to contradict the rows it came from the
 * moment one was edited — the same reason no column holds order value, promptness
 * or volume. Summed through the shared `addAmount`, which is string decimal
 * arithmetic rather than floating point, so ₹20,000.10 + ₹8,000.20 totals exactly
 * and rounding matches every other money figure in the CRM.
 */
export function requirementValue(
  requirements: readonly { productValue: { toString(): string } | null }[],
): string | null {
  const priced = requirements.filter((r) => r.productValue !== null);
  if (priced.length === 0) return null;

  return priced.reduce(
    (total, r) => addAmount(total, normaliseAmount(r.productValue!.toString())),
    '0.00',
  );
}
