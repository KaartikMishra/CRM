import type {
  CompetencyCategory,
  DevelopmentPlanKind,
  DevelopmentPlanStatus,
  GoalScope,
  GoalStatus,
  KpiDirection,
  KpiMetricKind,
  PerformanceReviewStatus,
  RatingSource,
  ReviewCycleCadence,
  ReviewCycleStatus,
} from '@rs/shared';

/**
 * How HR Phase 5 values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend suite can assert
 * them directly — the project's convention for presentation logic, and the reason
 * none of this is inlined into the components.
 *
 * **Nothing here decides anything.** Not a KPI's attainment (the server's
 * arithmetic), not whether a review may be finalised (`viewerCan`, from the server),
 * not whether a manager's assessment is visible (the server nulls it). These
 * functions decide only how an already-decided value is written down.
 *
 * ### On the 1–5 scale
 *
 * `RATING_LABELS` names five levels. That scale is an **implementation decision**,
 * not a confirmed business requirement — it matches Phase 3's interview feedback and
 * probation reviews so the three are comparable. See
 * `backend/src/modules/hr/PERFORMANCE-SCOPE.md`. If a real requirement says
 * otherwise, this map and the shared constants change together.
 */

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline';

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

export const CYCLE_STATUS_LABELS: Record<ReviewCycleStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Open',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

/**
 * ACTIVE reads as "Open" and is the positive tone.
 *
 * What an HR colleague cares about is whether the cycle accepts work, not whether a
 * button was pressed — the same reasoning the recruitment board and the training
 * catalogue apply.
 */
export const CYCLE_STATUS_TONES: Record<ReviewCycleStatus, Tone> = {
  DRAFT: 'outline',
  ACTIVE: 'positive',
  CLOSED: 'neutral',
  ARCHIVED: 'neutral',
};

export const CADENCE_LABELS: Record<ReviewCycleCadence, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  ANNUAL: 'Annual',
  AD_HOC: 'One-off',
};

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

/**
 * Where a review stands, in words somebody can act on.
 *
 * Each label says *who is holding it*, not what state machine node it sits at.
 * "Waiting on your manager" tells an employee there is nothing for them to do;
 * "PENDING_MANAGER" tells them nothing.
 */
export const REVIEW_STATUS_LABELS: Record<PerformanceReviewStatus, string> = {
  NOT_STARTED: 'Not started',
  SELF_ASSESSMENT: 'Self-assessment in progress',
  PENDING_MANAGER: 'Waiting on the manager',
  MANAGER_REVIEW: 'Manager writing',
  PENDING_APPROVAL: 'Waiting on approval',
  FINALIZED: 'Finalised',
  CANCELLED: 'Withdrawn',
};

export const REVIEW_STATUS_TONES: Record<PerformanceReviewStatus, Tone> = {
  NOT_STARTED: 'outline',
  SELF_ASSESSMENT: 'accent',
  PENDING_MANAGER: 'warning',
  MANAGER_REVIEW: 'accent',
  PENDING_APPROVAL: 'warning',
  FINALIZED: 'positive',
  CANCELLED: 'neutral',
};

/**
 * What the person reading their own review should do next.
 *
 * Deliberately addressed to the employee rather than describing the record: the
 * commonest question on this page is "is this waiting on me", and a status badge
 * answers it only to somebody who already knows the process.
 */
export const REVIEW_NEXT_STEP_FOR_EMPLOYEE: Record<PerformanceReviewStatus, string> = {
  NOT_STARTED: 'Write your self-assessment to begin.',
  SELF_ASSESSMENT: 'Finish your self-assessment and submit it.',
  PENDING_MANAGER: 'Submitted. Your manager will write theirs next.',
  MANAGER_REVIEW: 'Your manager is writing their review.',
  PENDING_APPROVAL: 'Your review is with HR for approval.',
  FINALIZED: 'This review is complete and can no longer be changed.',
  CANCELLED: 'This review was withdrawn.',
};

// ---------------------------------------------------------------------------
//  Goals and KPIs
// ---------------------------------------------------------------------------

export const GOAL_SCOPE_LABELS: Record<GoalScope, string> = {
  EMPLOYEE: 'Individual',
  DEPARTMENT: 'Department',
};

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Agreed',
  ACHIEVED: 'Achieved',
  PARTIALLY_MET: 'Partially met',
  MISSED: 'Missed',
  CANCELLED: 'Cancelled',
};

/**
 * PARTIALLY_MET is `warning`, not `critical`.
 *
 * It is an honest middle outcome, and colouring it as a failure would undo the
 * reason three outcomes exist rather than two.
 */
export const GOAL_STATUS_TONES: Record<GoalStatus, Tone> = {
  DRAFT: 'outline',
  ACTIVE: 'accent',
  ACHIEVED: 'positive',
  PARTIALLY_MET: 'warning',
  MISSED: 'critical',
  CANCELLED: 'neutral',
};

export const METRIC_KIND_LABELS: Record<KpiMetricKind, string> = {
  NUMBER: 'Count',
  PERCENTAGE: 'Percentage',
  CURRENCY: 'Amount',
  DURATION: 'Minutes',
  BOOLEAN: 'Done / not done',
};

export const DIRECTION_LABELS: Record<KpiDirection, string> = {
  HIGHER_IS_BETTER: 'Higher is better',
  LOWER_IS_BETTER: 'Lower is better',
};

/**
 * What each direction means for the arithmetic, in words.
 *
 * Shown beside the field because getting it wrong is silent and consequential: a
 * handling-time KPI set to HIGHER_IS_BETTER scores a team as failing for reducing
 * exactly what they were asked to reduce.
 */
export const DIRECTION_HINTS: Record<KpiDirection, string> = {
  HIGHER_IS_BETTER: 'Target is met by reaching or exceeding it — sales, orders, scores.',
  LOWER_IS_BETTER: 'Target is met by reaching or going below it — handling time, complaints.',
};

// ---------------------------------------------------------------------------
//  Competencies and ratings
// ---------------------------------------------------------------------------

export const COMPETENCY_CATEGORY_LABELS: Record<CompetencyCategory, string> = {
  CORE: 'Core',
  FUNCTIONAL: 'Functional',
  LEADERSHIP: 'Leadership',
  BEHAVIOURAL: 'Behavioural',
};

export const RATING_SOURCE_LABELS: Record<RatingSource, string> = {
  SELF: 'Self',
  MANAGER: 'Manager',
  HR: 'HR',
};

/**
 * The five levels, named.
 *
 * Named rather than left as bare integers so a stored 3 cannot be read as "3 out of
 * 10" by a later screen, and so the wording lives in one place. The scale itself is
 * an implementation decision — see the file note.
 */
export const RATING_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Needs significant improvement',
  2: 'Developing',
  3: 'Meets expectations',
  4: 'Exceeds expectations',
  5: 'Outstanding',
};

/** Short forms, for a table cell where the full sentence will not fit. */
export const RATING_SHORT_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Needs improvement',
  2: 'Developing',
  3: 'Meets',
  4: 'Exceeds',
  5: 'Outstanding',
};

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

export const PLAN_KIND_LABELS: Record<DevelopmentPlanKind, string> = {
  IMPROVEMENT: 'Improvement',
  GROWTH: 'Growth',
};

/**
 * An improvement plan is `warning`; a growth plan is `accent`.
 *
 * The two must not look alike. One is a formal process with consequences, the other
 * is somebody doing well who wants a next step, and a screen showing them
 * identically would put a promotion track beside a formal warning.
 */
export const PLAN_KIND_TONES: Record<DevelopmentPlanKind, Tone> = {
  IMPROVEMENT: 'warning',
  GROWTH: 'accent',
};

export const PLAN_STATUS_LABELS: Record<DevelopmentPlanStatus, string> = {
  OPEN: 'Open',
  COMPLETED: 'Completed',
  ABANDONED: 'Abandoned',
};

export const PLAN_STATUS_TONES: Record<DevelopmentPlanStatus, Tone> = {
  OPEN: 'accent',
  COMPLETED: 'positive',
  ABANDONED: 'neutral',
};

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

/**
 * A calendar day, formatted without constructing a Date.
 *
 * `new Date('2026-10-12')` parses as UTC midnight and renders as the 11th in any
 * timezone behind UTC — a due date one day early is the kind of bug nobody reports
 * and everybody works around. So the string is split instead.
 */
export function formatPerfDay(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return '—';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${Number(day)} ${months[Number(month) - 1] ?? ''} ${year}`;
}

/** An instant, in company time (IST). */
export function formatPerfMoment(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/** A period, as one phrase. */
export function formatPeriod(start: string, end: string): string {
  return `${formatPerfDay(start)} – ${formatPerfDay(end)}`;
}

/**
 * An attainment percentage, as the server sent it.
 *
 * Takes the decimal string and renders it without arithmetic. `0.1 + 0.2 !== 0.3`,
 * and this figure feeds a pay conversation — so the browser formats what it was
 * given and computes nothing.
 *
 * **Null renders as "Not measured", never as 0%.** Nothing recorded is not the same
 * as nothing achieved, and the distinction is the one most worth preserving on this
 * screen: a goal on track but unmeasured must not read as a failure.
 */
export function formatAttainment(value: string | null): string {
  if (value === null) return 'Not measured';
  const n = Number(value);
  if (Number.isNaN(n)) return 'Not measured';
  return `${n % 1 === 0 ? n.toFixed(0) : String(n)}%`;
}

/** A rating out of five, as sent. Null is an absence, not a zero. */
export function formatRating(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)} / 5`;
}

/** A measured value with its unit, where one was given. */
export function formatMeasure(value: string | null, unitLabel: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  const rendered = n % 1 === 0 ? n.toFixed(0) : String(n);
  return unitLabel ? `${rendered} ${unitLabel}` : rendered;
}

/**
 * A KPI's progress towards its target, as a sentence.
 *
 * Reads "25 of 30" rather than "83%", because the attainment percentage is shown
 * separately and may legitimately differ from the naive ratio — a baselined KPI at
 * 25 of 30 from a baseline of 20 is 50% attained, and showing both numbers is how
 * somebody sees why.
 */
export function formatTargetProgress(
  current: string | null,
  target: string,
  unitLabel: string | null,
): string {
  if (current === null) return `Target ${formatMeasure(target, unitLabel)}`;
  return `${formatMeasure(current, unitLabel)} of ${formatMeasure(target, unitLabel)}`;
}

/**
 * How far through a plan's actions somebody is.
 *
 * Derived from the two server counts rather than from the action rows, so a
 * filtered or partially-loaded list cannot make the figure disagree with itself.
 */
export function planProgress(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * Whether a dated item is overdue, against a day the caller supplies.
 *
 * The reference day is a parameter rather than read from the clock inside — which
 * makes it testable, and lets the caller pass the *company-time* day so a colleague
 * abroad is not told their self-assessment is late a day early.
 *
 * Mostly the server sends `isOverdue` already computed and components read that.
 * This exists for the places that have a date and no flag.
 */
export function isPerfOverdue(dueOn: string | null, todayKey: string): boolean {
  if (!dueOn) return false;
  return dueOn.slice(0, 10) < todayKey;
}

/**
 * Today in company time (IST, +5:30 fixed).
 *
 * The same constant offset the backend uses. India observes no daylight saving, so
 * a fixed offset is exact rather than an approximation.
 */
export function companyToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Why a gap between a self rating and a manager rating is worth naming.
 *
 * The appraisal conversation is largely about disagreement, so the UI says when the
 * two differ rather than leaving somebody to compare two numbers in adjacent cells.
 * Returns null when there is nothing to say — both absent, or they agree.
 */
export function describeRatingGap(
  self: number | null,
  manager: number | null,
): string | null {
  if (self === null || manager === null) return null;
  if (self === manager) return null;

  const diff = Math.abs(self - manager);
  const direction = self > manager ? 'higher' : 'lower';
  return `You rated this ${diff} ${diff === 1 ? 'level' : 'levels'} ${direction}`;
}
