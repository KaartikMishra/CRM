/**
 * HR Phase 5 — Performance Management, as the API presents it.
 *
 * ### Nothing in this file is computed by the browser
 *
 * Every attainment percentage, every goal outcome, every review average and every
 * "may this be edited" flag arrives already decided by the service. The frontend
 * renders these shapes and does no arithmetic on them — the same rule Phase 4
 * established, and for a sharper reason here: a performance score feeds pay and
 * promotion conversations, and a browser that computed its own would eventually
 * disagree with the record.
 *
 * Decimal values travel as **strings**. `0.1 + 0.2 !== 0.3`, and an attainment
 * figure that drifts in the last place is a figure somebody will dispute. The
 * database holds Decimal, the wire carries the exact digits, and the UI formats
 * them.
 *
 * ### The answer-key equivalent
 *
 * Phase 4's rule was that a learner must never receive `isCorrect`. Phase 5's
 * equivalent is narrower but real: **an employee must not read their manager's
 * review before it is shared with them.** A manager's draft assessment of somebody
 * is a private working document until submitted, and `ManagerReviewView` is
 * therefore a separate shape from what the employee's own page receives — see
 * `PerformanceReviewView.managerAssessment`, which the service nulls while the
 * manager is still drafting.
 */

import type {
  CompetencyCategory,
  CompetencyRating,
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
} from '../enums.js';
import type { EmployeeRef, OrgUnitRef } from './hr.js';
import type { ActorRef } from './recruitment.js';

// ---------------------------------------------------------------------------
//  Review cycles
// ---------------------------------------------------------------------------

export type ReviewCycleSummary = {
  id: string;
  code: string;
  name: string;
  cadence: ReviewCycleCadence;
  status: ReviewCycleStatus;
  /** The period being appraised. Calendar days, read in company time. */
  periodStart: string;
  periodEnd: string;
  /** When reviews are expected in by. Null means no stated deadline. */
  selfAssessmentDueOn: string | null;
  managerReviewDueOn: string | null;
  /** This cycle's own thresholds, as decimal strings. Never the constant. */
  goalAchievementThreshold: string;
  goalPartialThreshold: string;
  /** Derived counts. The database counts rows; nothing here sums a list. */
  reviewCount: number;
  finalizedCount: number;
  createdAt: string;
};

export type ReviewCycleView = ReviewCycleSummary & {
  description: string | null;
  /** Which department this cycle covers. Null means the whole company. */
  targetDepartment: OrgUnitRef | null;
  /** The competencies every review in this cycle rates, in display order. */
  competencies: CompetencyDefinitionView[];
  createdBy: ActorRef;
  activatedAt: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
};

/**
 * One competency a cycle rates.
 *
 * Defined per cycle rather than globally, which is the decision worth stating: the
 * attributes a business cares about change, and a global list would mean either
 * editing history or accumulating retired competencies forever. A cycle's sheet is
 * fixed once it opens, so a review always shows the competencies it was actually
 * rated against.
 */
export type CompetencyDefinitionView = {
  id: string;
  cycleId: string;
  name: string;
  category: CompetencyCategory;
  description: string | null;
  /** Relative importance within the sheet, as a decimal string. */
  weight: string;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
//  Goals and KPIs
// ---------------------------------------------------------------------------

export type GoalSummary = {
  id: string;
  code: string;
  title: string;
  scope: GoalScope;
  status: GoalStatus;
  /** Exactly one of these is set, which a CHECK enforces. */
  employee: EmployeeRef | null;
  department: OrgUnitRef | null;
  /** The cycle this goal is appraised in, where it is tied to one. */
  cycle: { id: string; code: string; name: string } | null;
  startOn: string;
  dueOn: string;
  /** Weight within the owner's goal set, as a decimal string. */
  weight: string;
  /**
   * Overall attainment across this goal's KPIs, as a decimal percentage string.
   *
   * Computed server-side from each KPI's own attainment and weight. Null when the
   * goal has no KPIs with recorded progress — which is different from 0, and the
   * UI must show those differently: nothing recorded is not the same as nothing
   * achieved.
   */
  attainment: string | null;
  kpiCount: number;
  /** Server-derived against the company-time day, not the viewer's clock. */
  isOverdue: boolean;
  createdAt: string;
};

export type GoalView = GoalSummary & {
  description: string | null;
  /** How success was defined, in the words agreed at the time. */
  successCriteria: string | null;
  kpis: KpiView[];
  createdBy: ActorRef;
  /** Set when the goal reached a terminal status, with who and why. */
  closedBy: ActorRef | null;
  closedAt: string | null;
  closureNote: string | null;
  updatedAt: string;
};

/**
 * One measurable indicator under a goal.
 *
 * `targetValue` and `currentValue` are decimal strings and `attainment` is derived
 * from them by `performance.calc.ts` — never in the browser, and never stored as a
 * float. `direction` decides the arithmetic: a KPI where lower is better attains
 * 100% by reaching a value at or below target.
 */
export type KpiView = {
  id: string;
  goalId: string;
  name: string;
  description: string | null;
  metricKind: KpiMetricKind;
  direction: KpiDirection;
  /** Decimal strings. The unit is implied by `metricKind`. */
  targetValue: string;
  baselineValue: string | null;
  currentValue: string | null;
  /** Free text, e.g. "orders" or "₹". Display only; no arithmetic reads it. */
  unitLabel: string | null;
  weight: string;
  /**
   * Attainment against target, as a decimal percentage string.
   *
   * Null until a value is recorded. Uncapped deliberately: somebody who hit 140%
   * of target did so, and clamping it to 100 would erase exactly the information a
   * performance review exists to surface. The goal-level roll-up decides what to
   * do with an over-attainment.
   */
  attainment: string | null;
  lastUpdatedAt: string | null;
  lastUpdatedBy: ActorRef | null;
  sortOrder: number;
};

/** One recorded movement on a KPI. The audit trail of a number. */
export type KpiProgressEntry = {
  id: string;
  kpiId: string;
  value: string;
  note: string | null;
  recordedBy: ActorRef;
  recordedAt: string;
};

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

export type PerformanceReviewSummary = {
  id: string;
  cycle: { id: string; code: string; name: string };
  employee: EmployeeRef;
  /** Who owes the manager review. Null if the employee has no manager set. */
  reviewer: EmployeeRef | null;
  status: PerformanceReviewStatus;
  /** Decimal strings, each null until the relevant side has submitted. */
  selfOverallRating: string | null;
  managerOverallRating: string | null;
  /** The figure of record, set at finalisation. */
  finalRating: string | null;
  selfSubmittedAt: string | null;
  managerSubmittedAt: string | null;
  finalizedAt: string | null;
  /** Against the cycle's due dates, in company time. Server-derived. */
  isSelfAssessmentOverdue: boolean;
  isManagerReviewOverdue: boolean;
  createdAt: string;
};

export type PerformanceReviewView = PerformanceReviewSummary & {
  /**
   * The employee's own assessment.
   *
   * Visible to the employee always, and to the manager and HR once submitted. A
   * manager reading an unsubmitted self-assessment would be reading a draft
   * somebody is still thinking about, so the service nulls it until
   * `selfSubmittedAt` is set.
   */
  selfAssessment: SelfAssessmentView | null;
  /**
   * The manager's assessment.
   *
   * **Null for the employee until the manager has submitted.** A manager's draft
   * is a private working document; showing it early would mean an employee reading
   * half-formed criticism, and managers would stop drafting honestly. The service
   * decides this, not the page.
   */
  managerAssessment: ManagerAssessmentView | null;
  /** Both sides' ratings per competency, side by side once both exist. */
  competencyRatings: CompetencyRatingView[];
  /** The goals this review appraises, with their attainment at read time. */
  goals: GoalSummary[];
  /**
   * The weighted goal attainment across this review's goals, as a decimal string.
   *
   * Server-computed. Null when no goal has recorded progress.
   */
  goalAttainment: string | null;
  developmentPlans: DevelopmentPlanSummary[];
  finalizedBy: ActorRef | null;
  finalComments: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /**
   * What this viewer may do, decided server-side.
   *
   * Sent rather than inferred because the rules are not derivable from the status
   * alone: whether somebody may write the manager review depends on who they are
   * relative to this employee, and a finalized review is editable by nobody at
   * all. The page renders controls from these flags; the API enforces them again
   * regardless.
   */
  viewerCan: {
    editSelfAssessment: boolean;
    submitSelfAssessment: boolean;
    editManagerAssessment: boolean;
    submitManagerAssessment: boolean;
    finalize: boolean;
    cancel: boolean;
  };
  /**
   * Whether the reader is the employee being appraised.
   *
   * Server-computed, and it has to be. The obvious client-side test — compare the
   * session's `employeeId` to `employee.employeeId` — is **wrong**: `User.employeeId`
   * and `Employee.employeeId` are different columns on different tables. They are
   * drawn from one shared series (`allocateEmployeeId` seeds from both), so they
   * usually agree for a linked person, but nothing enforces it: linking an account
   * does not sync the codes, so an account created outside the HR flow can be linked
   * to an employee whose code differs. The comparison then silently returns false and
   * the employee is shown somebody else's view of their own review.
   *
   * The service knows the actual link — `Employee.userId` against the actor's id — so
   * it answers here and the page reads it.
   */
  viewerIsSubject: boolean;
  updatedAt: string;
};

export type SelfAssessmentView = {
  /** What they did, in their words. */
  achievements: string | null;
  challenges: string | null;
  /** What they want next — the input a development plan is usually built from. */
  developmentWishes: string | null;
  /** Their own overall figure, as a decimal string. */
  overallRating: string | null;
  submittedAt: string | null;
  updatedAt: string;
};

export type ManagerAssessmentView = {
  strengths: string | null;
  improvementAreas: string | null;
  comments: string | null;
  overallRating: string | null;
  /** Whether the manager recommends a promotion. Null means not stated. */
  promotionRecommended: boolean | null;
  submittedAt: string | null;
  submittedBy: ActorRef | null;
  updatedAt: string;
};

/**
 * One competency, with however many ratings exist for it.
 *
 * Shaped as a competency with a list rather than a flat row per rating, because
 * the appraisal conversation is "we rated this differently" — and that is only
 * visible when both sides sit together. `self` and `manager` are pulled out for
 * convenience; `ratings` carries the full set including any HR rating.
 */
export type CompetencyRatingView = {
  competency: CompetencyDefinitionView;
  self: { rating: CompetencyRating; comments: string | null } | null;
  manager: { rating: CompetencyRating; comments: string | null } | null;
  ratings: {
    id: string;
    source: RatingSource;
    rating: CompetencyRating;
    comments: string | null;
    ratedBy: ActorRef;
    ratedAt: string;
  }[];
};

// ---------------------------------------------------------------------------
//  Development and improvement plans
// ---------------------------------------------------------------------------

export type DevelopmentPlanSummary = {
  id: string;
  employee: EmployeeRef;
  kind: DevelopmentPlanKind;
  status: DevelopmentPlanStatus;
  title: string;
  /** When it should be reviewed. An improvement plan without one is not a plan. */
  reviewOn: string | null;
  /** The review it came out of, where it came out of one. */
  reviewId: string | null;
  actionCount: number;
  completedActionCount: number;
  isOverdue: boolean;
  createdAt: string;
};

export type DevelopmentPlanView = DevelopmentPlanSummary & {
  objective: string | null;
  supportOffered: string | null;
  actions: DevelopmentActionView[];
  createdBy: ActorRef;
  closedBy: ActorRef | null;
  closedAt: string | null;
  outcomeNote: string | null;
  updatedAt: string;
};

export type DevelopmentActionView = {
  id: string;
  planId: string;
  description: string;
  dueOn: string | null;
  isCompleted: boolean;
  completedAt: string | null;
  completedBy: ActorRef | null;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
//  Dashboard and reports
// ---------------------------------------------------------------------------

/**
 * The performance dashboard.
 *
 * Real aggregate counts from the database, not the length of a page of results —
 * the same approach Phase 4's training overview takes. Each figure is scoped
 * server-side to what the reader may see, so a department head's dashboard is
 * their department's.
 */
export type PerformanceOverview = {
  activeCycles: number;
  /** Reviews in this reader's scope, by where they stand. */
  reviewsNotStarted: number;
  reviewsAwaitingSelf: number;
  reviewsAwaitingManager: number;
  reviewsAwaitingApproval: number;
  reviewsFinalized: number;
  /** Past their cycle's due date and not yet submitted. The accountable figure. */
  selfAssessmentsOverdue: number;
  managerReviewsOverdue: number;
  activeGoals: number;
  goalsOverdue: number;
  goalsAchieved: number;
  openImprovementPlans: number;
  /** What this reader personally owes. Zero for somebody with no reports. */
  myReviewsToWrite: number;
  myOwnReviewPending: boolean;
};

/**
 * One person's appraisal history.
 *
 * Finalized reviews only, oldest first: a history that included drafts and
 * cancellations would make a trend line out of noise. The rating is the figure of
 * record at finalisation, which is why editing a finalized review is refused —
 * this list would otherwise change retroactively.
 */
export type PerformanceHistoryEntry = {
  reviewId: string;
  cycle: { id: string; code: string; name: string };
  periodStart: string;
  periodEnd: string;
  finalRating: string | null;
  goalAttainment: string | null;
  finalizedAt: string;
  reviewer: EmployeeRef | null;
};

export type PerformanceHistoryView = {
  employee: EmployeeRef;
  entries: PerformanceHistoryEntry[];
  /** Mean of the finalized ratings, as a decimal string. Null with none. */
  averageRating: string | null;
};

/**
 * A cycle's standing, for the report screen.
 *
 * Counts and distribution rather than a league table of named people:
 * a report that ranked colleagues by rating would be read as one, and nobody has
 * asked for that. The per-person figures are on each review.
 */
export type CycleReportView = {
  cycle: ReviewCycleSummary;
  /** How many reviews sit at each status. Keyed by the status name. */
  statusCounts: Record<PerformanceReviewStatus, number>;
  /** Finalized ratings bucketed 1–5, for a distribution the business can read. */
  ratingDistribution: { rating: number; count: number }[];
  averageFinalRating: string | null;
  averageGoalAttainment: string | null;
  /** Departments covered, with their own averages. */
  byDepartment: {
    department: OrgUnitRef;
    reviewCount: number;
    finalizedCount: number;
    averageFinalRating: string | null;
  }[];
};

// ---------------------------------------------------------------------------
//  Paged responses
// ---------------------------------------------------------------------------

export type PerformancePage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ReviewCyclePage = PerformancePage<ReviewCycleSummary>;
export type GoalPage = PerformancePage<GoalSummary>;
export type PerformanceReviewPage = PerformancePage<PerformanceReviewSummary>;
export type DevelopmentPlanPage = PerformancePage<DevelopmentPlanSummary>;
