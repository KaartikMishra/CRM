/**
 * The HR frontend, asserted without a DOM.
 *
 * Two kinds of test, matching the convention the other suites in this directory
 * follow:
 *
 *   1. **Pure logic**, called directly. The label maps, the event prose, the date
 *      and tenure formatting — all exported from `hr-labels.ts` precisely so they
 *      can be tested as functions rather than through a render.
 *   2. **Structural assertions** over the page source, for the properties that are
 *      about *what the page does not do*: not deriving a business figure in the
 *      browser, not rendering a document URL, not assuming the viewer holds HR
 *      permission. Those cannot be observed from rendered output — a page that
 *      computes the wrong thing renders perfectly well.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_DOCUMENT_TYPES,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  ORG_UNIT_STATUSES,
  WORK_MODES,
  DOCUMENT_VERIFICATION_STATUSES,
} from '@rs/shared';
import {
  EMPLOYEE_DOCUMENT_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_STATUS_TONES,
  EMPLOYMENT_TYPE_LABELS,
  ORG_UNIT_STATUS_LABELS,
  VERIFICATION_STATUS_LABELS,
  WORK_MODE_LABELS,
  describeEmployeeEvent,
  formatHrDate,
  formatTenure,
} from '@/components/hr/hr-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by the "this page does not do X" assertions below, and the reason is
 * worth stating because it bit this suite: those files *document* what they
 * deliberately omit, so a naive substring search for "gender" or "attrition"
 * matches the comment explaining their absence and fails a passing file. The
 * assertion means "no code does this", so the comments have to go first.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

describe('every enum value has a label', () => {
  /*
    The failure this prevents: a lookup like LABELS[value] returns undefined for a
    value nobody added, and React renders nothing — so a status silently disappears
    from the table rather than erroring anywhere.
  */
  it('covers every employee status', () => {
    for (const status of EMPLOYEE_STATUSES) {
      expect(EMPLOYEE_STATUS_LABELS[status], status).toBeTruthy();
      expect(EMPLOYEE_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('covers every employment type, work mode and org status', () => {
    for (const type of EMPLOYMENT_TYPES) expect(EMPLOYMENT_TYPE_LABELS[type], type).toBeTruthy();
    for (const mode of WORK_MODES) expect(WORK_MODE_LABELS[mode], mode).toBeTruthy();
    for (const status of ORG_UNIT_STATUSES) {
      expect(ORG_UNIT_STATUS_LABELS[status], status).toBeTruthy();
    }
  });

  it('covers every document type and verification status', () => {
    for (const type of EMPLOYEE_DOCUMENT_TYPES) {
      expect(EMPLOYEE_DOCUMENT_TYPE_LABELS[type], type).toBeTruthy();
    }
    for (const status of DOCUMENT_VERIFICATION_STATUSES) {
      expect(VERIFICATION_STATUS_LABELS[status], status).toBeTruthy();
    }
  });

  it('shows no enum name to a person', () => {
    // An enum member on screen is a leaked implementation detail.
    for (const label of Object.values(EMPLOYEE_STATUS_LABELS)) {
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('gives ON_NOTICE a warning tone rather than a neutral one', () => {
    /*
      Deliberate: somebody serving notice is still employed, so a neutral badge
      would read as "nothing to see" when it is the one status implying a deadline.
      EXITED stays neutral — leaving is an ordinary event, and a red badge against
      a former colleague's name would be editorialising.
    */
    expect(EMPLOYEE_STATUS_TONES.ON_NOTICE).toBe('warning');
    expect(EMPLOYEE_STATUS_TONES.EXITED).toBe('neutral');
    expect(EMPLOYEE_STATUS_TONES.ACTIVE).toBe('positive');
  });
});

// ---------------------------------------------------------------------------
//  History prose
// ---------------------------------------------------------------------------

describe('history entries read as sentences', () => {
  it('describes a transfer with both ends', () => {
    expect(
      describeEmployeeEvent({
        eventType: 'DEPARTMENT_CHANGED',
        fromValue: 'Sales',
        toValue: 'Operations',
      }),
    ).toBe('Department changed from Sales to Operations');
  });

  it('handles a value being set for the first time', () => {
    expect(
      describeEmployeeEvent({ eventType: 'DESIGNATION_CHANGED', fromValue: null, toValue: 'Lead' }),
    ).toBe('Designation set to Lead');
  });

  it('handles a value being cleared', () => {
    expect(
      describeEmployeeEvent({ eventType: 'WORK_MODE_CHANGED', fromValue: 'REMOTE', toValue: null }),
    ).toContain('cleared');
  });

  it('reads a manager change as a reporting line, not a field edit', () => {
    expect(
      describeEmployeeEvent({ eventType: 'MANAGER_CHANGED', fromValue: null, toValue: 'Asha' }),
    ).toBe('Now reports to Asha');
    expect(
      describeEmployeeEvent({ eventType: 'MANAGER_CHANGED', fromValue: 'Asha', toValue: null }),
    ).toContain('No longer reports to Asha');
  });

  it('never renders an enum name', () => {
    const events = [
      'JOINED', 'DEPARTMENT_CHANGED', 'DESIGNATION_CHANGED', 'MANAGER_CHANGED',
      'STATUS_CHANGED', 'EMPLOYMENT_TYPE_CHANGED', 'WORK_MODE_CHANGED',
      'USER_LINKED', 'USER_UNLINKED',
    ] as const;

    for (const eventType of events) {
      const text = describeEmployeeEvent({ eventType, fromValue: null, toValue: null });
      expect(text, eventType).toBeTruthy();
      expect(text, eventType).not.toContain('_');
    }
  });
});

// ---------------------------------------------------------------------------
//  Dates and tenure
// ---------------------------------------------------------------------------

describe('date formatting', () => {
  it('renders the calendar date that was stored, not a shifted one', () => {
    /*
      The bug this guards: a joining date stored as midnight UTC renders as the
      previous day in any negative offset, so a colleague's start date would be
      wrong by one for half the world. These are calendar dates, not moments.
    */
    expect(formatHrDate('2026-03-12T00:00:00.000Z')).toBe('12 Mar 2026');
  });

  it('shows a dash for an absent or unparseable date', () => {
    expect(formatHrDate(null)).toBe('—');
    expect(formatHrDate('not-a-date')).toBe('—');
  });
});

describe('tenure', () => {
  it('counts whole months and years', () => {
    expect(formatTenure('2024-01-15T00:00:00.000Z', '2026-01-15T00:00:00.000Z')).toBe('2 years');
    expect(formatTenure('2025-01-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')).toBe(
      '1 year 3 months',
    );
    expect(formatTenure('2026-01-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z')).toBe('3 months');
  });

  it('singularises one month and one year', () => {
    expect(formatTenure('2026-01-15T00:00:00.000Z', '2026-02-15T00:00:00.000Z')).toBe('1 month');
    expect(formatTenure('2025-01-15T00:00:00.000Z', '2026-01-15T00:00:00.000Z')).toBe('1 year');
  });

  it('stops at the exit date rather than continuing to grow', () => {
    // A former colleague's tenure is a fixed fact. Deriving it from `now` would
    // make a departed employee's record change every month.
    const atExit = formatTenure('2024-01-15T00:00:00.000Z', '2025-01-15T00:00:00.000Z');
    expect(atExit).toBe('1 year');
  });

  it('handles a joining date in the future without nonsense', () => {
    const future = new Date(Date.now() + 90 * 86_400_000).toISOString();
    expect(formatTenure(future, null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
//  Structural properties of the pages
// ---------------------------------------------------------------------------

describe('the directory page', () => {
  const source = codeOf('app/(app)/hr/employees/page.tsx');

  it('does not gate the page on HR_EMPLOYEE being granted', () => {
    /*
      Deliberate, and the one thing most likely to be "fixed" into a bug: a manager
      who holds no HR permission still needs their own team, and the backend scopes
      the query. Adding `if (!access.allowed) return <NoModuleAccess/>` here would
      lock those managers out of a page the API would happily serve them.
    */
    expect(source).toContain('requireModule');
    expect(source).not.toMatch(/if\s*\(!access\.allowed\)\s*return\s*<NoModuleAccess/);
  });

  it('gates the create button on CREATE, and on access being granted', () => {
    expect(source).toContain("can(access.user, 'HR_EMPLOYEE', 'CREATE')");
    expect(source).toContain('access.allowed &&');
  });

  it('renders an empty state that distinguishes "filtered" from "nothing"', () => {
    expect(source).toContain('EmptyState');
    expect(source).toContain('Try widening them');
  });

  it('renders an error state', () => {
    expect(source).toContain('ErrorMessage');
    expect(source).toContain('!result.success');
  });

  it('computes no business figure in the browser', () => {
    // Head counts, display names and tenure all arrive derived from the service.
    // A second calculation here would be a second answer.
    expect(source).not.toMatch(/\.filter\([^)]*status\s*===\s*'ACTIVE'\)\.length/);
    expect(source).not.toContain('firstName} {');
  });
});

describe('the profile page', () => {
  const source = codeOf('app/(app)/hr/employees/[id]/page.tsx');

  it('renders the sections the brief asks for', () => {
    for (const section of ['Employment', 'Organization', 'Direct reports', 'CRM account', 'History']) {
      expect(source, section).toContain(section);
    }
  });

  it('never renders a document URL', () => {
    /*
      The central property of the secure-document design. A link is minted by its
      own endpoint, per request, after the server re-resolves permission — so there
      is deliberately no href, src or window.open against a document here. A stored
      or rendered URL would outlive every access check.
    */
    expect(source).not.toMatch(/document\.(url|secureUrl|publicId)/);
    expect(source).not.toContain('window.open');
  });

  it('treats a missing employee as not found rather than as an error', () => {
    // 404 rather than a 403-shaped message: the API reports out-of-scope records as
    // missing so nobody can enumerate the directory by probing ids.
    expect(source).toContain('notFound()');
    expect(source).toContain('EMPLOYEE_NOT_FOUND');
  });

  it('shows documents only when the service sent any', () => {
    // Withheld server-side for a viewer without HR_EMPLOYEE:VIEW, so the metadata
    // never reaches the browser — this page only declines to draw an empty section.
    expect(source).toContain('employee.documents.length > 0');
  });
});

describe('the create form', () => {
  const source = codeOf('components/hr/create-employee-form.tsx');

  it('does not offer an employee ID field', () => {
    /*
      Allocated by the server from an atomic counter. A browser-supplied id would
      collide under concurrent creates, which is the entire reason that counter
      exists rather than a max+1 scan.
    */
    expect(source).not.toMatch(/name="employeeId"/);
  });

  it('does not offer a status field', () => {
    // A new record is ACTIVE; every move after that goes through the status
    // endpoint so it writes history.
    expect(source).not.toMatch(/name="status"/);
  });

  it('collects no sensitive personal data', () => {
    /*
      No date of birth, gender, home address or emergency contact. Each needs a
      stated purpose, a retention rule and a narrower read scope than "anybody with
      HR_EMPLOYEE:VIEW" before it is collected. Payroll and bank data are not Phase 1
      at all.
    */
    const code = executableCodeOf('components/hr/create-employee-form.tsx').toLowerCase();
    for (const field of ['dateofbirth', 'gender', 'emergencycontact', 'bankaccount', 'salary', 'aadhaar']) {
      expect(code, field).not.toContain(field);
    }
  });

  it('shows server-side field errors against their fields', () => {
    expect(source).toContain('result.details');
    expect(source).toContain('fieldErrors');
  });

  it('mirrors no validation rule from the server', () => {
    // Two validators drift, and the server's is the one that decides. The only
    // client check is the one the native form needs to submit at all.
    expect(source).not.toContain('regex');
    expect(source).not.toContain('.email(');
  });

  it('disables submission while in flight', () => {
    expect(source).toContain('disabled={pending}');
  });
});

describe('the HR overview', () => {
  const source = codeOf('app/(app)/hr/page.tsx');

  it('shows only figures Phase 1 can answer', () => {
    expect(source).toContain('totalEmployees');
    expect(source).toContain('employedCount');
    expect(source).toContain('activeDepartments');
    expect(source).toContain('activeDesignations');
  });

  it('invents no analytics', () => {
    /*
      Phase 1 holds no time series. A tile reading "0% attrition" would be a
      confident lie rather than an honest absence, and HR analytics is Phase 7.
    */
    const code = executableCodeOf('app/(app)/hr/page.tsx');
    for (const word of ['attrition', 'Chart', 'trend', 'averageTenure', 'diversity', 'headcountTrend']) {
      expect(code, word).not.toContain(word);
    }
  });

  it('shows the organization links only to somebody holding HR_ADMIN', () => {
    expect(source).toContain("can(access.user, 'HR_ADMIN', 'VIEW')");
    expect(source).toContain('canAdminOrg &&');
  });
});

describe('the organization pages', () => {
  it('gate on HR_ADMIN rather than HR_EMPLOYEE', () => {
    for (const page of ['app/(app)/hr/departments/page.tsx', 'app/(app)/hr/designations/page.tsx']) {
      const source = codeOf(page);
      expect(source, page).toContain("requireModule('HR_ADMIN')");
      expect(source, page).toContain('NoModuleAccess');
    }
  });

  it('offer no delete action', () => {
    // A department with employees against it is referenced history; ARCHIVED stops
    // it being offered to new records while keeping every reference readable.
    for (const page of ['app/(app)/hr/departments/page.tsx', 'app/(app)/hr/designations/page.tsx']) {
      expect(executableCodeOf(page).toLowerCase(), page).not.toContain('delete');
    }
  });
});

describe('the server actions', () => {
  const source = codeOf('app/(app)/hr/actions.ts');

  it('derive no employee id', () => {
    expect(source).not.toMatch(/RS\$\{/);
    expect(source).not.toContain('padStart');
  });

  it('revalidate the directory and the overview, not only the page edited', () => {
    /*
      Department, designation, manager and status are columns on the directory
      derived from the rows these writes touch, and the overview counts come from
      the same rows — so a transfer has to change all three screens.
    */
    expect(source).toContain("revalidatePath('/hr/employees')");
    expect(source).toContain("revalidatePath('/hr')");
  });

  it('relay the backend answer rather than deciding anything', () => {
    expect(source).toContain('result.message');
    expect(source).toContain('result.code');
  });
});
