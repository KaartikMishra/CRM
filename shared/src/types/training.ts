import type {
  AssessmentQuestionKind,
  PracticalSubmissionStatus,
  ShadowingStatus,
  TrainingAssignmentSource,
  TrainingAttemptStatus,
  TrainingEnrollmentStatus,
  TrainingModuleKind,
  TrainingObligation,
  TrainingProgramStatus,
} from '../enums.js';
import type { EmployeeRef, OrgUnitRef } from './hr.js';
import type { ActorRef } from './recruitment.js';

/**
 * The Phase 4 view contracts — training and learning.
 *
 * Written out rather than inferred from Prisma, for the reason the earlier phases
 * are: the database row and the API response are deliberately different things, and
 * a field absent here is a field the browser cannot render by accident.
 *
 * ### The one that matters most
 *
 * **`QuestionPaperView` has no `isCorrect` anywhere.** Not on the question, not on
 * the option. The column exists on `TrainingQuestionOption` and the paper-building
 * select omits it, so the answer key never reaches the client before submission —
 * the type makes that structural rather than a habit, and a test asserts it.
 *
 * `QuestionReviewView` is the separate shape used *after* submission, which does
 * carry correctness and the explanation. Two shapes rather than one with optional
 * fields, because an optional `isCorrect` is one careless spread away from being
 * populated on the paper.
 *
 * Dates cross the wire as ISO strings; scores and percentages as decimal strings,
 * never numbers. A score decides whether somebody may do live customer work, and
 * `0.1 + 0.2 !== 0.3` is exactly the arithmetic not to do in a browser.
 */

// ---------------------------------------------------------------------------
//  Catalogue
// ---------------------------------------------------------------------------

export type TrainingCategoryView = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Derived, never stored — counting rows is the database's job. */
  programCount: number;
  createdAt: string;
};

export type TrainingProgramSummary = {
  id: string;
  code: string;
  title: string;
  category: { id: string; name: string; code: string } | null;
  status: TrainingProgramStatus;
  obligation: TrainingObligation;
  targetDepartment: OrgUnitRef | null;
  targetDesignation: OrgUnitRef | null;
  estimatedMinutes: number | null;
  /** The program's own threshold. A decimal string: "80.00". */
  passingScore: string;
  maxAttempts: number;
  moduleCount: number;
  /** Derived. Live enrollments, and how many have finished. */
  enrolledCount: number;
  completedCount: number;
  createdAt: string;
};

export type TrainingProgramView = TrainingProgramSummary & {
  description: string | null;
  objectives: string | null;
  requiresPractical: boolean;
  requiresShadowing: boolean;
  requiresFinalAssessment: boolean;
  dueWithinDays: number | null;
  modules: TrainingModuleView[];
  /** The assessments attached to this program, with the final one flagged. */
  assessments: TrainingAssessmentSummary[];
  createdBy: ActorRef;
  publishedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
};

/**
 * One step in a program, as an author sees it.
 *
 * `secureDocumentId` is an id and never a URL: links are minted per request,
 * signed and short-lived, because a stored link outlives every access check.
 */
export type TrainingModuleView = {
  id: string;
  programId: string;
  title: string;
  kind: TrainingModuleKind;
  sortOrder: number;
  content: string | null;
  referenceUrl: string | null;
  secureDocumentId: string | null;
  isRequired: boolean;
  instructions: string | null;
  estimatedMinutes: number | null;
  /** The assessment attached to this module, where it has one. */
  assessmentId: string | null;
};

// ---------------------------------------------------------------------------
//  Enrollments and progress
// ---------------------------------------------------------------------------

export type TrainingEnrollmentSummary = {
  id: string;
  employee: EmployeeRef;
  program: { id: string; code: string; title: string };
  status: TrainingEnrollmentStatus;
  obligation: TrainingObligation;
  assignedVia: TrainingAssignmentSource;
  assignedAt: string;
  dueOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * Derived server-side against the company-time day, not the viewer's clock — so
   * a colleague abroad does not see a course flagged overdue a day early.
   */
  isOverdue: boolean;
  /** Required modules done, out of required modules total. */
  completedModuleCount: number;
  requiredModuleCount: number;
};

export type TrainingEnrollmentView = Omit<TrainingEnrollmentSummary, 'program'> & {
  /**
   * The full program, not just its reference.
   *
   * Widened from the summary's `{ id, code, title }` because the learner's page shows
   * the pass mark, the attempt allowance and the requirement flags — all of which
   * live on the program and none of which the browser should guess at.
   */
  program: TrainingProgramSummary;
  assignedBy: ActorRef;
  exemptedBy: ActorRef | null;
  exemptedAt: string | null;
  exemptionReason: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** Every module with this learner's progress against it, in sequence. */
  modules: EnrollmentModuleView[];
  attempts: TrainingAttemptSummary[];
  practicals: PracticalSubmissionView[];
  shadowings: ShadowingRecordView[];
  qualification: TrainingQualificationView | null;
  /**
   * What still stands between this learner and live work.
   *
   * Computed server-side from the program's requirement flags and actual progress.
   * An empty array means eligible — and the frontend reads this rather than
   * deciding for itself, because the backend is the only authority on whether
   * somebody may do live customer work.
   */
  qualificationGaps: QualificationGap[];
  createdAt: string;
  updatedAt: string;
};

/**
 * One module as the learner sees it, with their own progress.
 *
 * `isUnlocked` is the stage gate, computed server-side: a module is reachable only
 * when every required module before it is done. **A failed assessment therefore
 * leaves the next stage locked**, which is the rule this type exists to carry.
 *
 * `lockedReason` says why in words, because "locked" with no explanation is the
 * most frustrating state a learner can be shown.
 */
export type EnrollmentModuleView = {
  moduleId: string;
  title: string;
  kind: TrainingModuleKind;
  sortOrder: number;
  isRequired: boolean;
  instructions: string | null;
  content: string | null;
  referenceUrl: string | null;
  secureDocumentId: string | null;
  estimatedMinutes: number | null;
  startedAt: string | null;
  completedAt: string | null;
  isCompleted: boolean;
  isUnlocked: boolean;
  lockedReason: string | null;
  /** For an ASSESSMENT module: the test, and how this learner stands on it. */
  assessment: {
    id: string;
    title: string;
    /** The effective threshold — the assessment's own, or the program's. */
    passingScore: string;
    maxAttempts: number;
    attemptsUsed: number;
    attemptsRemaining: number;
    bestPercentage: string | null;
    hasPassed: boolean;
    /** An unfinished attempt to resume, where one exists. */
    openAttemptId: string | null;
  } | null;
  /** For a PRACTICAL module. */
  practicalId: string | null;
  practicalStatus: PracticalSubmissionStatus | null;
  /** For a SHADOWING module. */
  shadowingId: string | null;
  shadowingStatus: ShadowingStatus | null;
};

/** One unmet prerequisite for live-work qualification. */
export type QualificationGap = {
  kind:
    | 'REQUIRED_MODULE_INCOMPLETE'
    | 'ASSESSMENT_NOT_PASSED'
    | 'PRACTICAL_NOT_APPROVED'
    | 'SHADOWING_NOT_SIGNED_OFF'
    | 'FINAL_ASSESSMENT_NOT_PASSED'
    | 'ALREADY_QUALIFIED';
  /** What is missing, in words a learner or a manager can act on. */
  detail: string;
  /** The module or assessment it concerns, where it concerns one. */
  moduleId: string | null;
};

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export type TrainingAssessmentSummary = {
  id: string;
  programId: string;
  moduleId: string | null;
  title: string;
  /** Effective threshold: this assessment's own, or inherited from the program. */
  passingScore: string;
  maxAttempts: number;
  timeLimitMinutes: number | null;
  isFinal: boolean;
  isActive: boolean;
  questionCount: number;
  /** The paper's total, summed from question points. Derived. */
  totalPoints: string;
};

export type TrainingAssessmentView = TrainingAssessmentSummary & {
  instructions: string | null;
  shuffleQuestions: boolean;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
};

/**
 * One option on a paper the learner is about to sit.
 *
 * **Deliberately has no `isCorrect`.** The field exists in the database and is
 * omitted from the select that builds this; the type's shape is what makes that
 * omission enforceable rather than remembered.
 */
export type QuestionPaperOption = {
  id: string;
  label: string;
  sortOrder: number;
};

/** One question on a paper. No correctness, and no explanation. */
export type QuestionPaperQuestion = {
  id: string;
  kind: AssessmentQuestionKind;
  prompt: string;
  points: string;
  sortOrder: number;
  options: QuestionPaperOption[];
};

/**
 * The paper, as issued at the start of an attempt.
 *
 * Returned once, when an attempt begins. It carries the questions, the options, the
 * threshold and the clock — and nothing that would let a learner mark their own
 * work.
 */
export type QuestionPaperView = {
  attemptId: string;
  assessmentId: string;
  title: string;
  instructions: string | null;
  attemptNumber: number;
  passingScore: string;
  totalPoints: string;
  startedAt: string;
  /** When the attempt must be in by, for a timed assessment. Server-computed. */
  expiresAt: string | null;
  questions: QuestionPaperQuestion[];
};

/** One question after submission, with the answer key and the learner's working. */
export type QuestionReviewView = {
  id: string;
  kind: AssessmentQuestionKind;
  prompt: string;
  points: string;
  pointsAwarded: string;
  isCorrect: boolean;
  /** Shown only after submission — never on the paper. */
  explanation: string | null;
  options: {
    id: string;
    label: string;
    sortOrder: number;
    isCorrect: boolean;
    wasSelected: boolean;
  }[];
};

export type TrainingAttemptSummary = {
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  attemptNumber: number;
  status: TrainingAttemptStatus;
  startedAt: string;
  submittedAt: string | null;
  score: string | null;
  maxScore: string | null;
  percentage: string | null;
  passed: boolean | null;
  /** The threshold this attempt was judged against, as it stood then. */
  passingScore: string;
};

/**
 * One attempt in full, with per-question review.
 *
 * `questions` is populated only for a settled attempt — an in-progress one returns
 * an empty array, because the review shape carries the answer key and an
 * in-progress attempt is exactly when the learner must not have it.
 */
export type TrainingAttemptView = TrainingAttemptSummary & {
  employee: EmployeeRef;
  enrollmentId: string;
  expiresAt: string | null;
  questions: QuestionReviewView[];
  /** Whether a further attempt is allowed, and why not if it is not. */
  canRetake: boolean;
  retakeBlockedReason: string | null;
};

// ---------------------------------------------------------------------------
//  Practical and shadowing
// ---------------------------------------------------------------------------

export type PracticalSubmissionView = {
  id: string;
  enrollmentId: string;
  moduleId: string;
  moduleTitle: string;
  employee: EmployeeRef;
  instructions: string | null;
  status: PracticalSubmissionStatus;
  submissionNotes: string | null;
  secureDocumentId: string | null;
  submittedAt: string | null;
  reviewer: EmployeeRef | null;
  reviewedBy: EmployeeRef | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
};

export type ShadowingRecordView = {
  id: string;
  enrollmentId: string;
  moduleId: string;
  moduleTitle: string;
  employee: EmployeeRef;
  mentor: EmployeeRef | null;
  status: ShadowingStatus;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  checklist: string | null;
  feedback: string | null;
  signedOffBy: EmployeeRef | null;
  signedOffAt: string | null;
};

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * Live-work qualification.
 *
 * A record of its own rather than a flag on Employee, because it is a different
 * business state: somebody can be employed and not yet qualified, and qualifying
 * touches neither `Employee.status`, probation, nor the employment timeline.
 */
export type TrainingQualificationView = {
  id: string;
  enrollmentId: string;
  employee: EmployeeRef;
  program: { id: string; code: string; title: string };
  qualifiedAt: string;
  grantedBy: ActorRef;
  finalScore: string | null;
  notes: string | null;
  certificateCode: string | null;
  certificateIssuedAt: string | null;
  revokedBy: ActorRef | null;
  revokedAt: string | null;
  revocationReason: string | null;
  /** Derived: granted and not since revoked. */
  isActive: boolean;
};

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

/**
 * The training landing figures.
 *
 * Every number is scoped to what the reader may see, so a manager's dashboard
 * counts their reports and an HR reader's counts everybody — the same shape the
 * other HR overviews use.
 */
export type TrainingOverview = {
  activePrograms: number;
  liveEnrollments: number;
  inProgress: number;
  overdue: number;
  completedThisMonth: number;
  /** Learners who have passed every gate but have not been granted qualification. */
  awaitingQualification: number;
  pendingPracticalReviews: number;
  pendingShadowingSignOffs: number;
  /** Attempts settled in the period, split by outcome. */
  passedAttempts: number;
  failedAttempts: number;
  /** Mandatory enrollments not yet complete — the figure HR is accountable for. */
  mandatoryIncomplete: number;
};

// ---------------------------------------------------------------------------
//  Paged responses
// ---------------------------------------------------------------------------

export type TrainingPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type TrainingProgramPage = TrainingPage<TrainingProgramSummary>;
export type TrainingEnrollmentPage = TrainingPage<TrainingEnrollmentSummary>;
export type TrainingAttemptPage = TrainingPage<TrainingAttemptSummary>;
export type PracticalSubmissionPage = TrainingPage<PracticalSubmissionView>;
export type ShadowingRecordPage = TrainingPage<ShadowingRecordView>;
export type TrainingQualificationPage = TrainingPage<TrainingQualificationView>;
