/**
 * The HR Phase 5 frontend, asserted without a DOM.
 *
 * Two kinds of test, matching the convention in this directory:
 *
 *   1. **Pure logic**, called directly — label maps, formatting, progress and gap
 *      description. All exported from `performance-labels.ts` precisely so they can
 *      be tested as functions rather than through a render.
 *   2. **Structural assertions** over the source, for properties about *what the
 *      components do not do*.
 *
 * The structural half carries most of the weight, because Phase 5's riskiest
 * properties are all absences:
 *
 *   - no page may show a manager's draft assessment to its subject
 *   - no control may offer self-finalisation
 *   - no browser may compute an attainment, a rating or a review state
 *   - no request may carry a claimed attainment
 *   - a finalised review must be inert in the UI
 *
 * None of those is observable from rendered output. A page that computes its own
 * attainment renders perfectly well right up until it disagrees with the record —
 * and on this module the record feeds a pay conversation. So the assertion is that
 * the code never asks.
 *
 * **What these tests cannot prove.** That the API enforces any of it. The UI hiding
 * a button is a courtesy; the 403 is the control, and that lives in
 * `backend/src/modules/hr/__tests__/performance-review.test.ts` — 30 HTTP tests
 * including an ADMIN holding APPROVE being refused finalisation of their own review.
 * Neither file substitutes for the other.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPETENCY_CATEGORIES,
  COMPETENCY_RATINGS,
  DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD,
  DEFAULT_GOAL_PARTIAL_THRESHOLD,
  DEVELOPMENT_PLAN_KINDS,
  DEVELOPMENT_PLAN_STATUSES,
  GOAL_SCOPES,
  GOAL_STATUSES,
  KPI_DIRECTIONS,
  KPI_METRIC_KINDS,
  MAX_COMPETENCY_RATING,
  MIN_COMPETENCY_RATING,
  PERFORMANCE_REVIEW_STATUSES,
  RATING_SOURCES,
  REVIEW_CYCLE_CADENCES,
  REVIEW_CYCLE_STATUSES,
} from '@rs/shared';
import {
  CADENCE_LABELS,
  COMPETENCY_CATEGORY_LABELS,
  CYCLE_STATUS_LABELS,
  CYCLE_STATUS_TONES,
  DIRECTION_HINTS,
  DIRECTION_LABELS,
  GOAL_SCOPE_LABELS,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_TONES,
  METRIC_KIND_LABELS,
  PLAN_KIND_LABELS,
  PLAN_KIND_TONES,
  PLAN_STATUS_LABELS,
  PLAN_STATUS_TONES,
  RATING_LABELS,
  RATING_SHORT_LABELS,
  RATING_SOURCE_LABELS,
  REVIEW_NEXT_STEP_FOR_EMPLOYEE,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TONES,
  companyToday,
  describeRatingGap,
  formatAttainment,
  formatMeasure,
  formatPerfDay,
  formatPeriod,
  formatRating,
  formatTargetProgress,
  isPerfOverdue,
  planProgress,
} from '@/components/hr/performance-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by every "this does not do X" assertion: these files *document* what they
 * deliberately omit, so a naive substring search matches the comment explaining the
 * absence and fails a correct file.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every file an employee can reach. The security assertions run over all of them. */
const EMPLOYEE_SURFACES = [
  'components/hr/review-panels.tsx',
  'components/hr/performance-tables.tsx',
  'components/hr/goal-panels.tsx',
  'components/hr/plan-panels.tsx',
  'app/(app)/hr/performance/page.tsx',
  'app/(app)/hr/performance/my-review/page.tsx',
  'app/(app)/hr/performance/reviews/[id]/page.tsx',
  'app/(app)/hr/performance/goals/[id]/page.tsx',
  'app/(app)/hr/performance/plans/[id]/page.tsx',
] as const;

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

describe('every Phase 5 enum value has a label', () => {
  /*
    The failure this prevents: `LABELS[value]` returns undefined for a value nobody
    added, and React renders nothing — so a status silently disappears from a board
    rather than erroring anywhere.
  */
  it('covers cycle statuses and cadences, with a tone for each status', () => {
    for (const status of REVIEW_CYCLE_STATUSES) {
      expect(CYCLE_STATUS_LABELS[status], status).toBeTruthy();
      expect(CYCLE_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const cadence of REVIEW_CYCLE_CADENCES) {
      expect(CADENCE_LABELS[cadence], cadence).toBeTruthy();
    }
  });

  it('covers every review status, with a tone and a next step', () => {
    for (const status of PERFORMANCE_REVIEW_STATUSES) {
      expect(REVIEW_STATUS_LABELS[status], status).toBeTruthy();
      expect(REVIEW_STATUS_TONES[status], status).toBeTruthy();
      expect(REVIEW_NEXT_STEP_FOR_EMPLOYEE[status], status).toBeTruthy();
    }
  });

  it('covers goal scopes and statuses', () => {
    for (const scope of GOAL_SCOPES) {
      expect(GOAL_SCOPE_LABELS[scope], scope).toBeTruthy();
    }
    for (const status of GOAL_STATUSES) {
      expect(GOAL_STATUS_LABELS[status], status).toBeTruthy();
      expect(GOAL_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('covers KPI kinds and directions, and explains each direction', () => {
    for (const kind of KPI_METRIC_KINDS) {
      expect(METRIC_KIND_LABELS[kind], kind).toBeTruthy();
    }
    for (const direction of KPI_DIRECTIONS) {
      expect(DIRECTION_LABELS[direction], direction).toBeTruthy();
      // Getting the direction wrong is silent and consequential, so the UI explains
      // it rather than just naming it.
      expect(DIRECTION_HINTS[direction], direction).toBeTruthy();
    }
  });

  it('covers competency categories, rating sources and all five levels', () => {
    for (const category of COMPETENCY_CATEGORIES) {
      expect(COMPETENCY_CATEGORY_LABELS[category], category).toBeTruthy();
    }
    for (const source of RATING_SOURCES) {
      expect(RATING_SOURCE_LABELS[source], source).toBeTruthy();
    }
    for (const level of COMPETENCY_RATINGS) {
      expect(RATING_LABELS[level], String(level)).toBeTruthy();
      expect(RATING_SHORT_LABELS[level], String(level)).toBeTruthy();
    }
  });

  it('covers plan kinds and statuses', () => {
    for (const kind of DEVELOPMENT_PLAN_KINDS) {
      expect(PLAN_KIND_LABELS[kind], kind).toBeTruthy();
      expect(PLAN_KIND_TONES[kind], kind).toBeTruthy();
    }
    for (const status of DEVELOPMENT_PLAN_STATUSES) {
      expect(PLAN_STATUS_LABELS[status], status).toBeTruthy();
      expect(PLAN_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('names a review status by who is holding it, not by its enum value', () => {
    /*
      The commonest question on a review page is "is this waiting on me", and
      "PENDING_MANAGER" answers it only to somebody who already knows the process.
    */
    expect(REVIEW_STATUS_LABELS.PENDING_MANAGER).toBe('Waiting on the manager');
    expect(REVIEW_STATUS_LABELS.PENDING_APPROVAL).toBe('Waiting on approval');
  });

  it('distinguishes an improvement plan from a growth plan by tone', () => {
    /*
      The two must not look alike. One is a formal process with consequences, the
      other is somebody doing well who wants a next step — a screen showing them
      identically would put a promotion track beside a formal warning.
    */
    expect(PLAN_KIND_TONES.IMPROVEMENT).not.toBe(PLAN_KIND_TONES.GROWTH);
  });

  it('does not colour a partially-met goal as a failure', () => {
    // It is an honest middle outcome, and colouring it critical would undo the
    // reason three outcomes exist rather than two.
    expect(GOAL_STATUS_TONES.PARTIALLY_MET).not.toBe('critical');
    expect(GOAL_STATUS_TONES.MISSED).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

describe('formatting does no arithmetic on a performance figure', () => {
  it('renders an attainment string without recomputing it', () => {
    expect(formatAttainment('50.00')).toBe('50%');
    expect(formatAttainment('33.33')).toBe('33.33%');
    expect(formatAttainment('140.00')).toBe('140%');
  });

  it('renders an unmeasured attainment as "Not measured", never as 0%', () => {
    /*
      THE distinction on this screen. Nothing recorded is not the same as nothing
      achieved, and a goal on track but unmeasured must not read as a failure.
    */
    expect(formatAttainment(null)).toBe('Not measured');
    expect(formatAttainment('not a number')).toBe('Not measured');
    // And a genuine zero still reads as zero.
    expect(formatAttainment('0.00')).toBe('0%');
  });

  it('renders a rating out of five, and an absent one as a dash', () => {
    expect(formatRating('4.00')).toBe('4 / 5');
    expect(formatRating('3.33')).toBe('3.33 / 5');
    expect(formatRating(null)).toBe('—');
  });

  it('formats a day without constructing a Date, so no timezone shifts it', () => {
    expect(formatPerfDay('2026-10-12')).toBe('12 Oct 2026');
    expect(formatPerfDay('2026-01-31T00:00:00.000Z')).toBe('31 Jan 2026');
    expect(formatPerfDay(null)).toBe('—');
    expect(formatPerfDay('nonsense')).toBe('—');
  });

  it('never calls new Date in the day formatter', () => {
    /*
      The whole point of the string-splitting implementation: `new Date('2026-10-12')`
      parses as UTC midnight and renders as the 11th in any timezone behind UTC. A
      due date one day early is the kind of bug nobody reports and everybody works
      around.
    */
    const source = executableCodeOf('components/hr/performance-labels.ts');
    const dayFn = source.slice(
      source.indexOf('export function formatPerfDay'),
      source.indexOf('export function formatPerfMoment'),
    );
    expect(dayFn).not.toContain('new Date');
  });

  it('writes a period as one phrase', () => {
    expect(formatPeriod('2026-01-01', '2026-12-31')).toBe('1 Jan 2026 – 31 Dec 2026');
  });

  it('shows a measure with its unit where one was given', () => {
    expect(formatMeasure('25', 'orders')).toBe('25 orders');
    expect(formatMeasure('25', null)).toBe('25');
    expect(formatMeasure(null, 'orders')).toBe('—');
  });

  it('shows progress as current-of-target rather than as a ratio', () => {
    /*
      Deliberately not a percentage: the attainment figure is shown separately and
      may legitimately differ from the naive ratio. A baselined KPI at 25 of 30 from
      a baseline of 20 is 50% attained, and showing both numbers is how somebody
      sees why.
    */
    expect(formatTargetProgress('25', '30', '%')).toBe('25 % of 30 %');
    expect(formatTargetProgress(null, '30', null)).toBe('Target 30');
  });
});

describe('plan progress and overdue', () => {
  it('derives progress from the two server counts', () => {
    expect(planProgress(0, 4)).toBe(0);
    expect(planProgress(2, 4)).toBe(50);
    expect(planProgress(4, 4)).toBe(100);
  });

  it('returns 0 rather than dividing by zero on a plan with no actions', () => {
    expect(planProgress(0, 0)).toBe(0);
    expect(planProgress(3, 0)).toBe(0);
  });

  it('flags a past date and not a future one', () => {
    expect(isPerfOverdue('2026-10-01', '2026-10-12')).toBe(true);
    expect(isPerfOverdue('2026-10-12', '2026-10-12')).toBe(false);
    expect(isPerfOverdue('2026-10-20', '2026-10-12')).toBe(false);
    expect(isPerfOverdue(null, '2026-10-12')).toBe(false);
  });

  it('reads today at the company offset, not the viewer’s', () => {
    // 2026-10-12T19:00Z is already the 13th in IST (+5:30).
    expect(companyToday(new Date('2026-10-12T19:00:00.000Z'))).toBe('2026-10-13');
    expect(companyToday(new Date('2026-10-12T10:00:00.000Z'))).toBe('2026-10-12');
  });
});

describe('describeRatingGap', () => {
  it('names a disagreement in the direction the employee rated', () => {
    expect(describeRatingGap(4, 3)).toBe('You rated this 1 level higher');
    expect(describeRatingGap(2, 4)).toBe('You rated this 2 levels lower');
  });

  it('says nothing when the two agree', () => {
    expect(describeRatingGap(3, 3)).toBeNull();
  });

  it('says nothing when either side is absent', () => {
    // Including the case that matters: the manager has not shared theirs yet.
    expect(describeRatingGap(3, null)).toBeNull();
    expect(describeRatingGap(null, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  RULE 1 — a draft manager assessment never reaches its subject
// ---------------------------------------------------------------------------

describe('no frontend file can obtain a withheld manager assessment', () => {
  /*
    The security property of this phase's frontend. The server nulls
    `managerAssessment` for an employee whose manager has not submitted — so the
    only way the browser could show it is by fetching it some other way. These
    assertions are that no other way exists.
  */
  it('wraps exactly one endpoint that returns a review, and no assessment endpoint', () => {
    const api = executableCodeOf('lib/performance-api.ts');

    // The review reader exists…
    expect(api).toContain('/api/hr/performance/reviews/${id}');
    // …and nothing fetches an assessment, a rating or a draft separately.
    expect(api).not.toContain('manager-assessment');
    expect(api).not.toContain('self-assessment');
    expect(api).not.toContain('/ratings');
  });

  it('never reassembles a review from parts', () => {
    // Stitching the halves together in the browser would move Rule 1 into the tier
    // that cannot be trusted.
    const api = codeOf('lib/performance-api.ts');
    expect(api).toContain('already null');
  });

  it('renders the manager panel from review.managerAssessment and nothing else', () => {
    const panels = executableCodeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('review.managerAssessment');
    // No second source for it.
    expect(panels).not.toContain('fetchManagerAssessment');
    expect(panels).not.toContain('useEffect');
  });

  it('shows the subject a waiting state rather than an empty assessment', () => {
    const panels = codeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('has not shared their review yet');
  });

  it('withholds the manager’s per-competency ratings alongside the narrative', () => {
    /*
      Reading scores before the comments explaining them is the worst possible
      order, so the comparison panel is told whether the manager's half is visible
      and renders "Not shared yet" rather than a dash.
    */
    const panels = codeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('managerVisible');
    expect(panels).toContain('Not shared yet');
  });

  it('derives managerVisible from the record, not from the status', () => {
    /*
      `managerAssessment !== null` is the server's own filtering made visible.
      Inferring it from `status === 'PENDING_APPROVAL'` would be a second
      implementation of the rule, and the two could disagree.
    */
    const page = executableCodeOf('app/(app)/hr/performance/reviews/[id]/page.tsx');
    expect(page).toContain('review.managerAssessment !== null');
  });
});

// ---------------------------------------------------------------------------
//  Self-finalisation is not offered anywhere
// ---------------------------------------------------------------------------

describe('nothing in the UI offers self-finalisation', () => {
  it('gates the finalise control on the server’s own flag', () => {
    /*
      `viewerCan.finalize` is false for the subject whatever grants they hold —
      including an ADMIN with APPROVE. The page does not compute this; the server
      does, having refused the subject before consulting the grant.
    */
    const panels = executableCodeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('review.viewerCan.finalize');
  });

  it('never decides finalisability from a status or a role', () => {
    const panels = executableCodeOf('components/hr/review-panels.tsx');
    // No local reimplementation of the rule.
    expect(panels).not.toContain("role === 'ADMIN'");
    expect(panels).not.toContain('canApprove &&');
  });

  it('tells the subject why there is no button, rather than showing nothing', () => {
    // An ADMIN who is the subject holds APPROVE and would otherwise reasonably
    // wonder where the control went.
    const panels = codeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('Nobody approves their own review');
  });

  it('exposes no action that could stand in for a self-approval', () => {
    const actions = executableCodeOf('app/(app)/hr/performance-actions.ts');
    for (const forged of ['selfFinalize', 'approveOwn', 'forceFinalize']) {
      expect(actions, forged).not.toContain(forged);
    }
  });
});

// ---------------------------------------------------------------------------
//  Nothing in the browser computes a performance figure
// ---------------------------------------------------------------------------

describe('the browser computes no attainment, rating or review state', () => {
  it('never sends an attainment, percentage or score', () => {
    /*
      Phase 5's equivalent of Phase 4's forged score. `recordKpiProgressSchema` has
      no attainment field, and the server computes the figure from the value, the
      target, the baseline and the direction. This asserts the client never tries.
    */
    const actions = executableCodeOf('app/(app)/hr/performance-actions.ts');
    for (const forged of ['attainment:', 'percentage:', 'score:', 'isQualified:']) {
      expect(actions, forged).not.toContain(forged);
    }
  });

  it('sends only a measurement when recording progress', () => {
    const actions = codeOf('app/(app)/hr/performance-actions.ts');
    const fn = actions.slice(
      actions.indexOf('export async function recordProgressAction'),
      actions.indexOf('export async function saveSelfAssessmentAction'),
    );
    expect(fn).toContain('progress');
    expect(fn).not.toContain('attainment');
  });

  it('reads every attainment off the server’s own field', () => {
    const panels = executableCodeOf('components/hr/goal-panels.tsx');
    expect(panels).toContain('kpi.attainment');
    expect(panels).toContain('goal.attainment');
    // No local arithmetic on target and current.
    expect(panels).not.toContain('/ kpi.targetValue');
    expect(panels).not.toContain('Number(kpi.currentValue) /');
  });

  it('does not recompute a review’s overdue flags', () => {
    const tables = executableCodeOf('components/hr/performance-tables.tsx');
    expect(tables).toContain('isSelfAssessmentOverdue');
    expect(tables).toContain('isManagerReviewOverdue');
    expect(tables).not.toContain('new Date');
  });

  it('does not recompute a goal’s overdue flag', () => {
    const tables = executableCodeOf('components/hr/performance-tables.tsx');
    expect(tables).toContain('goal.isOverdue');
    expect(tables).not.toContain('isPerfOverdue');
  });
});

// ---------------------------------------------------------------------------
//  A finalized review is inert
// ---------------------------------------------------------------------------

describe('a finalised review renders as a record, not a form', () => {
  it('says it is locked rather than simply showing no controls', () => {
    /*
      "No buttons" and "something failed to load" look identical otherwise, and the
      record of who approved it and when is the point of the panel at that stage.
    */
    const panels = codeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('Finalised and locked');
    expect(panels).toContain('nobody can change this');
  });

  it('gates every write control on a server flag, so all of them vanish at once', () => {
    /*
      Every `viewerCan` field is false once the review is settled — the backend's
      `isReviewSettled` is consulted before anything else in each check. So the UI
      needs no FINALIZED special case of its own, and asserting the flags are what
      gate the controls is asserting the immutability holds.
    */
    const panels = executableCodeOf('components/hr/review-panels.tsx');
    for (const flag of [
      'viewerCan.editSelfAssessment',
      'viewerCan.submitSelfAssessment',
      'viewerCan.editManagerAssessment',
      'viewerCan.submitManagerAssessment',
      'viewerCan.finalize',
      'viewerCan.cancel',
    ]) {
      expect(panels, flag).toContain(flag);
    }
  });

  it('warns that finalising cannot be undone', () => {
    const panels = codeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('cannot be reopened');
  });
});

// ---------------------------------------------------------------------------
//  Thresholds and the rating scale stay configuration
// ---------------------------------------------------------------------------

describe('the goal thresholds are defaults, not rules', () => {
  it('states the business defaults once, in shared', () => {
    expect(DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD).toBe(100);
    expect(DEFAULT_GOAL_PARTIAL_THRESHOLD).toBe(50);
  });

  it('uses them only as placeholder text on the cycle form', () => {
    /*
      The form offers them as a hint and sends nothing when blank, so the column
      default applies. What must never happen is the browser comparing an attainment
      against 100 — the threshold that decides is the cycle's own, and only the
      server reads it.
    */
    const forms = executableCodeOf('components/hr/performance-forms.tsx');
    expect(forms).toContain('DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD');
    expect(forms).not.toContain('>= DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD');
    expect(forms).not.toContain('> DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD');
  });

  it('renders each cycle’s own thresholds on its page', () => {
    const page = executableCodeOf('app/(app)/hr/performance/cycles/[id]/page.tsx');
    expect(page).toContain('cycle.goalAchievementThreshold');
    expect(page).toContain('cycle.goalPartialThreshold');
    expect(page).not.toContain('DEFAULT_GOAL_ACHIEVEMENT_THRESHOLD');
  });
});

describe('the 1–5 rating scale is recorded as an implementation choice', () => {
  it('derives the rating controls from the shared constant', () => {
    /*
      Not a hard-coded [1,2,3,4,5] in the component. If a real requirement changes
      the scale, the constant and the CHECK change together and the UI follows.
    */
    const panels = executableCodeOf('components/hr/review-panels.tsx');
    expect(panels).toContain('COMPETENCY_RATINGS');
  });

  it('keeps the bounds in shared, matching the database CHECK', () => {
    expect(MIN_COMPETENCY_RATING).toBe(1);
    expect(MAX_COMPETENCY_RATING).toBe(5);
    expect(COMPETENCY_RATINGS).toHaveLength(5);
  });

  it('names the scale as unconfirmed in the labels file', () => {
    // So nobody reading the UI code mistakes it for a stated business rule.
    const labels = codeOf('components/hr/performance-labels.ts');
    expect(labels).toContain('implementation decision');
    expect(labels).toContain('PERFORMANCE-SCOPE.md');
  });
});

// ---------------------------------------------------------------------------
//  Scope and permission states
// ---------------------------------------------------------------------------

describe('scope and permission handling', () => {
  it('mirrors the backend’s employee floor on every employee-facing page', () => {
    /*
      Everybody is appraised, so gating these on the module would lock out the
      people the phase exists for. The floor is HR_PERFORMANCE:VIEW or
      HR_EMPLOYEE:VIEW, exactly as the route table has it.
    */
    for (const page of [
      'app/(app)/hr/performance/page.tsx',
      'app/(app)/hr/performance/my-review/page.tsx',
      'app/(app)/hr/performance/reviews/[id]/page.tsx',
      'app/(app)/hr/performance/goals/[id]/page.tsx',
      'app/(app)/hr/performance/plans/[id]/page.tsx',
    ]) {
      const source = executableCodeOf(page);
      expect(source, page).toContain("can(access.user, 'HR_PERFORMANCE', 'VIEW')");
      expect(source, page).toContain("can(access.user, 'HR_EMPLOYEE', 'VIEW')");
    }
  });

  it('renders a permission-denied state rather than an error for a blocked reader', () => {
    for (const page of EMPLOYEE_SURFACES.filter((p) => p.startsWith('app/'))) {
      expect(executableCodeOf(page), page).toContain('NoModuleAccess');
    }
  });

  it('gates cycle creation on CREATE and keeps the dashboard on the floor', () => {
    const dashboard = executableCodeOf('app/(app)/hr/performance/page.tsx');
    expect(dashboard).toContain("can(access.user, 'HR_PERFORMANCE', 'CREATE')");
    // The company-wide figures are for somebody holding the module, not every
    // employee — an employee scoped to themselves would otherwise see their own
    // single review reported as a company total.
    expect(dashboard).toContain('isAdministrator');
  });

  it('requests the cycle report only for somebody entitled to aggregate data', () => {
    /*
      `/cycles/:id/report` is gated on VIEW rather than the floor. Requesting it
      unconditionally and hiding the result would mean fetching data this reader may
      not have.
    */
    const page = executableCodeOf('app/(app)/hr/performance/cycles/[id]/page.tsx');
    expect(page).toContain('isAdministrator ? fetchCycleReport(id)');
  });

  it('reads "am I the subject" from the server on the review page', () => {
    /*
      This assertion replaces one that required the opposite, and the change is a
      correction rather than a relaxation.

      The old version demanded `employeeId === access.user.employeeId` — comparing
      the session's `User.employeeId` against `Employee.employeeId`. Those are
      different columns on different tables. They are drawn from one allocation
      series (`allocateEmployeeId` seeds from both) so they usually agree for a
      linked person, but linking an account does not sync them: an account created
      outside the HR flow can be linked to an employee whose code differs, and the
      comparison is then false for the actual subject.

      The browser-driven workflow test caught exactly that — the employee's own
      review rendered titled "Ulric Employee's review" with no self-assessment
      form. So the service now answers `viewerIsSubject` from `Employee.userId`
      against the actor's id, and the page reads it.
    */
    const source = executableCodeOf('app/(app)/hr/performance/reviews/[id]/page.tsx');
    expect(source).toContain('review.viewerIsSubject');
    expect(source, 'no code comparison left on this page').not.toContain(
      'access.user.employeeId',
    );
  });

  it('still compares by employee code where no server flag exists yet', () => {
    /*
      The goal and plan pages have no `viewerIsSubject` equivalent on their views, so
      they keep the code comparison — which is what Phase 3's probation page does
      too, with the same caveat documented there.

      It is a *courtesy* on those pages, not a boundary: the API refuses an owner
      editing their own target or authoring their own plan regardless, before
      consulting any permission. A false comparison there shows a control that then
      403s, which is a worse experience but not a security failure. Recorded as a
      known limitation rather than silently left.
    */
    for (const page of [
      'app/(app)/hr/performance/goals/[id]/page.tsx',
      'app/(app)/hr/performance/plans/[id]/page.tsx',
    ]) {
      const source = executableCodeOf(page);
      expect(source, page).toContain('employeeId === access.user.employeeId');
    }
  });

  it('shows real empty states rather than nothing', () => {
    const tables = codeOf('components/hr/performance-tables.tsx');
    expect(tables).toContain('EmptyState');
    expect(tables).toContain('No review cycles yet');
    expect(tables).toContain('No goals set');
    expect(tables).toContain('No development plans');
  });

  it('surfaces the API’s own message on every failed read', () => {
    // The backend's message names the real obstacle — a cycle with no
    // competencies, an unexplained override — which is more useful than anything
    // the page could invent.
    for (const page of EMPLOYEE_SURFACES.filter((p) => p.startsWith('app/'))) {
      expect(executableCodeOf(page), page).toContain('ErrorMessage');
    }
  });
});

// ---------------------------------------------------------------------------
//  The subject-may-tick asymmetry on plans
// ---------------------------------------------------------------------------

describe('development plans: the subject may tick actions but not write the plan', () => {
  it('passes the two capabilities separately', () => {
    /*
      Doing the things a plan asks for is the subject's work; requiring a manager to
      record each one would make the plan a tracking burden rather than a support.
      They still cannot add, remove or reword an action.
    */
    const panels = executableCodeOf('components/hr/plan-panels.tsx');
    expect(panels).toContain('canManage');
    expect(panels).toContain('canTickActions');
  });

  it('withholds management from the subject on the plan page', () => {
    const page = executableCodeOf('app/(app)/hr/performance/plans/[id]/page.tsx');
    expect(page).toContain('canManage={!isSubject}');
    expect(page).toContain('canTickActions');
  });

  it('keeps an abandoned plan on the record rather than deleting it', () => {
    const panels = codeOf('components/hr/plan-panels.tsx');
    expect(panels).toContain('stays on the record');
  });
});
