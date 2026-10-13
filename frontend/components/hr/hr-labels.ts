import type {
  DocumentVerificationStatus,
  EmployeeDocumentType,
  EmployeeEventType,
  EmployeeStatus,
  EmploymentType,
  OrgUnitStatus,
  WorkMode,
} from '@rs/shared';

/**
 * How HR values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend test suite can
 * assert them directly — the project's convention for presentation logic, and the
 * reason these are not inlined into the components that render them.
 *
 * The labels live here rather than in @rs/shared because they are presentation,
 * not contract: the backend never sends them and nothing is validated against
 * them. The enums they key on are the shared contract.
 */

export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = {
  PROBATION: 'Probation',
  ACTIVE: 'Active',
  ON_NOTICE: 'On notice',
  EXITED: 'Exited',
  INACTIVE: 'Inactive',
};

/**
 * The visual weight each status carries.
 *
 * `ON_NOTICE` is a warning rather than neutral, deliberately: somebody serving
 * notice is still employed, so a neutral badge would read as "nothing to see",
 * when in fact it is the one status that implies a deadline. `EXITED` is neutral
 * rather than destructive — leaving is an ordinary event, not an error, and a red
 * badge against a former colleague's name would be editorialising.
 */
export const EMPLOYEE_STATUS_TONES: Record<
  EmployeeStatus,
  'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline'
> = {
  PROBATION: 'accent',
  ACTIVE: 'positive',
  ON_NOTICE: 'warning',
  EXITED: 'neutral',
  INACTIVE: 'outline',
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
  CONSULTANT: 'Consultant',
};

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  ON_SITE: 'On site',
  REMOTE: 'Remote',
  HYBRID: 'Hybrid',
};

export const ORG_UNIT_STATUS_LABELS: Record<OrgUnitStatus, string> = {
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
};

export const EMPLOYEE_DOCUMENT_TYPE_LABELS: Record<EmployeeDocumentType, string> = {
  IDENTITY_PROOF: 'Identity proof',
  ADDRESS_PROOF: 'Address proof',
  EDUCATION_CERTIFICATE: 'Education certificate',
  EXPERIENCE_LETTER: 'Experience letter',
  OFFER_LETTER: 'Offer letter',
  APPOINTMENT_LETTER: 'Appointment letter',
  CONTRACT: 'Contract',
  RESUME: 'Resume',
  OTHER: 'Other',
};

export const VERIFICATION_STATUS_LABELS: Record<DocumentVerificationStatus, string> = {
  PENDING: 'Not verified',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
};

/**
 * One history entry as a sentence.
 *
 * Written as prose rather than "DEPARTMENT_CHANGED: Sales → Ops" because a
 * timeline is read by people, and an enum name on screen is a leaked
 * implementation detail. The from/to values are already display strings — the
 * service stores names rather than ids precisely so this stays readable after a
 * department is renamed.
 */
export function describeEmployeeEvent(entry: {
  eventType: EmployeeEventType;
  fromValue: string | null;
  toValue: string | null;
}): string {
  const { eventType, fromValue, toValue } = entry;

  switch (eventType) {
    case 'JOINED':
      return toValue ? `Joined as ${toValue}` : 'Joined';
    case 'DEPARTMENT_CHANGED':
      return movement('Department', fromValue, toValue);
    case 'DESIGNATION_CHANGED':
      return movement('Designation', fromValue, toValue);
    case 'MANAGER_CHANGED':
      if (!toValue) return fromValue ? `No longer reports to ${fromValue}` : 'Manager removed';
      return fromValue ? `Now reports to ${toValue}, previously ${fromValue}` : `Now reports to ${toValue}`;
    case 'STATUS_CHANGED':
      return movement('Status', fromValue, toValue);
    case 'EMPLOYMENT_TYPE_CHANGED':
      return movement('Employment type', fromValue, toValue);
    case 'WORK_MODE_CHANGED':
      return movement('Work mode', fromValue, toValue);
    case 'USER_LINKED':
      return toValue ? `CRM account linked (${toValue})` : 'CRM account linked';
    case 'USER_UNLINKED':
      return fromValue ? `CRM account unlinked (${fromValue})` : 'CRM account unlinked';
  }
}

/** "Department changed from Sales to Operations", handling either end missing. */
function movement(subject: string, from: string | null, to: string | null): string {
  if (from && to) return `${subject} changed from ${from} to ${to}`;
  if (to) return `${subject} set to ${to}`;
  if (from) return `${subject} cleared (was ${from})`;
  return `${subject} changed`;
}

/**
 * A date as HR reads it — "12 Mar 2026".
 *
 * `en-IN` with an explicit UTC time zone. The time zone matters: a joining date
 * stored as midnight UTC renders as the previous day in any negative offset, so a
 * colleague's start date would be wrong by one for half the world. These are
 * calendar dates, not moments, so they are formatted as the calendar date stored.
 */
export function formatHrDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * How long somebody has been here, as a phrase.
 *
 * Derived from the dates on every render rather than stored: a stored tenure is
 * wrong the next morning. Uses the exit date when there is one, so a former
 * colleague's tenure stops at their last day instead of continuing to grow.
 */
export function formatTenure(joiningDate: string, exitDate: string | null): string {
  const start = new Date(joiningDate);
  const end = exitDate ? new Date(exitDate) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '—';
  if (end < start) return '—';

  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());

  if (months < 1) return 'Less than a month';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;

  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const yearPart = `${years} year${years === 1 ? '' : 's'}`;
  return remainder === 0 ? yearPart : `${yearPart} ${remainder} month${remainder === 1 ? '' : 's'}`;
}
