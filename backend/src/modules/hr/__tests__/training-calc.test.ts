/**
 * The training calculator, tested exhaustively without a database.
 *
 * Every function here decides something consequential — whether somebody passed a
 * test, whether a stage unlocks, whether a learner is cleared for live customer
 * work — and all of it is pure, so it can be pinned properly rather than sampled
 * through HTTP. Following `attendance-calc.test.ts` and `leave-calc.test.ts`.
 *
 * The properties worth the most here:
 *
 *   - a score exactly at the threshold passes, and a hair under fails;
 *   - the threshold is the program's or the assessment's, never a constant;
 *   - selecting every option scores zero rather than earning partial credit;
 *   - a failed assessment leaves every later module locked;
 *   - a missing gate is unmet, not vacuously satisfied.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  dueDateFrom,
  effectiveMaxAttempts,
  effectiveThreshold,
  gateModules,
  gradeAttempt,
  gradeQuestion,
  hasExpired,
  isModuleSatisfied,
  isOverdue,
  qualificationGaps,
  retakeDecision,
  type GateableModule,
  type GradableQuestion,
} from '../training.calc.js';

const dec = (n: string | number): Prisma.Decimal => new Prisma.Decimal(n);

/** A single-choice question worth `points`, with `a` correct. */
function single(id: string, points: string | number = 1): GradableQuestion {
  return {
    id,
    kind: 'SINGLE_CHOICE',
    points: dec(points),
    options: [
      { id: `${id}-a`, isCorrect: true },
      { id: `${id}-b`, isCorrect: false },
      { id: `${id}-c`, isCorrect: false },
    ],
  };
}

/** A multiple-choice question with `a` and `b` correct, `c` and `d` wrong. */
function multi(id: string, points: string | number = 1): GradableQuestion {
  return {
    id,
    kind: 'MULTIPLE_CHOICE',
    points: dec(points),
    options: [
      { id: `${id}-a`, isCorrect: true },
      { id: `${id}-b`, isCorrect: true },
      { id: `${id}-c`, isCorrect: false },
      { id: `${id}-d`, isCorrect: false },
    ],
  };
}

function gateable(over: Partial<GateableModule> & { moduleId: string }): GateableModule {
  return {
    title: over.moduleId,
    kind: 'LESSON',
    sortOrder: 0,
    isRequired: true,
    isCompleted: false,
    hasPassedAssessment: false,
    hasAssessment: false,
    practicalApproved: false,
    shadowingSignedOff: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  The threshold is configuration, never a constant
// ---------------------------------------------------------------------------

describe('the passing threshold comes from configuration', () => {
  it('uses the assessment’s own threshold when it states one', () => {
    expect(effectiveThreshold(dec(70), dec(80)).toString()).toBe('70');
  });

  it('inherits the program’s when the assessment states none', () => {
    /*
      Null means "inherit", not "no threshold". Stored nullable rather than copied so
      that changing a program's pass mark reaches every assessment that never set
      its own.
    */
    expect(effectiveThreshold(null, dec(80)).toString()).toBe('80');
  });

  it('honours a stricter program threshold than the default', () => {
    // Nothing in the calculator knows the number 80. A program at 95 is judged at 95.
    expect(effectiveThreshold(null, dec(95)).toString()).toBe('95');
  });

  it('does the same for the attempt allowance', () => {
    expect(effectiveMaxAttempts(1, 3)).toBe(1);
    expect(effectiveMaxAttempts(null, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  Grading one question
// ---------------------------------------------------------------------------

describe('gradeQuestion', () => {
  it('credits the correct single choice', () => {
    const graded = gradeQuestion(single('q1', 10), {
      questionId: 'q1',
      selectedOptionIds: ['q1-a'],
    });
    expect(graded.isCorrect).toBe(true);
    expect(graded.pointsAwarded.toString()).toBe('10');
  });

  it('awards nothing for a wrong single choice', () => {
    const graded = gradeQuestion(single('q1', 10), {
      questionId: 'q1',
      selectedOptionIds: ['q1-b'],
    });
    expect(graded.isCorrect).toBe(false);
    expect(graded.pointsAwarded.toString()).toBe('0');
  });

  it('awards nothing for an unanswered question', () => {
    // A deliberately skipped question is a legitimate answer worth zero.
    const graded = gradeQuestion(single('q1'), undefined);
    expect(graded.isCorrect).toBe(false);
    expect(graded.pointsAwarded.toString()).toBe('0');
  });

  it('requires the exact set on multiple choice', () => {
    const q = multi('q2', 10);
    expect(
      gradeQuestion(q, { questionId: 'q2', selectedOptionIds: ['q2-a', 'q2-b'] }).isCorrect,
    ).toBe(true);
  });

  it('gives no partial credit for a subset', () => {
    /*
      Three of four right is wrong. Partial credit on a knowledge test means somebody
      can accumulate a pass without ever being right about anything, and the pass mark
      then measures effort rather than knowledge.
    */
    const graded = gradeQuestion(multi('q2', 10), {
      questionId: 'q2',
      selectedOptionIds: ['q2-a'],
    });
    expect(graded.isCorrect).toBe(false);
    expect(graded.pointsAwarded.toString()).toBe('0');
  });

  it('scores zero for selecting every option', () => {
    // The obvious cheat, and it must not work.
    const graded = gradeQuestion(multi('q2', 10), {
      questionId: 'q2',
      selectedOptionIds: ['q2-a', 'q2-b', 'q2-c', 'q2-d'],
    });
    expect(graded.isCorrect).toBe(false);
  });

  it('ignores an option belonging to another question', () => {
    /*
      The service rejects a foreign option id before reaching here, so this is the
      backstop. Dropping is the safe failure: the worst outcome is a question marked
      wrong, never one wrongly marked right.
    */
    const graded = gradeQuestion(single('q1', 10), {
      questionId: 'q1',
      selectedOptionIds: ['q1-a', 'SOMEONE-ELSES-OPTION'],
    });
    expect(graded.isCorrect).toBe(true);
    expect(graded.selectedOptionIds).toEqual(['q1-a']);
  });

  it('refuses to credit a question with no correct option', () => {
    // Unauthorable through Zod and the service; treated as uncreditable here rather
    // than as a free mark.
    const broken: GradableQuestion = {
      id: 'q3',
      kind: 'SINGLE_CHOICE',
      points: dec(5),
      options: [{ id: 'q3-a', isCorrect: false }],
    };
    expect(gradeQuestion(broken, { questionId: 'q3', selectedOptionIds: [] }).isCorrect).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
//  Grading an attempt
// ---------------------------------------------------------------------------

describe('gradeAttempt', () => {
  it('passes at exactly the threshold', () => {
    /*
      The boundary that matters most. "80% to pass" meaning 80 is not enough would
      surprise everybody who read the number, so `gte` is the comparison.
    */
    const questions = [single('a', 20), single('b', 20), single('c', 20), single('d', 20), single('e', 20)];
    const graded = gradeAttempt(
      questions,
      [
        { questionId: 'a', selectedOptionIds: ['a-a'] },
        { questionId: 'b', selectedOptionIds: ['b-a'] },
        { questionId: 'c', selectedOptionIds: ['c-a'] },
        { questionId: 'd', selectedOptionIds: ['d-a'] },
        { questionId: 'e', selectedOptionIds: ['e-b'] },
      ],
      dec(80),
    );
    expect(graded.percentage.toString()).toBe('80');
    expect(graded.passed).toBe(true);
  });

  it('fails a hair under the threshold', () => {
    // 79.99 against 80. This is the case floating-point arithmetic would get wrong.
    const questions = [single('a', '79.99'), single('b', '20.01')];
    const graded = gradeAttempt(
      questions,
      [{ questionId: 'a', selectedOptionIds: ['a-a'] }],
      dec(80),
    );
    expect(graded.percentage.toString()).toBe('79.99');
    expect(graded.passed).toBe(false);
  });

  it('computes in decimal, not float', () => {
    /*
      Three questions worth 10 each, one right: 33.33%, not 33.33333333333333. The
      columns are NUMERIC(5,2) and the arithmetic matches them.
    */
    const graded = gradeAttempt(
      [single('a', 10), single('b', 10), single('c', 10)],
      [{ questionId: 'a', selectedOptionIds: ['a-a'] }],
      dec(80),
    );
    expect(graded.percentage.toString()).toBe('33.33');
    expect(graded.score.toString()).toBe('10');
    expect(graded.maxScore.toString()).toBe('30');
  });

  it('judges the same answers differently under different thresholds', () => {
    // The point of configurable thresholds: 70% passes a 70 program and fails a 90.
    const questions = [single('a', 70), single('b', 30)];
    const answers = [{ questionId: 'a', selectedOptionIds: ['a-a'] }];
    expect(gradeAttempt(questions, answers, dec(70)).passed).toBe(true);
    expect(gradeAttempt(questions, answers, dec(90)).passed).toBe(false);
  });

  it('fails an empty paper rather than passing vacuously', () => {
    /*
      A test with no questions must not be a free pass. The service refuses to start
      an attempt on one; this is the backstop in case it ever does.
    */
    const graded = gradeAttempt([], [], dec(80));
    expect(graded.maxScore.toString()).toBe('0');
    expect(graded.passed).toBe(false);
  });

  it('grades every question even when the learner answered only some', () => {
    const graded = gradeAttempt(
      [single('a', 50), single('b', 50)],
      [{ questionId: 'a', selectedOptionIds: ['a-a'] }],
      dec(80),
    );
    expect(graded.answers).toHaveLength(2);
    expect(graded.answers.find((a) => a.questionId === 'b')?.isCorrect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Stage gating — the rule the brief asks for
// ---------------------------------------------------------------------------

describe('module satisfaction follows the module kind', () => {
  it('completes a lesson when the learner marks it done', () => {
    expect(isModuleSatisfied(gateable({ moduleId: 'm', kind: 'LESSON', isCompleted: true }))).toBe(
      true,
    );
  });

  it('completes an assessment only when one has been PASSED', () => {
    // Sitting a test is not passing it. This is the rule that makes a failure block.
    const sat = gateable({
      moduleId: 'm',
      kind: 'ASSESSMENT',
      hasAssessment: true,
      isCompleted: true,
      hasPassedAssessment: false,
    });
    expect(isModuleSatisfied(sat)).toBe(false);

    const passed = gateable({
      moduleId: 'm',
      kind: 'ASSESSMENT',
      hasAssessment: true,
      hasPassedAssessment: true,
    });
    expect(isModuleSatisfied(passed)).toBe(true);
  });

  it('refuses to satisfy an assessment module with no test attached', () => {
    // Otherwise deleting a test would silently remove a gate.
    expect(
      isModuleSatisfied(
        gateable({ moduleId: 'm', kind: 'ASSESSMENT', hasAssessment: false, isCompleted: true }),
      ),
    ).toBe(false);
  });

  it('needs independent approval for a practical and a sign-off for shadowing', () => {
    expect(
      isModuleSatisfied(gateable({ moduleId: 'm', kind: 'PRACTICAL', isCompleted: true })),
    ).toBe(false);
    expect(
      isModuleSatisfied(gateable({ moduleId: 'm', kind: 'PRACTICAL', practicalApproved: true })),
    ).toBe(true);
    expect(
      isModuleSatisfied(gateable({ moduleId: 'm', kind: 'SHADOWING', isCompleted: true })),
    ).toBe(false);
    expect(
      isModuleSatisfied(
        gateable({ moduleId: 'm', kind: 'SHADOWING', shadowingSignedOff: true }),
      ),
    ).toBe(true);
  });
});

describe('gateModules', () => {
  /** The required journey, abbreviated to the gates that matter. */
  function journey(over: Partial<Record<string, Partial<GateableModule>>> = {}): GateableModule[] {
    const spec: [string, TrainingModuleKindLocal, number][] = [
      ['intro', 'LESSON', 0],
      ['product', 'LESSON', 1],
      ['knowledge-test', 'ASSESSMENT', 2],
      ['dept-training', 'LESSON', 3],
      ['dept-test', 'ASSESSMENT', 4],
      ['practical', 'PRACTICAL', 5],
      ['shadowing', 'SHADOWING', 6],
      ['final', 'ASSESSMENT', 7],
    ];
    return spec.map(([id, kind, sortOrder]) =>
      gateable({
        moduleId: id,
        title: id,
        kind,
        sortOrder,
        hasAssessment: kind === 'ASSESSMENT',
        ...(over[id] ?? {}),
      }),
    );
  }
  type TrainingModuleKindLocal = 'LESSON' | 'ASSESSMENT' | 'PRACTICAL' | 'SHADOWING';

  it('unlocks only the first module at the start', () => {
    const gated = gateModules(journey());
    expect(gated.find((g) => g.moduleId === 'intro')?.isUnlocked).toBe(true);
    expect(gated.find((g) => g.moduleId === 'product')?.isUnlocked).toBe(false);
  });

  it('A FAILED KNOWLEDGE TEST BLOCKS DEPARTMENT TRAINING', () => {
    /*
      The requirement stated in the brief, asserted directly. The learner has done
      both lessons and sat the knowledge test without passing it — department
      training stays locked, and the reason says why.
    */
    const gated = gateModules(
      journey({
        intro: { isCompleted: true },
        product: { isCompleted: true },
        'knowledge-test': { hasPassedAssessment: false, isCompleted: true },
      }),
    );

    const dept = gated.find((g) => g.moduleId === 'dept-training');
    expect(dept?.isUnlocked).toBe(false);
    expect(dept?.lockedReason).toMatch(/pass/i);
    expect(dept?.lockedReason).toContain('knowledge-test');

    // And everything after it, too.
    for (const later of ['dept-test', 'practical', 'shadowing', 'final']) {
      expect(gated.find((g) => g.moduleId === later)?.isUnlocked, later).toBe(false);
    }
  });

  it('unlocks department training once the knowledge test is passed', () => {
    const gated = gateModules(
      journey({
        intro: { isCompleted: true },
        product: { isCompleted: true },
        'knowledge-test': { hasPassedAssessment: true },
      }),
    );
    expect(gated.find((g) => g.moduleId === 'dept-training')?.isUnlocked).toBe(true);
    // But not past the next unsatisfied gate.
    expect(gated.find((g) => g.moduleId === 'dept-test')?.isUnlocked).toBe(false);
  });

  it('blocks on an unapproved practical', () => {
    const gated = gateModules(
      journey({
        intro: { isCompleted: true },
        product: { isCompleted: true },
        'knowledge-test': { hasPassedAssessment: true },
        'dept-training': { isCompleted: true },
        'dept-test': { hasPassedAssessment: true },
        practical: { practicalApproved: false },
      }),
    );
    const shadow = gated.find((g) => g.moduleId === 'shadowing');
    expect(shadow?.isUnlocked).toBe(false);
    expect(shadow?.lockedReason).toMatch(/approved/i);
  });

  it('unlocks the whole journey when every gate is satisfied', () => {
    const gated = gateModules(
      journey({
        intro: { isCompleted: true },
        product: { isCompleted: true },
        'knowledge-test': { hasPassedAssessment: true },
        'dept-training': { isCompleted: true },
        'dept-test': { hasPassedAssessment: true },
        practical: { practicalApproved: true },
        shadowing: { shadowingSignedOff: true },
      }),
    );
    expect(gated.every((g) => g.isUnlocked)).toBe(true);
  });

  it('does not let an optional module block what follows', () => {
    // The whole difference between optional and required.
    const modules = [
      gateable({ moduleId: 'a', sortOrder: 0, isCompleted: true }),
      gateable({ moduleId: 'optional', sortOrder: 1, isRequired: false, isCompleted: false }),
      gateable({ moduleId: 'c', sortOrder: 2 }),
    ];
    expect(gateModules(modules).find((g) => g.moduleId === 'c')?.isUnlocked).toBe(true);
  });

  it('gates by sortOrder rather than array order', () => {
    const shuffled = [
      gateable({ moduleId: 'second', sortOrder: 1 }),
      gateable({ moduleId: 'first', sortOrder: 0, isCompleted: true }),
    ];
    const gated = gateModules(shuffled);
    expect(gated[0]?.moduleId).toBe('first');
    expect(gated.find((g) => g.moduleId === 'second')?.isUnlocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

describe('qualificationGaps', () => {
  const base = {
    requiresPractical: false,
    requiresShadowing: false,
    requiresFinalAssessment: false,
    finalAssessmentPassed: false,
    hasFinalAssessment: false,
    alreadyQualified: false,
  };

  it('is empty when every required module is satisfied', () => {
    expect(
      qualificationGaps({
        ...base,
        modules: [gateable({ moduleId: 'a', isCompleted: true })],
      }),
    ).toEqual([]);
  });

  it('reports an unpassed assessment rather than a generic gap', () => {
    const gaps = qualificationGaps({
      ...base,
      modules: [
        gateable({ moduleId: 'kt', title: 'Knowledge test', kind: 'ASSESSMENT', hasAssessment: true }),
      ],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('ASSESSMENT_NOT_PASSED');
    expect(gaps[0]?.detail).toContain('Knowledge test');
  });

  it('treats a MISSING required gate as unmet, not satisfied', () => {
    /*
      The subtle one, and the dangerous one. A program that says it requires a
      practical but has no PRACTICAL module must not clear people — treating a
      missing gate as passed is how a program ends up qualifying people without the
      review it advertises.
    */
    const gaps = qualificationGaps({
      ...base,
      requiresPractical: true,
      requiresShadowing: true,
      requiresFinalAssessment: true,
      modules: [gateable({ moduleId: 'a', isCompleted: true })],
    });

    expect(gaps.map((g) => g.kind).sort()).toEqual([
      'FINAL_ASSESSMENT_NOT_PASSED',
      'PRACTICAL_NOT_APPROVED',
      'SHADOWING_NOT_SIGNED_OFF',
    ]);
    for (const gap of gaps) expect(gap.detail).toMatch(/has been added|configured/i);
  });

  it('clears a fully satisfied journey', () => {
    expect(
      qualificationGaps({
        modules: [
          gateable({ moduleId: 'l', isCompleted: true }),
          gateable({ moduleId: 'kt', kind: 'ASSESSMENT', hasAssessment: true, hasPassedAssessment: true }),
          gateable({ moduleId: 'p', kind: 'PRACTICAL', practicalApproved: true }),
          gateable({ moduleId: 's', kind: 'SHADOWING', shadowingSignedOff: true }),
        ],
        requiresPractical: true,
        requiresShadowing: true,
        requiresFinalAssessment: true,
        hasFinalAssessment: true,
        finalAssessmentPassed: true,
        alreadyQualified: false,
      }),
    ).toEqual([]);
  });

  it('refuses to qualify twice', () => {
    const gaps = qualificationGaps({ ...base, modules: [], alreadyQualified: true });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe('ALREADY_QUALIFIED');
  });

  it('blocks on a final assessment that was sat but not passed', () => {
    const gaps = qualificationGaps({
      ...base,
      modules: [],
      requiresFinalAssessment: true,
      hasFinalAssessment: true,
      finalAssessmentPassed: false,
    });
    expect(gaps[0]?.kind).toBe('FINAL_ASSESSMENT_NOT_PASSED');
  });
});

// ---------------------------------------------------------------------------
//  Retakes, expiry and dates
// ---------------------------------------------------------------------------

describe('retakeDecision', () => {
  it('allows a retake within the limit', () => {
    expect(
      retakeDecision({ used: 1, max: 3, hasPassed: false, hasOpenAttempt: false }).canRetake,
    ).toBe(true);
  });

  it('refuses once the limit is reached', () => {
    const d = retakeDecision({ used: 3, max: 3, hasPassed: false, hasOpenAttempt: false });
    expect(d.canRetake).toBe(false);
    expect(d.reason).toContain('3');
  });

  it('refuses after a pass', () => {
    // Re-sitting a passed test can only lower the record.
    expect(
      retakeDecision({ used: 1, max: 3, hasPassed: true, hasOpenAttempt: false }).canRetake,
    ).toBe(false);
  });

  it('refuses while an attempt is open', () => {
    // Otherwise a learner could hold several papers at once and pick the best.
    expect(
      retakeDecision({ used: 1, max: 3, hasPassed: false, hasOpenAttempt: true }).canRetake,
    ).toBe(false);
  });
});

describe('expiry and due dates', () => {
  it('treats an untimed attempt as never expiring', () => {
    expect(hasExpired(null, new Date('2026-01-01T00:00:00Z'))).toBe(false);
  });

  it('expires strictly after the deadline', () => {
    const deadline = new Date('2026-01-01T10:00:00Z');
    expect(hasExpired(deadline, new Date('2026-01-01T09:59:59Z'))).toBe(false);
    expect(hasExpired(deadline, new Date('2026-01-01T10:00:00Z'))).toBe(false);
    expect(hasExpired(deadline, new Date('2026-01-01T10:00:01Z'))).toBe(true);
  });

  it('computes a due date from the assignment day', () => {
    const due = dueDateFrom(new Date('2026-03-01T14:30:00Z'), 14);
    expect(due?.toISOString().slice(0, 10)).toBe('2026-03-15');
    // Normalised to midnight so a date column comparison is clean.
    expect(due?.toISOString().slice(11, 19)).toBe('00:00:00');
  });

  it('returns no due date when the program sets none', () => {
    expect(dueDateFrom(new Date('2026-03-01T00:00:00Z'), null)).toBeNull();
  });

  it('judges overdue against a supplied company day', () => {
    const due = new Date('2026-03-01T00:00:00Z');
    expect(isOverdue(due, '2026-03-02', 'IN_PROGRESS')).toBe(true);
    expect(isOverdue(due, '2026-03-01', 'IN_PROGRESS')).toBe(false);
    expect(isOverdue(null, '2026-03-02', 'IN_PROGRESS')).toBe(false);
  });

  it('never calls a settled enrollment overdue', () => {
    // Finished, excused or withdrawn work is not late — it is done with.
    const due = new Date('2026-03-01T00:00:00Z');
    for (const status of ['COMPLETED', 'EXEMPTED', 'CANCELLED']) {
      expect(isOverdue(due, '2026-06-01', status), status).toBe(false);
    }
  });
});
