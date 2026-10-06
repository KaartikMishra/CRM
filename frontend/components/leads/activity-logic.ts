import type { LeadActivityKind, LeadActivityView } from '@rs/shared';

/**
 * The pure half of the activity and follow-up workflow.
 *
 * Status in particular is derived here and nowhere stored — the same decision the
 * backend made about promptness, and for the same reason: every one of these
 * answers depends on `now`, so a stored status would be wrong the moment a
 * deadline passed with nobody touching the row.
 *
 * No React and no DOM, so the rules can be tested as arithmetic.
 */

/**
 * What state an activity is in.
 *
 * Four, not three. `COMPLETED_LATE` is separated from `COMPLETED` because it is
 * the distinction promptness turns on: the work happened, and it happened after
 * its deadline, which scores differently from the same work done on time.
 */
export type ActivityStatus = 'UPCOMING' | 'OVERDUE' | 'COMPLETED' | 'COMPLETED_LATE';

export function statusOf(activity: LeadActivityView, now: Date): ActivityStatus {
  const due = new Date(activity.dueAt);

  if (activity.completedAt !== null) {
    // Early counts as on time, matching `promptness` exactly: <= is on time.
    return new Date(activity.completedAt) <= due ? 'COMPLETED' : 'COMPLETED_LATE';
  }

  /*
    Not done, and its moment has passed. Deliberately OVERDUE rather than
    "next": the backend's `nextFollowUpAt` excludes these, because something
    already missed is outstanding rather than upcoming, and showing it as a plan
    would make a neglected lead look managed.
  */
  return due <= now ? 'OVERDUE' : 'UPCOMING';
}

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  UPCOMING: 'Upcoming',
  OVERDUE: 'Overdue',
  COMPLETED: 'Completed',
  COMPLETED_LATE: 'Completed late',
};

/** Which palette each status borrows, from the existing badge variants. */
export const ACTIVITY_STATUS_VARIANTS: Record<
  ActivityStatus,
  'positive' | 'warning' | 'critical' | 'neutral'
> = {
  UPCOMING: 'neutral',
  OVERDUE: 'critical',
  COMPLETED: 'positive',
  // Done, but not on time — amber rather than green, because promptness agrees.
  COMPLETED_LATE: 'warning',
};

/**
 * The activities split into the three groups the page shows.
 *
 * Overdue first, because it is the only group somebody has to act on today.
 * Upcoming next, earliest first, so the top row is the one `nextFollowUpAt`
 * names. History last and newest first, which is how every other timeline in
 * the CRM reads.
 */
export type GroupedActivities = {
  overdue: LeadActivityView[];
  upcoming: LeadActivityView[];
  history: LeadActivityView[];
};

export function groupActivities(
  activities: readonly LeadActivityView[],
  now: Date,
): GroupedActivities {
  const overdue: LeadActivityView[] = [];
  const upcoming: LeadActivityView[] = [];
  const history: LeadActivityView[] = [];

  for (const activity of activities) {
    const status = statusOf(activity, now);
    if (status === 'OVERDUE') overdue.push(activity);
    else if (status === 'UPCOMING') upcoming.push(activity);
    else history.push(activity);
  }

  const by = (pick: (a: LeadActivityView) => string) => (a: LeadActivityView, b: LeadActivityView) =>
    pick(a).localeCompare(pick(b));

  // Longest overdue first — the one that has been waiting hardest.
  overdue.sort(by((a) => a.dueAt));
  // Soonest first, so the head of this list is the next follow-up.
  upcoming.sort(by((a) => a.dueAt));
  // Newest first, by when it actually happened.
  history.sort((a, b) => (b.completedAt ?? b.dueAt).localeCompare(a.completedAt ?? a.dueAt));

  return { overdue, upcoming, history };
}

/**
 * A draft activity, as the form holds it.
 *
 * The date and time are separate inputs because that is how somebody schedules a
 * call, and combined into one instant only on submit.
 */
export type ActivityDraft = {
  kind: LeadActivityKind;
  dueDate: string;
  dueTime: string;
  note: string;
  /** Whether this already happened — a first contact often has. */
  completed: boolean;
};

export const emptyActivityDraft = (kind: LeadActivityKind = 'FOLLOW_UP'): ActivityDraft => ({
  kind,
  dueDate: '',
  dueTime: '',
  note: '',
  completed: false,
});

/**
 * The two inputs as one instant, in the browser's own zone.
 *
 * `new Date(y, m, d, h, min)` rather than parsing an ISO string, so "6 Oct,
 * 11:00" means eleven o'clock where the person typing it lives. The API takes an
 * offset-bearing ISO string, which `toISOString` provides.
 *
 * Null when either half is missing or the pair does not describe a real moment —
 * `new Date('2026-02-31')` is not a date, and submitting it would store garbage.
 */
export function combineDueAt(date: string, time: string): string | null {
  if (date.trim() === '' || time.trim() === '') return null;

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  if ([year, month, day, hour, minute].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }

  const at = new Date(year!, month! - 1, day!, hour!, minute!);
  if (Number.isNaN(at.getTime())) return null;

  // Round-trip guard: Date rolls 31 February over to March rather than failing.
  if (at.getFullYear() !== year || at.getMonth() !== month! - 1 || at.getDate() !== day) {
    return null;
  }

  return at.toISOString();
}

/** What is wrong with this draft, in the field somebody can fix. */
export function activityDraftErrors(draft: ActivityDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  if (draft.dueDate.trim() === '') errors.dueDate = 'Choose a date';
  if (draft.dueTime.trim() === '') errors.dueTime = 'Choose a time';

  if (draft.dueDate && draft.dueTime && combineDueAt(draft.dueDate, draft.dueTime) === null) {
    errors.dueDate = 'That is not a valid date and time';
  }

  return errors;
}

export const isActivityValid = (draft: ActivityDraft): boolean =>
  Object.keys(activityDraftErrors(draft)).length === 0;

/**
 * The create payload.
 *
 * `completedAt` is sent only when the associate says the work already happened,
 * and it is set to the due moment rather than now — recording a call made at
 * 5:30 as having happened at 5:30. An unticked box sends nothing at all, which
 * the backend reads as outstanding: it never defaults a completion to now,
 * because "due" and "done" are different facts.
 */
export function activityPayload(draft: ActivityDraft): Record<string, unknown> | null {
  const dueAt = combineDueAt(draft.dueDate, draft.dueTime);
  if (dueAt === null) return null;

  const payload: Record<string, unknown> = { kind: draft.kind, dueAt };
  if (draft.completed) payload.completedAt = dueAt;
  if (draft.note.trim() !== '') payload.note = draft.note.trim();

  return payload;
}

/**
 * Marking one activity done, now.
 *
 * The instant is the browser's, which is a deliberate limitation worth naming:
 * the backend stamps `performedById` from the authenticated actor but takes
 * `completedAt` from this payload, so a clock skewed by minutes records a
 * slightly skewed completion. It is the same trade every "mark done" button in
 * this CRM makes, and the alternative — a dedicated endpoint that calls
 * `databaseNow()` — would be a second write path for the one the PATCH already
 * serves.
 */
export const completionPayload = (at: Date = new Date()): { completedAt: string } => ({
  completedAt: at.toISOString(),
});

/** Reopening one: the completion goes, and the performer goes with it. */
export const reopenPayload = (): { completedAt: null } => ({ completedAt: null });

/**
 * An existing activity as the edit form holds it.
 *
 * Local date and time parts, because that is what the two inputs display — the
 * same conversion `combineDueAt` reverses.
 */
export function activityDraftOf(activity: LeadActivityView): ActivityDraft {
  const due = new Date(activity.dueAt);
  const pad = (n: number): string => String(n).padStart(2, '0');

  return {
    kind: activity.kind,
    dueDate: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`,
    dueTime: `${pad(due.getHours())}:${pad(due.getMinutes())}`,
    note: activity.note ?? '',
    completed: activity.completedAt !== null,
  };
}

/**
 * The patch for an edited activity — only what moved.
 *
 * `kind` is absent and stays absent: Phase 4D made it immutable, because turning
 * a FIRST_CONTACT into a RESULT rewrites history rather than correcting it. The
 * update schema has no `kind` field at all, so there is nothing to send.
 */
export function activityUpdatePayload(
  original: LeadActivityView,
  draft: ActivityDraft,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const before = activityDraftOf(original);

  const dueAt = combineDueAt(draft.dueDate, draft.dueTime);
  if (dueAt !== null && dueAt !== new Date(original.dueAt).toISOString()) {
    patch.dueAt = dueAt;
  }

  const note = draft.note.trim();
  if (note !== (original.note ?? '')) {
    // Empty becomes an explicit null, which is how the contract says "clear it".
    patch.note = note === '' ? null : note;
  }

  if (draft.completed !== before.completed) {
    patch.completedAt = draft.completed ? (dueAt ?? new Date().toISOString()) : null;
  }

  return patch;
}

export const hasActivityChanges = (
  original: LeadActivityView,
  draft: ActivityDraft,
): boolean => Object.keys(activityUpdatePayload(original, draft)).length > 0;
