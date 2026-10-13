import type {
  ApplicationStage,
  ApplicationStatus,
  AssessmentStatus,
  BackgroundCheckStatus,
  BackgroundCheckType,
  CandidateSource,
  DocumentVerificationStatus,
  EmployeeDocumentType,
  EmploymentType,
  InterviewRecommendation,
  InterviewStatus,
  InterviewType,
  JobPriority,
  JobRequisitionStatus,
  OfferStatus,
  OnboardingStage,
  OnboardingTaskCategory,
  OnboardingTaskStatus,
  ProbationDecision,
  ProbationReviewStatus,
  ProbationReviewType,
  ProbationStatus,
  WorkMode,
} from '../enums.js';
import type { EmployeeRef, OrgUnitRef } from './hr.js';

/**
 * The Phase 3 view contracts — recruitment, onboarding and probation.
 *
 * Written out rather than inferred from Prisma, for the reason the Phase 1 types
 * are: the database row and the API response are deliberately different things,
 * and a field absent here is a field the browser cannot render by accident. In
 * this phase that distinction does real work, because several columns must never
 * cross the wire to the wrong reader.
 *
 * ### What is deliberately NOT in these shapes
 *
 * Nothing candidate-facing exists in this CRM, so the confidential columns are
 * safe by construction — but the types still narrow them, because "there is no
 * candidate route today" is a weaker guarantee than "the shape has no field".
 *
 * `CandidateSummary` carries no screening notes, no interview concerns and no
 * verification result. Those live on the detail views, which only an
 * HR_RECRUITMENT reader reaches. A flagged background check appearing in a list
 * payload would be the kind of leak that is invisible until somebody opens a
 * network tab.
 *
 * Dates cross the wire as ISO strings, as everywhere else. Prisma hands back
 * `Date`, the service serialises, and typing them `string` here stops a component
 * calling `.getTime()` on something that is no longer a Date.
 */

/**
 * Whoever performed an action, for a byline.
 *
 * Named `ActorRef` rather than reusing the `UserRef` in `types/enquiry.ts`, which
 * is a different thing despite the overlap: that one carries `employeeId` and
 * `role`, and a role is a permission fact with no business in an audit byline —
 * "Rejected by Priya" needs a name, not what Priya is allowed to do.
 *
 * Phases 1 and 2 wrote this shape inline three times (`decidedBy`,
 * `performedBy`). Giving it a name here is the fourth copy becoming the first
 * definition.
 */
export type ActorRef = {
  id: string;
  name: string;
};

/** A candidate named in passing. */
export type CandidateRef = {
  id: string;
  displayName: string;
  email: string;
};

/** A role named in passing. */
export type JobRef = {
  id: string;
  code: string;
  title: string;
};

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export type JobRequisitionSummary = {
  id: string;
  code: string;
  title: string;
  department: OrgUnitRef | null;
  designation: OrgUnitRef | null;
  hiringManager: EmployeeRef | null;
  recruiter: EmployeeRef | null;
  employmentType: EmploymentType;
  workMode: WorkMode;
  location: string | null;
  openings: number;
  status: JobRequisitionStatus;
  priority: JobPriority;
  targetJoinDate: string | null;
  publishedAt: string | null;
  /**
   * Derived, never stored. Counting applications is the database's job, and a
   * stored tally would be a second answer free to drift from the applications
   * themselves — the same reasoning as DepartmentView.employeeCount.
   */
  applicationCount: number;
  activeApplicationCount: number;
  createdAt: string;
};

export type JobRequisitionView = JobRequisitionSummary & {
  description: string | null;
  requirements: string | null;
  responsibilities: string | null;
  /** Informational — what was advertised. Phase 3 computes nothing from it. */
  salaryRangeMin: string | null;
  salaryRangeMax: string | null;
  salaryCurrency: string | null;
  closedAt: string | null;
  createdBy: ActorRef;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

/**
 * A candidate in a list.
 *
 * No notes, no skills detail, no application history: a directory row is a way to
 * find somebody, and the rest is on the detail view behind the same permission.
 */
export type CandidateSummary = {
  id: string;
  displayName: string;
  email: string;
  phone: string | null;
  location: string | null;
  source: CandidateSource;
  currentEmployer: string | null;
  currentDesignation: string | null;
  totalExperienceYears: string | null;
  isActive: boolean;
  /** Derived. How many roles this person has pursued. */
  applicationCount: number;
  createdAt: string;
};

export type CandidateView = CandidateSummary & {
  firstName: string;
  lastName: string;
  sourceDetail: string | null;
  skills: string[];
  /** Internal. Never shown to the subject — there is no candidate-facing route. */
  notes: string | null;
  applications: ApplicationSummary[];
  documents: CandidateDocumentView[];
  createdBy: ActorRef;
  updatedAt: string;
};

export type CandidateDocumentView = {
  id: string;
  secureDocumentId: string;
  documentType: EmployeeDocumentType;
  title: string;
  verificationStatus: DocumentVerificationStatus;
  verifiedBy: ActorRef | null;
  verifiedAt: string | null;
  uploadedBy: ActorRef;
  createdAt: string;
  /**
   * Deliberately no URL. Links are minted per request, signed and short-lived —
   * a stored link outlives every access check and cannot be revoked, which is
   * exactly how MediaAsset became publicly fetchable.
   */
};

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export type ApplicationSummary = {
  id: string;
  candidate: CandidateRef;
  job: JobRef;
  currentStage: ApplicationStage;
  status: ApplicationStatus;
  appliedAt: string;
  source: CandidateSource;
  recruiter: EmployeeRef | null;
  hiringManager: EmployeeRef | null;
  /** The stages this application may legally move to, from the shared map. */
  availableStages: ApplicationStage[];
};

export type ApplicationView = ApplicationSummary & {
  screeningScore: number | null;
  /** Internal assessment of this application. Not the candidate's to read. */
  screeningNotes: string | null;
  rejectionReason: string | null;
  selectedBy: ActorRef | null;
  selectedAt: string | null;
  notes: string | null;
  stageHistory: ApplicationStageHistoryEntry[];
  interviews: InterviewSummary[];
  assessments: AssessmentView[];
  offers: OfferSummary[];
  backgroundChecks: BackgroundCheckView[];
  onboardingId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One recorded move. Append-only, so there is no `updatedAt`. */
export type ApplicationStageHistoryEntry = {
  id: string;
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  reason: string | null;
  performedBy: ActorRef | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export type InterviewSummary = {
  id: string;
  applicationId: string;
  candidate: CandidateRef;
  job: JobRef;
  interviewType: InterviewType;
  round: number;
  scheduledAt: string;
  durationMinutes: number;
  status: InterviewStatus;
  interviewer: EmployeeRef | null;
  participants: EmployeeRef[];
  /** Whether the viewer still owes feedback on this one. */
  feedbackPending: boolean;
};

export type InterviewView = InterviewSummary & {
  location: string | null;
  meetingUrl: string | null;
  completedAt: string | null;
  feedback: InterviewFeedbackView[];
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
};

/**
 * One interviewer's view.
 *
 * `concerns` is here because a hiring manager needs it, and nowhere near any
 * candidate-facing shape because the subject must not read it.
 */
export type InterviewFeedbackView = {
  id: string;
  employee: EmployeeRef;
  rating: number | null;
  recommendation: InterviewRecommendation;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  submittedAt: string;
};

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export type AssessmentView = {
  id: string;
  applicationId: string;
  assessmentType: string;
  title: string;
  assignedAt: string;
  dueAt: string | null;
  score: string | null;
  maxScore: string | null;
  status: AssessmentStatus;
  reviewer: EmployeeRef | null;
  reviewedAt: string | null;
  notes: string | null;
};

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export type OfferSummary = {
  id: string;
  code: string;
  applicationId: string;
  candidate: CandidateRef;
  position: string;
  proposedJoiningDate: string;
  status: OfferStatus;
  expiresOn: string | null;
  sentAt: string | null;
  respondedAt: string | null;
};

export type OfferView = OfferSummary & {
  job: JobRef;
  department: OrgUnitRef | null;
  designation: OrgUnitRef | null;
  employmentType: EmploymentType;
  workMode: WorkMode;
  location: string | null;
  /** Informational — what was communicated. No payroll is computed from it. */
  annualPackage: string | null;
  packageCurrency: string | null;
  benefitsSummary: string | null;
  responseNote: string | null;
  /** The stored offer letter, where one exists. An id, never a URL. */
  secureDocumentId: string | null;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

/**
 * One check.
 *
 * `result` on a FLAGGED or FAILED check is the most sensitive string in this
 * phase. It appears on no summary shape and no candidate-facing shape, and reaches
 * only a reader holding HR_RECRUITMENT.
 */
export type BackgroundCheckView = {
  id: string;
  applicationId: string;
  checkType: BackgroundCheckType;
  status: BackgroundCheckStatus;
  requestedAt: string;
  completedAt: string | null;
  result: string | null;
  notes: string | null;
  verifierName: string | null;
  verifiedBy: ActorRef | null;
};

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export type OnboardingSummary = {
  id: string;
  applicationId: string;
  candidate: CandidateRef;
  job: JobRef;
  stage: OnboardingStage;
  joiningDate: string;
  actualJoiningDate: string | null;
  /** Null until the EMPLOYEE_CREATED stage — the record does not exist before it. */
  employee: EmployeeRef | null;
  department: OrgUnitRef | null;
  designation: OrgUnitRef | null;
  manager: EmployeeRef | null;
  /** Derived from the tasks, never stored. */
  taskCount: number;
  completedTaskCount: number;
  completedAt: string | null;
};

export type OnboardingView = OnboardingSummary & {
  notes: string | null;
  tasks: OnboardingTaskView[];
  /** The stages this onboarding may legally advance to. */
  availableStages: OnboardingStage[];
  /** Whether the employment record can be created now, and why not if it cannot. */
  canCreateEmployee: boolean;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingTaskView = {
  id: string;
  onboardingRecordId: string;
  title: string;
  category: OnboardingTaskCategory;
  detail: string | null;
  assignee: EmployeeRef | null;
  dueOn: string | null;
  status: OnboardingTaskStatus;
  completedAt: string | null;
  completedBy: ActorRef | null;
  notes: string | null;
  sortOrder: number;
  /**
   * The training enrollment this task was linked to, where one was.
   *
   * Added by Phase 4. Phase 3 created a TRAINING task category with no course
   * behind it, deliberately — this field is what says whether the explicit linking
   * step has been taken, so the onboarding checklist can offer to take it rather
   * than re-offering it on a task already linked.
   *
   * Null on every task of every other category, and on a TRAINING task nobody has
   * linked yet.
   */
  trainingEnrollmentId: string | null;
};

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

export type ProbationSummary = {
  id: string;
  employee: EmployeeRef;
  startDate: string;
  endDate: string;
  status: ProbationStatus;
  manager: EmployeeRef | null;
  decision: ProbationDecision | null;
  /** Derived from the reviews. */
  reviewCount: number;
  completedReviewCount: number;
};

export type ProbationView = ProbationSummary & {
  originalEndDate: string | null;
  decisionReason: string | null;
  decidedBy: ActorRef | null;
  decidedAt: string | null;
  reviews: ProbationReviewView[];
  createdAt: string;
  updatedAt: string;
};

export type ProbationReviewView = {
  id: string;
  probationRecordId: string;
  reviewType: ProbationReviewType;
  scheduledOn: string;
  status: ProbationReviewStatus;
  reviewer: EmployeeRef | null;
  rating: number | null;
  comments: string | null;
  recommendation: InterviewRecommendation | null;
  completedAt: string | null;
};

// ---------------------------------------------------------------------------
//  Paged responses
// ---------------------------------------------------------------------------
//
// Phase 3's list services all return `{ items, nextCursor }` rather than the
// Phase 2 shape of a named array plus a cursor. One generic rather than six
// near-identical types: there are nine paged lists in this phase, and the Phase 2
// style would mean nine declarations differing only in a property name.

export type RecruitmentPage<T> = {
  items: T[];
  /** Null when this is the last page. Opaque — never parsed by the client. */
  nextCursor: string | null;
};

export type JobRequisitionPage = RecruitmentPage<JobRequisitionSummary>;
export type CandidatePage = RecruitmentPage<CandidateSummary>;
export type ApplicationPage = RecruitmentPage<ApplicationSummary>;
export type InterviewPage = RecruitmentPage<InterviewSummary>;
export type OfferPage = RecruitmentPage<OfferSummary>;
export type OnboardingPage = RecruitmentPage<OnboardingSummary>;
export type ProbationPage = RecruitmentPage<ProbationSummary>;
