/**
 * Training arithmetic and stage gating, as pure functions.
 *
 * No database access, no Prisma types beyond Decimal, no request context. Every
 * decision that decides whether somebody passed a test or may do live customer work
 * lives here, where it can be tested exhaustively without a server — following
 * `attendance.calc.ts` and `leave.calc.ts`.
 *
 * ### Scores are Decimal, never float
 *
 * `Prisma.Decimal` throughout. A pass mark of 80 against a computed 79.995 must not
 * round into a pass, and `0.1 + 0.2 !== 0.3` is precisely the arithmetic not to do
 * when the answer decides whether somebody is cleared for live work. The database
 * columns are NUMERIC(5,2) for the same reason.
 *
 * ### The threshold is never a constant
 *
 * `DEFAULT_PASSING_SCORE` is 80 and appears nowhere in this file. `effectiveThreshold`
 * reads the assessment's own value, falling back to the program's — so a program that
 * sets 70 is judged at 70 and one that sets 90 at 90. Comparing against a constant
 * would make every program's configuration decorative.
 */

import { Prisma } from '@prisma/client';
import type { QualificationGap, TrainingModuleKind } from '@rs/shared';

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/**
 * The threshold an attempt is judged against.
 *
 * The assessment's own if it states one, otherwise the program's. Null on the
 * assessment means "inherit" rather than "no threshold", which is why the fallback
 * is a coalesce and not a default parameter: a program changing its pass mark should
 * reach every assessment that never set its own.
 */
export function effectiveThreshold(
  assessmentPassingScore: Prisma.Decimal | null,
  programPassingScore: Prisma.Decimal,
): Prisma.Decimal {
  return assessmentPassingScore ?? programPassingScore;
}

/** The same shape for the attempt allowance. */
export function effectiveMaxAttempts(
  assessmentMaxAttempts: number | null,
  programMaxAttempts: number,
): number {
  return assessmentMaxAttempts ?? programMaxAttempts;
}

/** One question as the grader sees it: its weight and which options are right. */
export type GradableQuestion = {
  id: string;
  kind: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE';
  points: Prisma.Decimal;
  /** Every option on the question, with its truth. */
  options: { id: string; isCorrect: boolean }[];
};

/** What the learner sent for one question. */
export type SubmittedAnswer = {
  questionId: string;
  selectedOptionIds: string[];
};

export type GradedAnswer = {
  questionId: string;
  isCorrect: boolean;
  pointsAwarded: Prisma.Decimal;
  /** The option ids actually credited — validated against the question. */
  selectedOptionIds: string[];
};

export type GradedAttempt = {
  answers: GradedAnswer[];
  score: Prisma.Decimal;
  maxScore: Prisma.Decimal;
  percentage: Prisma.Decimal;
  passed: boolean;
};

/**
 * Grades one question.
 *
 * ### All-or-nothing, including on multiple choice
 *
 * A multiple-choice question is correct only when the selected set is **exactly**
 * the correct set — no partial credit for getting three of four. That is a real
 * decision: partial credit on a knowledge test means somebody can pass by selecting
 * every option on every question, which tests nothing. Selecting everything scores
 * zero here, as it should.
 *
 * ### Unknown options are ignored, not credited
 *
 * An option id that does not belong to this question is dropped rather than throwing
 * — the service validates ownership first and rejects the submission, so reaching
 * here with a foreign id means a bug upstream. Dropping is the safe failure: the
 * worst outcome is a question marked wrong, never one wrongly marked right.
 */
export function gradeQuestion(
  question: GradableQuestion,
  answer: SubmittedAnswer | undefined,
): GradedAnswer {
  const validIds = new Set(question.options.map((o) => o.id));
  const selected = new Set(
    (answer?.selectedOptionIds ?? []).filter((id) => validIds.has(id)),
  );

  const correctIds = new Set(
    question.options.filter((o) => o.isCorrect).map((o) => o.id),
  );

  /*
    Exact set equality. An unanswered question (empty selection) is incorrect
    unless the question somehow has no correct options — which the Zod refine and the
    service both refuse, so it cannot be authored.
  */
  const isCorrect =
    selected.size === correctIds.size &&
    [...selected].every((id) => correctIds.has(id)) &&
    correctIds.size > 0;

  return {
    questionId: question.id,
    isCorrect,
    pointsAwarded: isCorrect ? question.points : ZERO,
    selectedOptionIds: [...selected],
  };
}

/**
 * Grades a whole attempt against a threshold.
 *
 * The threshold is a parameter, never read from a constant — see the file note.
 *
 * `percentage` is computed to two decimal places and compared with `gte`: a
 * threshold of 80 passes at exactly 80.00 and fails at 79.99. Rounding happens once,
 * here, rather than at each comparison — otherwise two readers of the same attempt
 * could disagree about whether it passed.
 *
 * An assessment with no questions yields maxScore 0, and scores 0% — which **fails**
 * rather than passing vacuously. A paperless test must not be a free pass; the
 * service refuses to start an attempt on one, and this is the backstop.
 */
export function gradeAttempt(
  questions: GradableQuestion[],
  submitted: SubmittedAnswer[],
  threshold: Prisma.Decimal,
): GradedAttempt {
  const byQuestion = new Map(submitted.map((a) => [a.questionId, a]));

  const answers = questions.map((q) => gradeQuestion(q, byQuestion.get(q.id)));

  const score = answers.reduce((sum, a) => sum.plus(a.pointsAwarded), ZERO);
  const maxScore = questions.reduce((sum, q) => sum.plus(q.points), ZERO);

  const percentage = maxScore.isZero()
    ? ZERO
    : score.dividedBy(maxScore).times(HUNDRED).toDecimalPlaces(2);

  return {
    answers,
    score: score.toDecimalPlaces(2),
    maxScore: maxScore.toDecimalPlaces(2),
    percentage,
    // Exactly at the threshold passes. "80% to pass" meaning 80 is not enough would
    // surprise everybody who read the number.
    passed: !maxScore.isZero() && percentage.greaterThanOrEqualTo(threshold),
  };
}

// ---------------------------------------------------------------------------
//  Stage gating
// ---------------------------------------------------------------------------

/** One module with everything needed to decide whether it is done and reachable. */
export type GateableModule = {
  moduleId: string;
  title: string;
  kind: TrainingModuleKind;
  sortOrder: number;
  isRequired: boolean;
  /** Progress row present and completed. */
  isCompleted: boolean;
  /** For an ASSESSMENT module: whether any attempt passed. */
  hasPassedAssessment: boolean;
  hasAssessment: boolean;
  /** For a PRACTICAL module. */
  practicalApproved: boolean;
  /** For a SHADOWING module. */
  shadowingSignedOff: boolean;
};

/**
 * Whether a module counts as done, by its kind.
 *
 * **The rule that makes a failed test block the next stage.** An ASSESSMENT module
 * is done only when an attempt has passed — not when one has been sat, and not when
 * the learner clicked something. A PRACTICAL needs somebody else's approval and a
 * SHADOWING somebody else's sign-off; only a LESSON is done because the learner says
 * so.
 *
 * That is why `TrainingModuleKind` exists at all: one ordered list expresses the
 * whole journey because the completion rule follows the kind.
 */
export function isModuleSatisfied(module: GateableModule): boolean {
  switch (module.kind) {
    case 'LESSON':
      return module.isCompleted;
    case 'ASSESSMENT':
      /*
        An assessment module with no assessment attached cannot be passed, so it
        cannot be satisfied — it is a misconfiguration, and treating it as done would
        let an author accidentally remove a gate by deleting its test.
      */
      return module.hasAssessment && module.hasPassedAssessment;
    case 'PRACTICAL':
      return module.practicalApproved;
    case 'SHADOWING':
      return module.shadowingSignedOff;
  }
}

/**
 * Which modules the learner may reach, in sequence.
 *
 * A module unlocks when every **required** module before it is satisfied. Optional
 * modules never block: they are offered, and skipping one does not stop progress —
 * which is the whole difference between optional and required.
 *
 * So a learner who fails the knowledge test cannot open department training, because
 * the knowledge-test module is required and unsatisfied. That is the gate the brief
 * asks for, and it is one comparison rather than a chain of conditionals.
 *
 * Returns the reason too, because "locked" with no explanation is the most
 * frustrating state a learner can be shown.
 */
export function gateModules(
  modules: GateableModule[],
): { moduleId: string; isUnlocked: boolean; lockedReason: string | null }[] {
  const ordered = [...modules].sort((a, b) => a.sortOrder - b.sortOrder);

  const out: { moduleId: string; isUnlocked: boolean; lockedReason: string | null }[] = [];
  let blockedBy: GateableModule | null = null;

  for (const module of ordered) {
    if (blockedBy === null) {
      out.push({ moduleId: module.moduleId, isUnlocked: true, lockedReason: null });
    } else {
      out.push({
        moduleId: module.moduleId,
        isUnlocked: false,
        lockedReason: lockedReasonFor(blockedBy),
      });
    }

    // Only a required, unsatisfied module blocks what follows.
    if (blockedBy === null && module.isRequired && !isModuleSatisfied(module)) {
      blockedBy = module;
    }
  }

  return out;
}

/** Why a later module is locked, in words the learner can act on. */
function lockedReasonFor(blocker: GateableModule): string {
  switch (blocker.kind) {
    case 'LESSON':
      return `Finish “${blocker.title}” first.`;
    case 'ASSESSMENT':
      return blocker.hasAssessment
        ? `Pass “${blocker.title}” first.`
        : `“${blocker.title}” has no test attached yet — ask your trainer.`;
    case 'PRACTICAL':
      return `“${blocker.title}” needs to be approved first.`;
    case 'SHADOWING':
      return `“${blocker.title}” needs to be signed off first.`;
  }
}

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

export type QualificationInputs = {
  modules: GateableModule[];
  /** The program's own requirement flags. */
  requiresPractical: boolean;
  requiresShadowing: boolean;
  requiresFinalAssessment: boolean;
  /** Whether the program's final assessment has been passed. */
  finalAssessmentPassed: boolean;
  hasFinalAssessment: boolean;
  /** Whether a qualification has already been granted and not revoked. */
  alreadyQualified: boolean;
};

/**
 * What still stands between a learner and live work.
 *
 * Returns the gaps rather than a boolean, because "not eligible" with no reason is
 * useless to the manager who has to act on it — and because the UI shows the list.
 * An empty array means eligible.
 *
 * Computed from the program's flags against actual progress. There is deliberately
 * no input here a client could set, and the service calls this immediately before
 * granting rather than trusting anything precomputed: the gap between "we checked"
 * and "we granted" is where a stale read would clear somebody wrongly.
 */
export function qualificationGaps(inputs: QualificationInputs): QualificationGap[] {
  const gaps: QualificationGap[] = [];

  if (inputs.alreadyQualified) {
    return [
      {
        kind: 'ALREADY_QUALIFIED',
        detail: 'This learner is already qualified for live work on this program.',
        moduleId: null,
      },
    ];
  }

  // Every required module, whatever its kind.
  for (const module of inputs.modules) {
    if (!module.isRequired || isModuleSatisfied(module)) continue;

    if (module.kind === 'ASSESSMENT') {
      gaps.push({
        kind: 'ASSESSMENT_NOT_PASSED',
        detail: `“${module.title}” has not been passed.`,
        moduleId: module.moduleId,
      });
    } else if (module.kind === 'PRACTICAL') {
      gaps.push({
        kind: 'PRACTICAL_NOT_APPROVED',
        detail: `The practical “${module.title}” has not been approved.`,
        moduleId: module.moduleId,
      });
    } else if (module.kind === 'SHADOWING') {
      gaps.push({
        kind: 'SHADOWING_NOT_SIGNED_OFF',
        detail: `Shadowing “${module.title}” has not been signed off.`,
        moduleId: module.moduleId,
      });
    } else {
      gaps.push({
        kind: 'REQUIRED_MODULE_INCOMPLETE',
        detail: `“${module.title}” is not complete.`,
        moduleId: module.moduleId,
      });
    }
  }

  /*
    The program-level flags, which are separate from the modules on purpose.

    A program may require a practical *in general* without the author having added a
    PRACTICAL module yet — and in that case the requirement is unmet rather than
    vacuously satisfied. Treating a missing gate as passed is how a program ends up
    clearing people for live work without the review it says it requires.
  */
  if (inputs.requiresPractical) {
    const practicals = inputs.modules.filter((m) => m.kind === 'PRACTICAL');
    if (practicals.length === 0) {
      gaps.push({
        kind: 'PRACTICAL_NOT_APPROVED',
        detail: 'This program requires a practical exercise, but none has been added.',
        moduleId: null,
      });
    } else if (!practicals.some((m) => m.practicalApproved)) {
      gaps.push({
        kind: 'PRACTICAL_NOT_APPROVED',
        detail: 'No practical exercise has been approved.',
        moduleId: null,
      });
    }
  }

  if (inputs.requiresShadowing) {
    const shadowings = inputs.modules.filter((m) => m.kind === 'SHADOWING');
    if (shadowings.length === 0) {
      gaps.push({
        kind: 'SHADOWING_NOT_SIGNED_OFF',
        detail: 'This program requires shadowing, but none has been added.',
        moduleId: null,
      });
    } else if (!shadowings.some((m) => m.shadowingSignedOff)) {
      gaps.push({
        kind: 'SHADOWING_NOT_SIGNED_OFF',
        detail: 'Shadowing has not been signed off.',
        moduleId: null,
      });
    }
  }

  if (inputs.requiresFinalAssessment) {
    if (!inputs.hasFinalAssessment) {
      gaps.push({
        kind: 'FINAL_ASSESSMENT_NOT_PASSED',
        detail: 'This program requires a final assessment, but none has been configured.',
        moduleId: null,
      });
    } else if (!inputs.finalAssessmentPassed) {
      gaps.push({
        kind: 'FINAL_ASSESSMENT_NOT_PASSED',
        detail: 'The final assessment has not been passed.',
        moduleId: null,
      });
    }
  }

  return gaps;
}

/**
 * Whether another attempt is allowed, and why not if it is not.
 *
 * `used` counts every settled attempt **including expired ones**, which the caller
 * supplies. That is deliberate: if abandoning an attempt did not consume its slot,
 * the limit would be advisory — start, walk away, repeat.
 *
 * Already having passed blocks a retake too. Re-sitting a test you have passed can
 * only lower the record, and nobody is served by that.
 */
export function retakeDecision(args: {
  used: number;
  max: number;
  hasPassed: boolean;
  hasOpenAttempt: boolean;
}): { canRetake: boolean; reason: string | null } {
  if (args.hasPassed) {
    return { canRetake: false, reason: 'You have already passed this assessment.' };
  }
  if (args.hasOpenAttempt) {
    return {
      canRetake: false,
      reason: 'You have an attempt in progress — finish or let it lapse first.',
    };
  }
  if (args.used >= args.max) {
    return {
      canRetake: false,
      reason: `You have used all ${args.max} attempts. Ask your trainer about a reset.`,
    };
  }
  return { canRetake: true, reason: null };
}

/**
 * Whether an in-progress attempt has run out of time.
 *
 * `now` is a parameter so this is testable without freezing the clock — and the
 * caller passes an instant from Postgres, never `new Date()` in a request handler.
 * A browser clock cannot be trusted with a deadline it benefits from.
 */
export function hasExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && now.getTime() > expiresAt.getTime();
}

/**
 * The due date for a new assignment.
 *
 * `dueWithinDays` days from assignment, or null for no deadline. UTC day arithmetic,
 * consistent with every other HR date column — the dates are read in IST and a
 * constant offset makes the two agree.
 */
export function dueDateFrom(assignedAt: Date, dueWithinDays: number | null): Date | null {
  if (dueWithinDays === null) return null;
  const out = new Date(assignedAt.getTime());
  out.setUTCDate(out.getUTCDate() + dueWithinDays);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/**
 * Whether an enrollment is overdue, against a company-time day key.
 *
 * The reference day is a parameter rather than read from the clock inside, which is
 * what makes this testable — and the caller passes the company-time day, so
 * "overdue" means overdue in the business's timezone rather than the viewer's.
 */
export function isOverdue(
  dueOn: Date | null,
  todayKey: string,
  status: string,
): boolean {
  if (dueOn === null) return false;
  // A settled enrollment is never overdue: it is finished, excused or withdrawn.
  if (['COMPLETED', 'EXEMPTED', 'CANCELLED'].includes(status)) return false;
  return dueOn.toISOString().slice(0, 10) < todayKey;
}
