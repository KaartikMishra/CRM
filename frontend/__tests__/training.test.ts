/**
 * The HR Phase 4 frontend, asserted without a DOM.
 *
 * Two kinds of test, matching the convention in this directory:
 *
 *   1. **Pure logic**, called directly — label maps, formatting, progress and
 *      overdue arithmetic. All exported from `training-labels.ts` precisely so
 *      they can be tested as functions rather than through a render.
 *   2. **Structural assertions** over the source, for properties about *what the
 *      components do not do*.
 *
 * The structural half carries most of the weight here, because Phase 4's riskiest
 * properties are all absences:
 *
 *   - no learner-facing surface may hold an answer key
 *   - no browser may compute a score, a pass/fail, a stage gate or a qualification
 *   - no request may carry a claimed score
 *
 * None of those is observable from rendered output. A page that computes its own
 * pass mark renders perfectly well right up until it disagrees with the server —
 * and on this module a disagreement means somebody doing live customer work they
 * were not cleared for. So the assertion is that the code never asks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_QUESTION_KINDS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PASSING_SCORE,
  PRACTICAL_SUBMISSION_STATUSES,
  REQUIRED_JOURNEY_TEMPLATE,
  SHADOWING_STATUSES,
  TRAINING_ASSIGNMENT_SOURCES,
  TRAINING_ATTEMPT_STATUSES,
  TRAINING_ENROLLMENT_STATUSES,
  TRAINING_MODULE_KINDS,
  TRAINING_OBLIGATIONS,
  TRAINING_PROGRAM_STATUSES,
} from '@rs/shared';
import {
  ASSIGNMENT_SOURCE_LABELS,
  ATTEMPT_STATUS_LABELS,
  ATTEMPT_STATUS_TONES,
  ENROLLMENT_STATUS_LABELS,
  ENROLLMENT_STATUS_TONES,
  MODULE_COMPLETION_HINTS,
  MODULE_KIND_LABELS,
  OBLIGATION_LABELS,
  OBLIGATION_TONES,
  PRACTICAL_STATUS_LABELS,
  PRACTICAL_STATUS_TONES,
  PROGRAM_STATUS_LABELS,
  PROGRAM_STATUS_TONES,
  QUALIFICATION_GAP_LABELS,
  QUESTION_KIND_HINTS,
  QUESTION_KIND_LABELS,
  SHADOWING_STATUS_LABELS,
  SHADOWING_STATUS_TONES,
  companyToday,
  describeAttempts,
  formatDuration,
  formatPercent,
  formatScoreOf,
  formatTrainingDay,
  isTrainingOverdue,
  trainingProgress,
} from '@/components/hr/training-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by every "this does not do X" assertion below: these files *document* what
 * they deliberately omit, so a naive substring search matches the comment explaining
 * the absence and fails a correct file.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every learner-reachable file. The answer-key assertions run over all of them. */
const LEARNER_SURFACES = [
  'components/hr/assessment-runner.tsx',
  'components/hr/learning-journey.tsx',
  'components/hr/training-tables.tsx',
  'components/hr/training-review-panels.tsx',
  'app/(app)/hr/training/my-learning/page.tsx',
  'app/(app)/hr/training/learn/[id]/page.tsx',
  'app/(app)/hr/training/reviews/page.tsx',
] as const;

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

describe('every Phase 4 enum value has a label', () => {
  /*
    The failure this prevents: `LABELS[value]` returns undefined for a value nobody
    added, and React renders nothing — so a status silently disappears from a board
    rather than erroring anywhere.
  */
  it('covers program statuses and obligations, with a tone each', () => {
    for (const status of TRAINING_PROGRAM_STATUSES) {
      expect(PROGRAM_STATUS_LABELS[status], status).toBeTruthy();
      expect(PROGRAM_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const obligation of TRAINING_OBLIGATIONS) {
      expect(OBLIGATION_LABELS[obligation], obligation).toBeTruthy();
      expect(OBLIGATION_TONES[obligation], obligation).toBeTruthy();
    }
  });

  it('covers module kinds, and says how each one is completed', () => {
    for (const kind of TRAINING_MODULE_KINDS) {
      expect(MODULE_KIND_LABELS[kind], kind).toBeTruthy();
      expect(MODULE_COMPLETION_HINTS[kind], kind).toBeTruthy();
    }
  });

  it('covers enrollment statuses and assignment sources', () => {
    for (const status of TRAINING_ENROLLMENT_STATUSES) {
      expect(ENROLLMENT_STATUS_LABELS[status], status).toBeTruthy();
      expect(ENROLLMENT_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const source of TRAINING_ASSIGNMENT_SOURCES) {
      expect(ASSIGNMENT_SOURCE_LABELS[source], source).toBeTruthy();
    }
  });

  it('covers question kinds, attempt statuses, practicals and shadowing', () => {
    for (const kind of ASSESSMENT_QUESTION_KINDS) {
      expect(QUESTION_KIND_LABELS[kind], kind).toBeTruthy();
      expect(QUESTION_KIND_HINTS[kind], kind).toBeTruthy();
    }
    for (const status of TRAINING_ATTEMPT_STATUSES) {
      expect(ATTEMPT_STATUS_LABELS[status], status).toBeTruthy();
      expect(ATTEMPT_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const status of PRACTICAL_SUBMISSION_STATUSES) {
      expect(PRACTICAL_STATUS_LABELS[status], status).toBeTruthy();
      expect(PRACTICAL_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const status of SHADOWING_STATUSES) {
      expect(SHADOWING_STATUS_LABELS[status], status).toBeTruthy();
      expect(SHADOWING_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('names every kind of qualification gap the server can report', () => {
    /*
      The gap kinds are a union on the type rather than a runtime array, so this
      lists them. An added kind with no label would render an empty heading above a
      sentence — the one place a missing label is nearly invisible, because the
      server's `detail` still shows.
    */
    for (const kind of [
      'REQUIRED_MODULE_INCOMPLETE',
      'ASSESSMENT_NOT_PASSED',
      'PRACTICAL_NOT_APPROVED',
      'SHADOWING_NOT_SIGNED_OFF',
      'FINAL_ASSESSMENT_NOT_PASSED',
      'ALREADY_QUALIFIED',
    ] as const) {
      expect(QUALIFICATION_GAP_LABELS[kind], kind).toBeTruthy();
    }
  });

  it('reads ACTIVE as "Open", because assignability is what a trainer asks', () => {
    expect(PROGRAM_STATUS_LABELS.ACTIVE).toBe('Open');
    expect(PROGRAM_STATUS_TONES.ACTIVE).toBe('positive');
  });
});

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

describe('formatting does no arithmetic on a score', () => {
  it('renders a decimal string percentage without recomputing it', () => {
    expect(formatPercent('80.00')).toBe('80%');
    expect(formatPercent('79.50')).toBe('79.5%');
    expect(formatPercent('100.00')).toBe('100%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent('not a number')).toBe('—');
  });

  it('shows a score only against its maximum', () => {
    expect(formatScoreOf('8.00', '10.00')).toBe('8 / 10');
    // A bare score cannot be read, so neither half renders alone.
    expect(formatScoreOf('8.00', null)).toBe('—');
    expect(formatScoreOf(null, '10.00')).toBe('—');
  });

  it('formats a day without constructing a Date, so no timezone shifts it', () => {
    expect(formatTrainingDay('2026-10-09')).toBe('9 Oct 2026');
    expect(formatTrainingDay('2026-01-31T00:00:00.000Z')).toBe('31 Jan 2026');
    expect(formatTrainingDay(null)).toBe('—');
    expect(formatTrainingDay('nonsense')).toBe('—');
  });

  it('never calls new Date in the day formatter', () => {
    /*
      The whole point of the string-splitting implementation: `new Date('2026-10-09')`
      parses as UTC midnight and renders as the 8th in any timezone behind UTC. A
      due date one day early is the kind of bug nobody reports and everybody works
      around.
    */
    const source = executableCodeOf('components/hr/training-labels.ts');
    const dayFn = source.slice(
      source.indexOf('export function formatTrainingDay'),
      source.indexOf('export function formatTrainingMoment'),
    );
    expect(dayFn).not.toContain('new Date');
  });

  it('writes a duration the way somebody would say it', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 hr');
    expect(formatDuration(90)).toBe('1 hr 30 min');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('progress and attempts', () => {
  it('derives progress from the two server counts', () => {
    expect(trainingProgress(0, 13)).toBe(0);
    expect(trainingProgress(13, 13)).toBe(100);
    expect(trainingProgress(1, 3)).toBe(33);
  });

  it('returns 0 rather than dividing by zero on a program with no required steps', () => {
    expect(trainingProgress(0, 0)).toBe(0);
    expect(trainingProgress(5, 0)).toBe(0);
  });

  it('says "no attempts left" as a state rather than a quantity', () => {
    expect(describeAttempts(3, 0, 3)).toBe('No attempts left (used 3 of 3)');
    expect(describeAttempts(0, 3, 3)).toBe('3 attempts available');
    expect(describeAttempts(1, 2, 3)).toBe('2 of 3 attempts left');
    expect(describeAttempts(0, 1, 1)).toBe('1 attempt available');
  });
});

describe('overdue is decided against company time, and never for settled work', () => {
  it('flags a past due date on live work', () => {
    expect(isTrainingOverdue('2026-10-01', '2026-10-09', 'IN_PROGRESS')).toBe(true);
    expect(isTrainingOverdue('2026-10-01', '2026-10-09', 'NOT_STARTED')).toBe(true);
  });

  it('does not flag work due today or later', () => {
    expect(isTrainingOverdue('2026-10-09', '2026-10-09', 'IN_PROGRESS')).toBe(false);
    expect(isTrainingOverdue('2026-10-20', '2026-10-09', 'IN_PROGRESS')).toBe(false);
  });

  it('never flags finished, excused or withdrawn work', () => {
    for (const status of ['COMPLETED', 'EXEMPTED', 'CANCELLED'] as const) {
      expect(isTrainingOverdue('2026-01-01', '2026-10-09', status), status).toBe(false);
    }
  });

  it('is not overdue when nothing is due', () => {
    expect(isTrainingOverdue(null, '2026-10-09', 'IN_PROGRESS')).toBe(false);
  });

  it('reads today at the company offset, not the viewer\'s', () => {
    // 2026-10-09T19:00Z is already the 10th in IST (+5:30).
    expect(companyToday(new Date('2026-10-09T19:00:00.000Z'))).toBe('2026-10-10');
    expect(companyToday(new Date('2026-10-09T10:00:00.000Z'))).toBe('2026-10-09');
  });
});

// ---------------------------------------------------------------------------
//  The answer key never reaches a learner surface
// ---------------------------------------------------------------------------

describe('no learner-facing surface touches an answer key', () => {
  /*
    The security property of this whole phase. The backend builds the paper from a
    select that omits `isCorrect`, and `QuestionPaperOption` has no such field — so
    a component reading one would not compile. These assertions cover the thing a
    typecheck cannot: a component reaching for the *authoring* endpoint, which does
    return the key.
  */
  it('never imports the authoring reader', () => {
    for (const file of LEARNER_SURFACES) {
      expect(executableCodeOf(file), file).not.toContain('fetchAssessmentForAuthor');
    }
  });

  it('never fetches the author endpoint by path', () => {
    for (const file of LEARNER_SURFACES) {
      expect(executableCodeOf(file), file).not.toContain('/author');
    }
  });

  it('isolates the one reader that does see the key, with a warning', () => {
    const api = codeOf('lib/training-api.ts');
    expect(api).toContain('fetchAssessmentForAuthor');
    expect(api).toContain('Never call this from a page a learner can reach');
    /*
      Exactly one *executable* mention of the authoring path. Counted on the
      comment-stripped source, because the file also documents the endpoint in prose
      — and a doc comment explaining why the key is dangerous is not a code path to
      it.
    */
    const executable = executableCodeOf('lib/training-api.ts');
    expect(executable.match(/\/author/g)?.length).toBe(1);
  });

  it('reads correctness only in the post-submission review, never on the paper', () => {
    /*
      `isCorrect` is legitimate in `AttemptResult`: `QuestionReviewView` carries the
      key, and the server sends it only for a settled attempt. It must never appear
      in `AssessmentRunner`, which renders the live paper — reading it there would
      let a learner's browser mark their own work before submitting.

      So the file is split at the two exports and each half asserted separately. A
      blunt "the file never mentions isCorrect" would forbid the correct behaviour
      as well as the wrong one.
    */
    const runner = executableCodeOf('components/hr/assessment-runner.tsx');
    const split = runner.indexOf('export function AttemptResult');
    expect(split).toBeGreaterThan(0);

    const paperHalf = runner.slice(runner.indexOf('export function AssessmentRunner'), split);
    const reviewHalf = runner.slice(split);

    expect(paperHalf).not.toContain('isCorrect');
    // And the review half does read it — otherwise the split proves nothing.
    expect(reviewHalf).toContain('isCorrect');
  });
});

// ---------------------------------------------------------------------------
//  Nothing in the browser decides anything
// ---------------------------------------------------------------------------

describe('the browser computes no score, gate or clearance', () => {
  it('never sends a score, percentage, pass flag or qualification claim', () => {
    /*
      `submitTrainingAttemptSchema` is `.strict()`, so a forged field is refused
      with 422 rather than stripped. This asserts the client never tries — the
      server-side guarantee holds either way, but a client that sends one is a
      client somebody will later "fix" by relaxing the schema.
    */
    const actions = executableCodeOf('app/(app)/hr/training-actions.ts');
    for (const forged of ['score:', 'percentage:', 'passed:', 'isQualified:']) {
      expect(actions, forged).not.toContain(forged);
    }
  });

  it('submits only which options were selected', () => {
    const actions = codeOf('app/(app)/hr/training-actions.ts');
    const submit = actions.slice(
      actions.indexOf('export async function submitAttemptAction'),
      actions.indexOf('export async function submitPracticalAction'),
    );
    expect(submit).toContain('answers');
    expect(submit).toContain('selectedOptionIds');
    expect(submit).not.toContain('score');
  });

  it('reads the stage gate from the server rather than deriving it', () => {
    /*
      `isUnlocked` and `lockedReason` arrive per module. A component that worked out
      reachability itself would be a second answer — and on a failed assessment the
      two answers differ, which is a learner walking past a gate.
    */
    const journey = executableCodeOf('components/hr/learning-journey.tsx');
    expect(journey).toContain('isUnlocked');
    expect(journey).toContain('lockedReason');
    // No local gate arithmetic: nothing looks at the previous module.
    expect(journey).not.toContain('modules[index - 1]');
    expect(journey).not.toContain('previousModule');
  });

  it('reads qualification gaps from the server and does not count them itself', () => {
    const panels = executableCodeOf('components/hr/training-review-panels.tsx');
    expect(panels).toContain('gaps.length === 0');
    // No local recomputation of the gate flags.
    for (const flag of ['requiresPractical', 'requiresShadowing', 'requiresFinalAssessment']) {
      expect(panels, flag).not.toContain(flag);
    }
  });

  it('reads isOverdue off the row in the tables rather than recomputing it', () => {
    const tables = executableCodeOf('components/hr/training-tables.tsx');
    expect(tables).toContain('enrollment.isOverdue');
    expect(tables).not.toContain('isTrainingOverdue');
    expect(tables).not.toContain('new Date');
  });
});

// ---------------------------------------------------------------------------
//  Thresholds are configuration, not constants
// ---------------------------------------------------------------------------

describe('the pass mark is a default, not a rule', () => {
  it('states the business default once, in shared', () => {
    expect(DEFAULT_PASSING_SCORE).toBe(80);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });

  it('uses the constant only as placeholder text on the program form', () => {
    /*
      The form offers 80 as a hint and sends nothing when the field is blank, so the
      column default applies. What must never happen is the browser comparing a
      score against 80 — the threshold that decides is the program's own, and the
      server is the only thing that reads it.
    */
    const forms = executableCodeOf('components/hr/training-forms.tsx');
    expect(forms).toContain('DEFAULT_PASSING_SCORE');
    expect(forms).not.toContain('>= DEFAULT_PASSING_SCORE');
    expect(forms).not.toContain('> DEFAULT_PASSING_SCORE');
  });

  it('renders each program\'s own threshold in the catalogue', () => {
    const tables = executableCodeOf('components/hr/training-tables.tsx');
    expect(tables).toContain('program.passingScore');
    expect(tables).not.toContain('DEFAULT_PASSING_SCORE');
  });

  it('shows the threshold an attempt was judged against, not the current one', () => {
    /*
      A pass mark raised after somebody passed must not retroactively fail them, so
      the history reads `attempt.passingScore` — the value as it stood then, which
      the API records per attempt.
    */
    const page = executableCodeOf('app/(app)/hr/training/learn/[id]/page.tsx');
    expect(page).toContain('attempt.passingScore');
  });
});

// ---------------------------------------------------------------------------
//  The journey is a template, not a state machine
// ---------------------------------------------------------------------------

describe('the required journey seeds a program and nothing reads it afterwards', () => {
  it('describes the thirteen business steps in order', () => {
    expect(REQUIRED_JOURNEY_TEMPLATE).toHaveLength(13);
    // Sentence case, as the template declares it.
    expect(REQUIRED_JOURNEY_TEMPLATE[0]?.title).toBe('Company introduction');
    for (const step of REQUIRED_JOURNEY_TEMPLATE) {
      expect(TRAINING_MODULE_KINDS, step.title).toContain(step.kind);
    }
  });

  it('is never consulted by a component', () => {
    /*
      The point of the template being a seed: the modules it creates are ordinary
      rows afterwards, reorderable and removable. A component that read the template
      to decide what to render would quietly re-impose the sequence on a program
      somebody had deliberately changed.
    */
    for (const file of [
      ...LEARNER_SURFACES,
      'components/hr/program-authoring.tsx',
      'app/(app)/hr/training/programs/[id]/page.tsx',
    ]) {
      expect(executableCodeOf(file), file).not.toContain('REQUIRED_JOURNEY_TEMPLATE');
    }
  });

  it('is offered on the create form only, as an opt-in', () => {
    const forms = executableCodeOf('components/hr/training-forms.tsx');
    expect(forms).toContain('seedRequiredJourney');
    // Guarded by `!editing` — re-seeding an existing program would collide with the
    // modules already in it.
    expect(forms).toContain('!editing &&');
  });
});

// ---------------------------------------------------------------------------
//  Review independence
// ---------------------------------------------------------------------------

describe('nobody reviews, signs off or clears their own work', () => {
  it('suppresses the practical controls on the viewer\'s own submission', () => {
    const panels = codeOf('components/hr/training-review-panels.tsx');
    expect(panels).toContain('!isOwn');
    expect(panels).toContain('somebody else reviews it');
  });

  it('suppresses the shadowing sign-off on the viewer\'s own period', () => {
    const panels = codeOf('components/hr/training-review-panels.tsx');
    expect(panels).toContain('your mentor signs it off');
  });

  it('suppresses a self-grant of live-work clearance', () => {
    const panels = codeOf('components/hr/training-review-panels.tsx');
    expect(panels).toContain('isOwnRecord');
    expect(panels).toContain('You cannot clear yourself for live work');
  });

  it('compares the viewer by employee code, as the session reports it', () => {
    /*
      `/api/auth/me` carries the employee *code*, not the row id — so the comparison
      is against `employee.employeeId`. Comparing against `employee.id` would be
      false for everybody, silently showing review controls on your own work.
    */
    const panels = executableCodeOf('components/hr/training-review-panels.tsx');
    expect(panels).toContain('employee.employeeId === viewerEmployeeCode');
    expect(panels).not.toContain('employee.id === viewerEmployeeCode');
  });
});

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

describe('the onboarding training link is explicit and additive', () => {
  it('offers the link on TRAINING tasks only', () => {
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');
    expect(panel).toContain("task.category === 'TRAINING'");
  });

  it('leaves the Phase 3 checklist unchanged when no programs are passed', () => {
    /*
      `trainingPrograms` is optional, and the control is behind an `!== undefined`
      check. A caller that does not supply it gets exactly the Phase 3 behaviour —
      which is what makes this additive rather than a rewrite of a shipped screen.
    */
    const panel = executableCodeOf('components/hr/onboarding-panel.tsx');
    expect(panel).toContain('trainingPrograms?: TrainingProgramSummary[]');
    expect(panel).toContain('trainingPrograms !== undefined');
  });

  it('reports an existing link rather than offering to make a second', () => {
    const link = codeOf('components/hr/onboarding-training-link.tsx');
    expect(link).toContain('trainingEnrollmentId !== null');
    expect(link).toContain('open the course');
  });

  it('offers published programs only', () => {
    const link = executableCodeOf('components/hr/onboarding-training-link.tsx');
    expect(link).toContain("program.status === 'ACTIVE'");
  });
});

// ---------------------------------------------------------------------------
//  Secure documents stay references
// ---------------------------------------------------------------------------

describe('an attached document is named, never linked', () => {
  it('renders no stored URL for a secure document', () => {
    /*
      Links are minted per request, signed and short-lived; a stored one outlives
      every access check. So the id is shown as "a document is attached" and the
      bytes are fetched through the authenticated route when somebody asks.
    */
    for (const file of [
      'components/hr/learning-journey.tsx',
      'components/hr/training-review-panels.tsx',
    ]) {
      const source = executableCodeOf(file);
      expect(source, file).toContain('secureDocumentId');
      expect(source, file).not.toContain('secureDocumentUrl');
      expect(source, file).not.toContain('documentUrl');
    }
  });
});
