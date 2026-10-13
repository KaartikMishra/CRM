import type {
  ApplicationStage,
  ApplicationStatus,
  AssessmentStatus,
  BackgroundCheckStatus,
  BackgroundCheckType,
  CandidateSource,
  DocumentVerificationStatus,
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
} from '@rs/shared';

/**
 * How HR Phase 3 values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend suite can assert
 * them directly — the project's convention for presentation logic, and the reason
 * none of this is inlined into the components.
 *
 * **Nothing here decides anything.** Not which stage an application may move to
 * (the server's transition map), not whether a reader may see a figure (the server
 * strips it), not whether a button should be offered (the server says). These
 * functions decide only how an already-decided value is written down, which is the
 * one thing the browser is entitled to decide.
 */

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline';

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export const JOB_STATUS_LABELS: Record<JobRequisitionStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  PUBLISHED: 'Open',
  PAUSED: 'Paused',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/**
 * The visual weight each requisition status carries.
 *
 * `PUBLISHED` is the positive one because an open role is the working state — and it
 * reads as "Open" rather than "Published" for the same reason: what a recruiter cares
 * about is whether applications are being accepted, not whether a publish button was
 * pressed.
 */
export const JOB_STATUS_TONES: Record<JobRequisitionStatus, Tone> = {
  DRAFT: 'outline',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'accent',
  PUBLISHED: 'positive',
  PAUSED: 'warning',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
};

export const JOB_PRIORITY_LABELS: Record<JobPriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

/** Only URGENT is critical. If three priorities shout, none of them is heard. */
export const JOB_PRIORITY_TONES: Record<JobPriority, Tone> = {
  LOW: 'neutral',
  NORMAL: 'neutral',
  HIGH: 'warning',
  URGENT: 'critical',
};

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export const CANDIDATE_SOURCE_LABELS: Record<CandidateSource, string> = {
  DIRECT: 'Direct',
  REFERRAL: 'Referral',
  JOB_PORTAL: 'Job portal',
  WALK_IN: 'Walk-in',
  CAMPUS: 'Campus',
  AGENCY: 'Agency',
  SOCIAL_MEDIA: 'Social media',
  OTHER: 'Other',
};

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export const APPLICATION_STAGE_LABELS: Record<ApplicationStage, string> = {
  APPLICATION: 'Applied',
  SCREENING: 'Screening',
  SHORTLISTED: 'Shortlisted',
  HR_INTERVIEW: 'HR interview',
  DEPARTMENT_INTERVIEW: 'Department interview',
  ASSESSMENT: 'Assessment',
  FINAL_INTERVIEW: 'Final interview',
  SELECTED: 'Selected',
  OFFER: 'Offer made',
  OFFER_ACCEPTED: 'Offer accepted',
  BACKGROUND_VERIFICATION: 'Verification',
  ONBOARDING: 'Onboarding',
  JOINED: 'Joined',
};

/**
 * The three stages that commit the business.
 *
 * Marked so the UI can warn before one is crossed. Mirrors `COMMIT_STAGES` in the
 * shared pipeline map — and is a *presentation* copy, not a second rule: whether the
 * move is legal is still the server's answer, this only decides whether to ask
 * "are you sure".
 */
export const COMMITTING_STAGES: readonly ApplicationStage[] = [
  'SELECTED',
  'OFFER_ACCEPTED',
  'JOINED',
];

export function isCommittingStage(stage: ApplicationStage): boolean {
  return COMMITTING_STAGES.includes(stage);
}

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  ACTIVE: 'In progress',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  HIRED: 'Hired',
  DECLINED: 'Offer declined',
};

/**
 * WITHDRAWN and DECLINED are neutral, not critical.
 *
 * Both are the candidate's decision rather than a judgement about them, and
 * colouring them like a rejection would misread the record back to whoever opens it
 * later — "we turned them down" when in fact they chose not to come.
 */
export const APPLICATION_STATUS_TONES: Record<ApplicationStatus, Tone> = {
  ACTIVE: 'accent',
  REJECTED: 'critical',
  WITHDRAWN: 'neutral',
  HIRED: 'positive',
  DECLINED: 'neutral',
};

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = {
  HR: 'HR',
  DEPARTMENT: 'Department',
  TECHNICAL: 'Technical',
  FINAL: 'Final',
  OTHER: 'Other',
};

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Held',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

export const INTERVIEW_STATUS_TONES: Record<InterviewStatus, Tone> = {
  SCHEDULED: 'accent',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
  NO_SHOW: 'warning',
};

export const RECOMMENDATION_LABELS: Record<InterviewRecommendation, string> = {
  STRONG_YES: 'Strong yes',
  YES: 'Yes',
  MAYBE: 'Maybe',
  NO: 'No',
  STRONG_NO: 'Strong no',
};

/**
 * MAYBE is a warning rather than neutral.
 *
 * A panel full of "maybe" is a hiring process that has not decided anything, and it
 * should look like something needing attention rather than like a filled-in field.
 */
export const RECOMMENDATION_TONES: Record<InterviewRecommendation, Tone> = {
  STRONG_YES: 'positive',
  YES: 'positive',
  MAYBE: 'warning',
  NO: 'critical',
  STRONG_NO: 'critical',
};

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export const ASSESSMENT_STATUS_LABELS: Record<AssessmentStatus, string> = {
  PENDING: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  PASSED: 'Passed',
  FAILED: 'Failed',
};

export const ASSESSMENT_STATUS_TONES: Record<AssessmentStatus, Tone> = {
  PENDING: 'outline',
  IN_PROGRESS: 'accent',
  COMPLETED: 'neutral',
  PASSED: 'positive',
  FAILED: 'critical',
};

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Awaiting response',
  ACCEPTED: 'Accepted',
  REJECTED: 'Declined',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
};

/**
 * REJECTED reads as "Declined" because that is who did it.
 *
 * The enum value is REJECTED for symmetry with the application status, but an offer
 * is refused by the candidate — writing "Rejected" in the interface would suggest the
 * business rejected them, which is the opposite of what happened.
 */
export const OFFER_STATUS_TONES: Record<OfferStatus, Tone> = {
  DRAFT: 'outline',
  SENT: 'accent',
  ACCEPTED: 'positive',
  REJECTED: 'warning',
  EXPIRED: 'warning',
  WITHDRAWN: 'neutral',
};

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export const BACKGROUND_CHECK_TYPE_LABELS: Record<BackgroundCheckType, string> = {
  IDENTITY: 'Identity',
  EDUCATION: 'Education',
  EMPLOYMENT: 'Employment',
  CRIMINAL: 'Criminal record',
  REFERENCE: 'References',
  ADDRESS: 'Address',
  OTHER: 'Other',
};

export const BACKGROUND_CHECK_STATUS_LABELS: Record<BackgroundCheckStatus, string> = {
  PENDING: 'Not started',
  IN_PROGRESS: 'In progress',
  CLEAR: 'Clear',
  FLAGGED: 'Flagged',
  FAILED: 'Failed',
  WAIVED: 'Waived',
};

/**
 * FLAGGED is a warning, FAILED critical, WAIVED neutral.
 *
 * The distinction matters because none of them rejects anybody automatically — a
 * flagged check blocks the employment record and a person then decides. The colours
 * say "look at this", not "this person is out".
 */
export const BACKGROUND_CHECK_STATUS_TONES: Record<BackgroundCheckStatus, Tone> = {
  PENDING: 'outline',
  IN_PROGRESS: 'accent',
  CLEAR: 'positive',
  FLAGGED: 'warning',
  FAILED: 'critical',
  WAIVED: 'neutral',
};

/**
 * The weight a document's verification carries.
 *
 * Phase 1 named the labels (`VERIFICATION_STATUS_LABELS` in `hr-labels.ts`) but needed no
 * tones, because the employee document list shows them as plain text. Candidate documents
 * sit beside a background check, where an unverified identity proof should be visibly
 * different from a checked one — so the tones live here rather than widening the Phase 1
 * labels for a Phase 3 need.
 */
export const DOCUMENT_VERIFICATION_TONES: Record<DocumentVerificationStatus, Tone> = {
  PENDING: 'outline',
  VERIFIED: 'positive',
  REJECTED: 'critical',
};

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export const ONBOARDING_STAGE_LABELS: Record<OnboardingStage, string> = {
  OFFER_ACCEPTED: 'Offer accepted',
  DOCUMENTS: 'Documents',
  VERIFICATION: 'Verification',
  EMPLOYEE_CREATED: 'Employee record created',
  ACCOUNT: 'Account',
  ASSETS: 'Assets',
  POLICIES: 'Policies',
  TRAINING: 'Training',
  DEPARTMENT_INTRODUCTION: 'Department introduction',
  MANAGER_ASSIGNED: 'Manager assigned',
  FIRST_WEEK: 'First week',
  DAY_30: '30 days',
  DAY_60: '60 days',
  DAY_90: '90 days',
  PROBATION_DECISION: 'Probation decision',
  COMPLETED: 'Complete',
};

export const ONBOARDING_TASK_STATUS_LABELS: Record<OnboardingTaskStatus, string> = {
  PENDING: 'To do',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Done',
  SKIPPED: 'Skipped',
  BLOCKED: 'Blocked',
};

/**
 * SKIPPED is a warning rather than neutral, and that is deliberate.
 *
 * A skipped task is a recorded decision not to do something — it carries a required
 * reason — and it should remain visible as an exception rather than fading into the
 * completed rows. A checklist of greens where half were skipped tells the reader
 * nothing.
 */
export const ONBOARDING_TASK_STATUS_TONES: Record<OnboardingTaskStatus, Tone> = {
  PENDING: 'outline',
  IN_PROGRESS: 'accent',
  COMPLETED: 'positive',
  SKIPPED: 'warning',
  BLOCKED: 'critical',
};

export const ONBOARDING_TASK_CATEGORY_LABELS: Record<OnboardingTaskCategory, string> = {
  DOCUMENTS: 'Documents',
  IT: 'IT',
  HR: 'HR',
  MANAGER: 'Manager',
  TRAINING: 'Training',
  POLICY: 'Policy',
  DEPARTMENT: 'Department',
};

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

export const PROBATION_STATUS_LABELS: Record<ProbationStatus, string> = {
  NOT_STARTED: 'Not started',
  ACTIVE: 'On probation',
  EXTENDED: 'Extended',
  CONFIRMED: 'Confirmed',
  TERMINATED: 'Terminated',
};

export const PROBATION_STATUS_TONES: Record<ProbationStatus, Tone> = {
  NOT_STARTED: 'outline',
  ACTIVE: 'accent',
  EXTENDED: 'warning',
  CONFIRMED: 'positive',
  TERMINATED: 'critical',
};

export const PROBATION_REVIEW_TYPE_LABELS: Record<ProbationReviewType, string> = {
  FIRST_WEEK: 'First week',
  DAY_30: '30 days',
  DAY_60: '60 days',
  DAY_90: '90 days',
};

export const PROBATION_REVIEW_STATUS_LABELS: Record<ProbationReviewStatus, string> = {
  SCHEDULED: 'Due',
  COMPLETED: 'Done',
  MISSED: 'Missed',
};

export const PROBATION_REVIEW_STATUS_TONES: Record<ProbationReviewStatus, Tone> = {
  SCHEDULED: 'outline',
  COMPLETED: 'positive',
  MISSED: 'critical',
};

export const PROBATION_DECISION_LABELS: Record<ProbationDecision, string> = {
  CONFIRM: 'Confirm',
  EXTEND: 'Extend',
  TERMINATE: 'Terminate',
};

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

/**
 * A calendar day, as the business reads it.
 *
 * Takes the `YYYY-MM-DD` string the API sends and formats the parts directly —
 * deliberately NOT through `new Date(...)`, which would interpret the day in the
 * browser's timezone and show the previous date to anybody west of IST. The same
 * reasoning `formatHrDay` applies in the Phase 2 labels.
 */
export function formatDay(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return '—';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${Number(day)} ${months[Number(month) - 1] ?? ''} ${year}`;
}

/** An instant, shown in company time (IST). */
export function formatMoment(value: string | null): string {
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

/** Just the clock part of an instant, in company time. */
export function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * An advertised or communicated figure.
 *
 * Returns a dash when the value is absent, which covers two different cases that
 * should look the same to the reader: no figure was recorded, and the reader is not
 * entitled to see it. The server nulls the second before it reaches here, so this
 * function cannot tell them apart — which is the correct outcome.
 */
export function formatPackage(value: string | null, currency: string | null): string {
  if (!value) return '—';
  const amount = Number(value);
  if (Number.isNaN(amount)) return '—';
  return `${currency ?? 'INR'} ${amount.toLocaleString('en-IN')}`;
}

export function formatRange(
  min: string | null,
  max: string | null,
  currency: string | null,
): string {
  if (!min && !max) return '—';
  if (min && max) {
    return `${currency ?? 'INR'} ${Number(min).toLocaleString('en-IN')} – ${Number(max).toLocaleString('en-IN')}`;
  }
  return formatPackage(min ?? max, currency);
}

/** Experience, as stated by the candidate. */
export function formatExperience(years: string | null): string {
  if (!years) return '—';
  const value = Number(years);
  if (Number.isNaN(value)) return '—';
  if (value === 0) return 'Fresher';
  return `${value} ${value === 1 ? 'year' : 'years'}`;
}

/** A score against its maximum. Both or neither — a bare score cannot be read. */
export function formatScore(score: string | null, maxScore: string | null): string {
  if (!score || !maxScore) return '—';
  return `${Number(score)} / ${Number(maxScore)}`;
}

/**
 * Checklist progress.
 *
 * Derived from the two counts the server sends rather than from the task rows, so a
 * paged or filtered task list cannot make the progress bar disagree with itself.
 */
export function progressPercent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * Whether a dated item is overdue, against a day the caller supplies.
 *
 * The reference day is a parameter rather than read from the clock inside, which is
 * what makes this testable without freezing time — and the caller passes the
 * company-time day, so "overdue" means overdue in the business's timezone rather
 * than the viewer's.
 */
export function isOverdue(dueOn: string | null, todayKey: string): boolean {
  if (!dueOn) return false;
  return dueOn.slice(0, 10) < todayKey;
}
