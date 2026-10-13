/**
 * The HR Phase 3 frontend, asserted without a DOM.
 *
 * Two kinds of test, matching the convention in this directory:
 *
 *   1. **Pure logic**, called directly — label maps, date and figure formatting,
 *      progress and overdue arithmetic. All exported from `recruitment-labels.ts`
 *      precisely so they can be tested as functions rather than through a render.
 *   2. **Structural assertions** over the source, for properties about *what the
 *      components do not do*: not copying the ATS transition map, not computing
 *      an employee number, not generating a credential, not rendering a document
 *      URL, not filtering interview feedback client-side. None of those is
 *      observable from rendered output — a page that holds a second copy of the
 *      transition rules renders perfectly well right up until the two disagree.
 *
 * The structural half matters more here than in either earlier phase, because
 * Phase 3's riskiest properties are all absences: the confidentiality narrowing
 * happens server-side, and the only way to assert "the browser never held this"
 * is to assert the browser never asks for it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STAGES,
  APPLICATION_STATUSES,
  ASSESSMENT_STATUSES,
  BACKGROUND_CHECK_STATUSES,
  BACKGROUND_CHECK_TYPES,
  CANDIDATE_SOURCES,
  DOCUMENT_VERIFICATION_STATUSES,
  INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_STATUSES,
  INTERVIEW_TYPES,
  JOB_PRIORITIES,
  JOB_REQUISITION_STATUSES,
  OFFER_STATUSES,
  ONBOARDING_STAGES,
  ONBOARDING_TASK_CATEGORIES,
  ONBOARDING_TASK_STATUSES,
  PROBATION_DECISIONS,
  PROBATION_REVIEW_STATUSES,
  PROBATION_REVIEW_TYPES,
  PROBATION_STATUSES,
  canMoveStage,
  nextStages,
} from '@rs/shared';
import {
  APPLICATION_STAGE_LABELS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TONES,
  ASSESSMENT_STATUS_LABELS,
  ASSESSMENT_STATUS_TONES,
  BACKGROUND_CHECK_STATUS_LABELS,
  BACKGROUND_CHECK_STATUS_TONES,
  BACKGROUND_CHECK_TYPE_LABELS,
  CANDIDATE_SOURCE_LABELS,
  COMMITTING_STAGES,
  DOCUMENT_VERIFICATION_TONES,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_STATUS_TONES,
  INTERVIEW_TYPE_LABELS,
  JOB_PRIORITY_LABELS,
  JOB_PRIORITY_TONES,
  JOB_STATUS_LABELS,
  JOB_STATUS_TONES,
  OFFER_STATUS_LABELS,
  OFFER_STATUS_TONES,
  ONBOARDING_STAGE_LABELS,
  ONBOARDING_TASK_CATEGORY_LABELS,
  ONBOARDING_TASK_STATUS_LABELS,
  ONBOARDING_TASK_STATUS_TONES,
  PROBATION_DECISION_LABELS,
  PROBATION_REVIEW_STATUS_LABELS,
  PROBATION_REVIEW_STATUS_TONES,
  PROBATION_REVIEW_TYPE_LABELS,
  PROBATION_STATUS_LABELS,
  PROBATION_STATUS_TONES,
  RECOMMENDATION_LABELS,
  RECOMMENDATION_TONES,
  formatDay,
  formatExperience,
  formatPackage,
  formatRange,
  formatScore,
  isCommittingStage,
  isOverdue,
  progressPercent,
} from '@/components/hr/recruitment-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by every "this does not do X" assertion below: these files *document*
 * what they deliberately omit, so a naive substring search matches the comment
 * explaining the absence and fails a correct file. Learned the hard way in the
 * Phase 1 suite.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

describe('every Phase 3 enum value has a label', () => {
  /*
    The failure this prevents: `LABELS[value]` returns undefined for a value nobody
    added, and React renders nothing — so a status silently disappears from a board
    rather than erroring anywhere. With nineteen new enums that is a real risk.
  */
  it('covers requisition statuses and priorities, with a tone each', () => {
    for (const status of JOB_REQUISITION_STATUSES) {
      expect(JOB_STATUS_LABELS[status], status).toBeTruthy();
      expect(JOB_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const priority of JOB_PRIORITIES) {
      expect(JOB_PRIORITY_LABELS[priority], priority).toBeTruthy();
      expect(JOB_PRIORITY_TONES[priority], priority).toBeTruthy();
    }
  });

  it('covers every pipeline stage', () => {
    for (const stage of APPLICATION_STAGES) {
      expect(APPLICATION_STAGE_LABELS[stage], stage).toBeTruthy();
    }
  });

  it('covers application statuses, with a tone each', () => {
    for (const status of APPLICATION_STATUSES) {
      expect(APPLICATION_STATUS_LABELS[status], status).toBeTruthy();
      expect(APPLICATION_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('covers candidate sources', () => {
    for (const source of CANDIDATE_SOURCES) {
      expect(CANDIDATE_SOURCE_LABELS[source], source).toBeTruthy();
    }
  });

  it('covers interview types, statuses and recommendations', () => {
    for (const type of INTERVIEW_TYPES) {
      expect(INTERVIEW_TYPE_LABELS[type], type).toBeTruthy();
    }
    for (const status of INTERVIEW_STATUSES) {
      expect(INTERVIEW_STATUS_LABELS[status], status).toBeTruthy();
      expect(INTERVIEW_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const recommendation of INTERVIEW_RECOMMENDATIONS) {
      expect(RECOMMENDATION_LABELS[recommendation], recommendation).toBeTruthy();
      expect(RECOMMENDATION_TONES[recommendation], recommendation).toBeTruthy();
    }
  });

  it('covers assessment, offer and verification vocabulary', () => {
    for (const status of ASSESSMENT_STATUSES) {
      expect(ASSESSMENT_STATUS_LABELS[status], status).toBeTruthy();
      expect(ASSESSMENT_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const status of OFFER_STATUSES) {
      expect(OFFER_STATUS_LABELS[status], status).toBeTruthy();
      expect(OFFER_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const type of BACKGROUND_CHECK_TYPES) {
      expect(BACKGROUND_CHECK_TYPE_LABELS[type], type).toBeTruthy();
    }
    for (const status of BACKGROUND_CHECK_STATUSES) {
      expect(BACKGROUND_CHECK_STATUS_LABELS[status], status).toBeTruthy();
      expect(BACKGROUND_CHECK_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const status of DOCUMENT_VERIFICATION_STATUSES) {
      expect(DOCUMENT_VERIFICATION_TONES[status], status).toBeTruthy();
    }
  });

  it('covers every onboarding stage and task vocabulary', () => {
    for (const stage of ONBOARDING_STAGES) {
      expect(ONBOARDING_STAGE_LABELS[stage], stage).toBeTruthy();
    }
    for (const status of ONBOARDING_TASK_STATUSES) {
      expect(ONBOARDING_TASK_STATUS_LABELS[status], status).toBeTruthy();
      expect(ONBOARDING_TASK_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const category of ONBOARDING_TASK_CATEGORIES) {
      expect(ONBOARDING_TASK_CATEGORY_LABELS[category], category).toBeTruthy();
    }
  });

  it('covers probation vocabulary', () => {
    for (const status of PROBATION_STATUSES) {
      expect(PROBATION_STATUS_LABELS[status], status).toBeTruthy();
      expect(PROBATION_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const type of PROBATION_REVIEW_TYPES) {
      expect(PROBATION_REVIEW_TYPE_LABELS[type], type).toBeTruthy();
    }
    for (const status of PROBATION_REVIEW_STATUSES) {
      expect(PROBATION_REVIEW_STATUS_LABELS[status], status).toBeTruthy();
      expect(PROBATION_REVIEW_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const decision of PROBATION_DECISIONS) {
      expect(PROBATION_DECISION_LABELS[decision], decision).toBeTruthy();
    }
  });
});

describe('labels say who did what', () => {
  /*
    These three wordings are not cosmetic. Each one is the difference between the
    record reading back truthfully and reading back as an accusation.
  */
  it('calls a declined offer "Declined", not "Rejected"', () => {
    // The enum value is REJECTED for symmetry with the application status, but an
    // offer is refused by the *candidate* — "Rejected" would suggest the business
    // turned them down, which is the opposite of what happened.
    expect(OFFER_STATUS_LABELS.REJECTED).toBe('Declined');
  });

  it('keeps withdrawal and decline neutral rather than critical', () => {
    // Both are the candidate's decision rather than a judgement about them.
    expect(APPLICATION_STATUS_TONES.WITHDRAWN).toBe('neutral');
    expect(APPLICATION_STATUS_TONES.DECLINED).toBe('neutral');
    expect(APPLICATION_STATUS_TONES.REJECTED).toBe('critical');
  });

  it('keeps a skipped onboarding task visible as an exception', () => {
    // A skipped task carries a required reason and should not fade into the
    // completed rows: a checklist of greens where half were skipped tells the
    // reader nothing.
    expect(ONBOARDING_TASK_STATUS_TONES.SKIPPED).toBe('warning');
    expect(ONBOARDING_TASK_STATUS_TONES.COMPLETED).toBe('positive');
  });

  it('reads a published role as "Open"', () => {
    // What a recruiter cares about is whether applications are being accepted, not
    // whether a publish button was pressed.
    expect(JOB_STATUS_LABELS.PUBLISHED).toBe('Open');
    expect(JOB_STATUS_TONES.PUBLISHED).toBe('positive');
  });
});

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

describe('formatDay reads the date string directly', () => {
  /*
    The bug this prevents: `new Date('2026-03-01')` is midnight UTC, which is the
    *previous* day for anybody west of Greenwich and 05:30 on the 1st in IST. A
    joining date shown as the wrong day is the classic timezone defect, and the fix
    is to never construct a Date from a calendar day at all.
  */
  it('formats a calendar day without constructing a Date', () => {
    expect(formatDay('2026-03-01')).toBe('1 Mar 2026');
    expect(formatDay('2026-12-31')).toBe('31 Dec 2026');
  });

  it('tolerates a full ISO instant by taking only the day part', () => {
    expect(formatDay('2026-07-04T18:30:00.000Z')).toBe('4 Jul 2026');
  });

  it('shows a dash for an absent or malformed value', () => {
    expect(formatDay(null)).toBe('—');
    expect(formatDay('')).toBe('—');
    expect(formatDay('nonsense')).toBe('—');
  });

  it('never parses the day through Date', () => {
    // Asserted structurally because it is the whole point: a future edit that
    // "simplified" this to toLocaleDateString would reintroduce the defect.
    const code = executableCodeOf('components/hr/recruitment-labels.ts');
    const formatDayBody = code.slice(
      code.indexOf('export function formatDay'),
      code.indexOf('export function formatMoment'),
    );
    expect(formatDayBody).not.toContain('new Date');
  });
});

describe('figures are formatted, never computed', () => {
  it('formats a package with its currency', () => {
    expect(formatPackage('850000', 'INR')).toBe('INR 8,50,000');
    expect(formatPackage('850000', null)).toBe('INR 8,50,000');
  });

  it('shows a dash when a figure is absent, whatever the reason', () => {
    /*
      Two different cases deliberately look the same: no figure was recorded, and
      the reader is not entitled to see it. The server nulls the second before it
      reaches here, so this function cannot tell them apart — which is correct.
    */
    expect(formatPackage(null, 'INR')).toBe('—');
  });

  it('formats a range, or a single bound when only one is set', () => {
    // The currency is named once, not on both bounds: "INR 5,00,000 – INR 8,00,000"
    // reads as two separate figures rather than as one range.
    expect(formatRange('500000', '800000', 'INR')).toBe('INR 5,00,000 – 8,00,000');
    expect(formatRange('500000', null, 'INR')).toBe('INR 5,00,000');
    expect(formatRange(null, null, 'INR')).toBe('—');
  });

  it('refuses to show a score with no maximum', () => {
    // A bare score is a number nobody can interpret — paired with the
    // assessment_score_within_max CHECK on the other side.
    expect(formatScore('18', '20')).toBe('18 / 20');
    expect(formatScore('18', null)).toBe('—');
    expect(formatScore(null, '20')).toBe('—');
  });

  it('calls zero years a fresher rather than "0 years"', () => {
    expect(formatExperience('0')).toBe('Fresher');
    expect(formatExperience('1')).toBe('1 year');
    expect(formatExperience('4.5')).toBe('4.5 years');
    expect(formatExperience(null)).toBe('—');
  });
});

describe('progress and overdue arithmetic', () => {
  it('computes progress from the two server counts', () => {
    expect(progressPercent(0, 7)).toBe(0);
    expect(progressPercent(7, 7)).toBe(100);
    expect(progressPercent(3, 7)).toBe(43);
  });

  it('returns zero rather than NaN for an empty checklist', () => {
    // A division by zero would render "NaN%", which is how a progress bar tells
    // somebody their data is broken when in fact the checklist is simply empty.
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(3, 0)).toBe(0);
  });

  it('judges overdue against a supplied day, not the clock', () => {
    /*
      The reference day is a parameter so this is testable without freezing time —
      and so the caller can pass the *company-time* day. A colleague abroad must
      not see a task flagged overdue a day early.
    */
    expect(isOverdue('2026-03-01', '2026-03-02')).toBe(true);
    expect(isOverdue('2026-03-02', '2026-03-02')).toBe(false);
    expect(isOverdue('2026-03-03', '2026-03-02')).toBe(false);
    expect(isOverdue(null, '2026-03-02')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The transition map is the server's
// ---------------------------------------------------------------------------

describe('the frontend holds no copy of the ATS transition rules', () => {
  /*
    The most important structural property in this phase.

    `availableStages` arrives on every application from the backend's own map. A
    second copy in the browser would eventually disagree, and the disagreement
    would show up either as a button that silently fails or — far worse — as a
    commit point quietly skipped.
  */
  it('reads availableStages from the payload rather than computing it', () => {
    const code = executableCodeOf('components/hr/ats-pipeline.tsx');
    expect(code).toContain('application.availableStages');
  });

  it('never imports the transition helpers into a component', () => {
    for (const file of [
      'components/hr/ats-pipeline.tsx',
      'components/hr/candidate-table.tsx',
      'app/(app)/hr/recruitment/applications/[id]/page.tsx',
    ]) {
      const code = executableCodeOf(file);
      expect(code, file).not.toContain('canMoveStage');
      expect(code, file).not.toContain('nextStages(');
    }
  });

  it('offers no drag-and-drop stage change', () => {
    /*
      A board you drag cards across implies every column is reachable from every
      other. Three stages in this pipeline are points where a human commits the
      business, and those must not be reachable by a slip of the mouse.
    */
    const code = executableCodeOf('components/hr/ats-pipeline.tsx');
    for (const handler of ['onDragStart', 'onDragOver', 'onDrop', 'draggable']) {
      expect(code, handler).not.toContain(handler);
    }
  });

  it('agrees with the shared map about which stages commit the business', () => {
    // The UI copy exists only to decide whether to ask "are you sure". It must
    // still name the same three stages the server treats as commit points.
    expect([...COMMITTING_STAGES].sort()).toEqual(['JOINED', 'OFFER_ACCEPTED', 'SELECTED']);
    for (const stage of COMMITTING_STAGES) {
      expect(isCommittingStage(stage), stage).toBe(true);
    }
    expect(isCommittingStage('SCREENING')).toBe(false);
  });

  it('confirms the shared map still refuses a skip over a commit point', () => {
    /*
      Not a frontend assertion as such — it guards the assumption the UI rests on.
      If SHORTLISTED ever became able to reach OFFER directly, the confirmation
      dialog above would be the only thing between a misclick and an offer nobody
      decided to make.
    */
    expect(canMoveStage('SHORTLISTED', 'OFFER')).toBe(false);
    expect(canMoveStage('SELECTED', 'OFFER')).toBe(true);
    expect(nextStages('JOINED')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  Confidentiality
// ---------------------------------------------------------------------------

describe('interview feedback is filtered server-side only', () => {
  /*
    An interviewer must not read the panel's other feedback before giving their
    own — the reason structured interviewing works. A client-side filter would mean
    the restricted entries had already been sent to a browser where anybody can
    read them in a network tab.
  */
  it('renders the feedback it was given without filtering by author', () => {
    const code = executableCodeOf('components/hr/interview-panel.tsx');
    expect(code).toContain('interview.feedback');
    // No author comparison anywhere: the server decided which entries to send.
    expect(code).not.toContain('feedbackVisibility');
  });

  it('explains why the panel may be hidden rather than showing an empty section', () => {
    // Without the notice, an empty list reads as "nobody has reported yet", which
    // is a different and misleading fact.
    const code = codeOf('components/hr/interview-panel.tsx');
    expect(code).toContain('feedbackPending');
    expect(code).toMatch(/until you submit your own/i);
  });
});

describe('candidate documents expose no URL', () => {
  /*
    A stored link outlives every access check and cannot be revoked — exactly how
    MediaAsset became publicly fetchable. Links are minted per request, signed and
    short-lived, so the view type carries an id and no URL at all.
  */
  it('never renders a document href or src', () => {
    const code = executableCodeOf('app/(app)/hr/recruitment/candidates/[id]/page.tsx');
    expect(code).not.toContain('document.url');
    expect(code).not.toContain('secureUrl');
    expect(code).not.toContain('MediaAsset');
  });

  it('says why no download link is offered', () => {
    const code = codeOf('app/(app)/hr/recruitment/candidates/[id]/page.tsx');
    expect(code).toMatch(/Links are issued on request and\s*\n?\s*expire/i);
  });
});

describe('the API client asks for nothing it should not hold', () => {
  it('has no writers at all', () => {
    /*
      Mutations go through server actions, so the session token never reaches the
      browser. A POST here would be a second path to the API with different
      credentials handling.
    */
    const code = executableCodeOf('lib/recruitment-api.ts');
    expect(code).not.toContain("method: 'POST'");
    expect(code).not.toContain("method: 'PATCH'");
    expect(code).not.toContain("method: 'DELETE'");
  });

  it('fetches verification results through their own endpoint', () => {
    // Separate from the application read because the permission is different: the
    // detail arrives with an empty array for an unentitled reader, and this
    // endpoint 403s for the same reader.
    const code = executableCodeOf('lib/recruitment-api.ts');
    expect(code).toContain('background-checks');
  });
});

// ---------------------------------------------------------------------------
//  Employee creation
// ---------------------------------------------------------------------------

describe('onboarding creates no second employee identity', () => {
  /*
    The highest-consequence write in the phase. Everything about its shape is about
    not doing it twice, and about not inventing a parallel identity scheme.
  */
  it('sends no employee number', () => {
    const action = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');

    // No allocation, no generation, no field to pass one.
    for (const code of [action, panel]) {
      expect(code).not.toContain('allocateEmployeeId');
      expect(code).not.toMatch(/employeeId:\s*[`'"]/);
    }
    // The form asks for the three things that are genuinely missing, and no more.
    expect(panel).toContain('workEmail');
  });

  it('generates no credential and sends no password', () => {
    /*
      There is no secure invitation flow in this codebase — no token table, no
      expiry, no first-password journey. The obvious shortcuts are all worse than
      not doing it, so the ACCOUNT stage surfaces the existing link operation
      instead.
    */
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');
    const action = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    for (const code of [panel, action]) {
      expect(code).not.toContain('password');
      expect(code).not.toContain('invite');
      expect(code).not.toContain('randomBytes');
    }
  });

  it('tells the user account linking is a separate step', () => {
    // Stated where somebody will act on it rather than buried in a release note.
    const panel = codeOf('components/hr/onboarding-panel.tsx');
    expect(panel).toMatch(/Account linking is a separate step/i);
  });

  it('follows the server on whether the record can be created', () => {
    // `canCreateEmployee` accounts for the record already existing and for an
    // adverse background check. A button the API would refuse is worse than none.
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');
    expect(panel).toContain('canCreateEmployee');
  });

  it('computes no stage list of its own', () => {
    /*
      The hinge is crossed by creating the employment record, not by ticking a box —
      and the guard that enforces it lives in the *backend*
      (`availableOnboardingStages` in onboarding.service.ts, which returns [] when
      the next stage is EMPLOYEE_CREATED).

      So the right property to assert here is the absence of a client-side copy:
      the panel reads `onboarding.availableStages` and holds no stage ordering of
      its own. A local version would eventually disagree with the server's, and the
      disagreement would let somebody mark the hinge passed with no Employee behind
      it — after which the CHECK pair refuses every later advance with a confusing
      error.
    */
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');
    expect(panel).toContain('onboarding.availableStages');
    // No local ordering logic: ONBOARDING_STAGES is used only to render the track.
    expect(panel).not.toContain('indexOf(stage) + 1');
    expect(panel).not.toContain('ONBOARDING_STAGES[index + 1]');
  });
});

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

describe('probation termination does not end an employment', () => {
  /*
    The most important restraint in the probation UI. A TERMINATE decision records
    the decision; setting Employee.status to EXITED is a Phase 1 operation with its
    own exit-date requirement and its own history entry. Doing it from here would
    end somebody's employment with no leaving date and nothing in their timeline.
  */
  it('never sets an employee status', () => {
    const panel = executableCodeOf('components/hr/probation-panel.tsx');
    const action = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    for (const code of [panel, action]) {
      expect(code).not.toContain('EXITED');
      expect(code).not.toContain('changeEmployeeStatus');
    }
  });

  it('warns that the decision is recorded only', () => {
    const panel = codeOf('components/hr/probation-panel.tsx');
    expect(panel).toMatch(/does not\s*\n?\s*end the employment/i);
  });

  it('requires a reason for every decision', () => {
    // Required here, by Zod, by the service and by a CHECK, because this is the
    // record an employment dispute turns on.
    const panel = executableCodeOf('components/hr/probation-panel.tsx');
    expect(panel).toContain('reason.trim().length < 5');
  });

  it('requires a new end date only for an extension', () => {
    const panel = executableCodeOf('components/hr/probation-panel.tsx');
    expect(panel).toContain("decision === 'EXTEND' && !newEndDate");
    expect(panel).toContain('newEndDate <= probation.endDate');
  });
});

// ---------------------------------------------------------------------------
//  Rejection and refusal always carry a reason
// ---------------------------------------------------------------------------

describe('every refusal says why', () => {
  /*
    "We decided not to proceed" with nothing recorded is the single commonest
    complaint about any hiring process, and it is unanswerable months later. Each
    of these is enforced again by Zod and most by a database CHECK.
  */
  it('refuses to reject an application without a reason', () => {
    const code = executableCodeOf('components/hr/ats-pipeline.tsx');
    expect(code).toContain('reason.trim().length < 5');
  });

  it('refuses to decline or withdraw an offer without a note', () => {
    const code = executableCodeOf('components/hr/offer-panel.tsx');
    expect(code).toContain("status !== 'ACCEPTED' && note.trim().length < 5");
  });

  it('refuses to skip or block an onboarding task without a note', () => {
    const code = executableCodeOf('components/hr/onboarding-panel.tsx');
    expect(code).toContain("status === 'SKIPPED' || status === 'BLOCKED'");
  });

  it('refuses to cancel an interview or record a no-show without a reason', () => {
    const code = executableCodeOf('components/hr/interview-panel.tsx');
    expect(code).toContain('reason.trim().length < 5');
  });
});

// ---------------------------------------------------------------------------
//  No payroll anywhere
// ---------------------------------------------------------------------------

describe('Phase 3 stores and shows no pay detail', () => {
  /*
    `annualPackage` and the advertised range are informational — what was
    communicated — so a later Payroll phase has a documented starting point. There
    is no account number, tax identifier or deduction anywhere in the phase.
  */
  it('has no bank, tax or deduction field in any Phase 3 component', () => {
    for (const file of [
      'components/hr/offer-panel.tsx',
      'components/hr/recruitment-forms.tsx',
      'components/hr/job-table.tsx',
      'app/(app)/hr/recruitment/jobs/[id]/page.tsx',
    ]) {
      const code = executableCodeOf(file);
      for (const banned of ['bankAccount', 'ifsc', 'panNumber', 'taxId', 'deduction', 'payslip']) {
        expect(code, `${file}: ${banned}`).not.toContain(banned);
      }
    }
  });

  it('keeps the salary range off the requisition list', () => {
    // A list is scanned to find a role, not to compare pay — and the server strips
    // the figures for anybody without the module, so the column could not be
    // trusted to be present anyway.
    const code = executableCodeOf('components/hr/job-table.tsx');
    expect(code).not.toContain('salaryRange');
  });
});

// ---------------------------------------------------------------------------
//  Server actions relay rather than decide
// ---------------------------------------------------------------------------

describe('the server actions decide nothing', () => {
  it('relays the backend message verbatim on failure', () => {
    const code = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    expect(code).toContain('message: result.message');
  });

  it('revalidates the dashboard on writes that change its counts', () => {
    // The recruitment landing counts jobs, applications, interviews and offers, so
    // nearly every write here changes it — not only the page somebody is looking at.
    const code = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    expect(code).toContain("'/hr/recruitment'");
  });

  it('auto-rejects nothing on an adverse background check', () => {
    /*
      A flagged check blocks employee creation and a person then decides. A UI that
      auto-rejected would be adding a consequence the API deliberately withheld —
      a database row must not end somebody's prospects unilaterally.
    */
    const code = executableCodeOf('app/(app)/hr/recruitment-actions.ts');
    const body = code.slice(code.indexOf('recordBackgroundCheckAction'));
    expect(body).not.toContain('rejectApplication');
  });
});
