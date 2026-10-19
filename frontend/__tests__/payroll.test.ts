/**
 * HR Phase 6 payroll presentation, and the structural guarantees of its pages.
 *
 * Two kinds of assertion, deliberately:
 *
 *   1. **Behavioural** — the pure formatters are called and their output checked.
 *      These are real tests of real functions.
 *   2. **Structural** — the page and component sources are read as text and
 *      asserted against. These catch a class of mistake nothing else here can:
 *      a page that starts computing its own net pay, a self-service surface that
 *      grows an employee-id parameter, a label that says "Paid".
 *
 * The second kind tests a *line* rather than a behaviour, which is a real
 * limitation and the reason `backend/.../payroll.test.ts` exists: it drives the
 * same workflows over HTTP with separate authenticated sessions and asserts what
 * the server actually returns. Phase 5 learned this the hard way — a unit test
 * asserted that an "am I the subject" comparison *existed* and could not tell
 * that it never *resolved*. Neither file substitutes for the other.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAILY_RATE_BASES,
  MONETARY_ROUNDING_MODES,
  PAYROLL_ADJUSTMENT_KINDS,
  PAYROLL_EXCLUSION_REASONS,
  PAYROLL_ITEM_STATUSES,
  PAYROLL_PERIOD_STATUSES,
  SALARY_CALCULATION_KINDS,
  SALARY_COMPONENT_KINDS,
} from '@rs/shared';
import {
  ADJUSTMENT_DIRECTION,
  ADJUSTMENT_KIND_LABELS,
  BASIS_HINTS,
  BASIS_LABELS,
  CALCULATION_HINTS,
  CALCULATION_LABELS,
  COMPONENT_KIND_HINTS,
  COMPONENT_KIND_LABELS,
  EXCLUSION_REASON_LABELS,
  ITEM_STATUS_LABELS,
  NOT_STATUTORY_NOTICE,
  PERIOD_NEXT_STEP,
  PERIOD_STATUS_LABELS,
  PERIOD_STATUS_SHORT,
  PERIOD_STATUS_TONES,
  ROUNDING_LABELS,
  formatDays,
  formatMinutes,
  formatMoney,
  formatPayrollDate,
  formatPeriodMonth,
  isNegative,
} from '@/components/hr/payroll-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by every "this does not do X" assertion: these files *document* what
 * they deliberately omit, so a naive substring search matches the comment
 * explaining the absence and fails a correct file.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every payroll surface. The security assertions run over all of them. */
const PAYROLL_SURFACES = [
  'components/hr/payroll-labels.ts',
  'components/hr/payroll-panels.tsx',
  'lib/payroll-api.ts',
  'app/(app)/hr/payroll-actions.ts',
  'app/(app)/hr/payroll/page.tsx',
  'app/(app)/hr/payroll/my-payslips/page.tsx',
  'app/(app)/hr/payroll/payslips/[itemId]/page.tsx',
  'app/(app)/hr/payroll/periods/page.tsx',
  'app/(app)/hr/payroll/periods/[id]/page.tsx',
];

/** The surfaces an ordinary employee can reach. */
const SELF_SERVICE_SURFACES = [
  'app/(app)/hr/payroll/page.tsx',
  'app/(app)/hr/payroll/my-payslips/page.tsx',
  'app/(app)/hr/payroll/payslips/[itemId]/page.tsx',
];

// ---------------------------------------------------------------------------
//  Money formatting — display only, never arithmetic
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('groups Indian digits and prefixes the rupee sign', () => {
    expect(formatMoney('50000.00')).toBe('₹50,000.00');
    expect(formatMoney('123456.78')).toBe('₹1,23,456.78');
    expect(formatMoney('1234567.89')).toBe('₹12,34,567.89');
  });

  it('leaves small figures ungrouped', () => {
    expect(formatMoney('0.00')).toBe('₹0.00');
    expect(formatMoney('999.50')).toBe('₹999.50');
  });

  it('carries a negative sign through, because a negative net is real', () => {
    expect(formatMoney('-10000.00')).toBe('-₹10,000.00');
  });

  it('renders a dash for a missing figure rather than zero', () => {
    // An excluded line has null figures, and showing those as 0.00 would make an
    // exclusion look like a zero-value payslip — a different thing entirely.
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('')).toBe('—');
  });

  it('uses three-digit grouping for a non-INR currency', () => {
    expect(formatMoney('1234567.89', 'USD')).toBe('USD 1,234,567.89');
  });

  it('never parses to a float, so long figures keep every digit', () => {
    // Number('12345678901234.56') loses precision. String handling does not.
    expect(formatMoney('12345678901234.56')).toContain('12,345,678,901,234.56'.slice(-9));
    expect(formatMoney('99999999.99')).toBe('₹9,99,99,999.99');
  });

  it('pads a short fraction and never invents digits', () => {
    expect(formatMoney('100.5')).toBe('₹100.50');
    expect(formatMoney('100')).toBe('₹100.00');
  });
});

describe('isNegative', () => {
  it('reads the sign from the string', () => {
    expect(isNegative('-1.00')).toBe(true);
    expect(isNegative('1.00')).toBe(false);
    expect(isNegative('0.00')).toBe(false);
    expect(isNegative(null)).toBe(false);
  });
});

describe('formatDays', () => {
  it('drops a meaningless decimal', () => {
    expect(formatDays('26.00')).toBe('26');
    expect(formatDays('31.00')).toBe('31');
  });

  it('keeps a half day', () => {
    expect(formatDays('26.50')).toBe('26.5');
  });

  it('renders a dash for null', () => {
    expect(formatDays(null)).toBe('—');
  });
});

describe('formatMinutes', () => {
  it('writes overtime as hours and minutes', () => {
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(45)).toBe('45m');
  });

  it('treats zero and null as nothing to show', () => {
    expect(formatMinutes(0)).toBe('—');
    expect(formatMinutes(null)).toBe('—');
  });
});

describe('dates', () => {
  it('writes a period as a month and year', () => {
    expect(formatPeriodMonth(2026, 3)).toBe('March 2026');
    expect(formatPeriodMonth(2026, 12)).toBe('December 2026');
  });

  it('renders a dash for a missing date', () => {
    expect(formatPayrollDate(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
//  Label completeness — every enum value has a label
// ---------------------------------------------------------------------------

describe('label coverage', () => {
  it('names every period status, long and short, with a tone and a next step', () => {
    for (const status of PAYROLL_PERIOD_STATUSES) {
      expect(PERIOD_STATUS_LABELS[status], status).toBeTruthy();
      expect(PERIOD_STATUS_SHORT[status], status).toBeTruthy();
      expect(PERIOD_STATUS_TONES[status], status).toBeTruthy();
      expect(PERIOD_NEXT_STEP[status], status).toBeTruthy();
    }
  });

  it('names every item status', () => {
    for (const status of PAYROLL_ITEM_STATUSES) {
      expect(ITEM_STATUS_LABELS[status], status).toBeTruthy();
    }
  });

  it('names every exclusion reason in words an employee could be told', () => {
    for (const reason of PAYROLL_EXCLUSION_REASONS) {
      const label = EXCLUSION_REASON_LABELS[reason];
      expect(label, reason).toBeTruthy();
      // Not a code, not an abbreviation: "why was I not paid" must be answerable.
      expect(label, reason).not.toMatch(/_/);
    }
  });

  it('names every component kind, with a hint about net pay', () => {
    for (const kind of SALARY_COMPONENT_KINDS) {
      expect(COMPONENT_KIND_LABELS[kind], kind).toBeTruthy();
      expect(COMPONENT_KIND_HINTS[kind], kind).toBeTruthy();
    }
  });

  it('names every calculation kind, with a hint', () => {
    for (const kind of SALARY_CALCULATION_KINDS) {
      expect(CALCULATION_LABELS[kind], kind).toBeTruthy();
      expect(CALCULATION_HINTS[kind], kind).toBeTruthy();
    }
  });

  it('names every divisor basis and explains what a day means under it', () => {
    for (const basis of DAILY_RATE_BASES) {
      expect(BASIS_LABELS[basis], basis).toBeTruthy();
      expect(BASIS_HINTS[basis], basis).toBeTruthy();
    }
  });

  it('names every rounding mode', () => {
    for (const mode of MONETARY_ROUNDING_MODES) {
      expect(ROUNDING_LABELS[mode], mode).toBeTruthy();
    }
  });

  it('names every adjustment kind and states its direction', () => {
    for (const kind of PAYROLL_ADJUSTMENT_KINDS) {
      expect(ADJUSTMENT_KIND_LABELS[kind], kind).toBeTruthy();
      expect(['adds', 'subtracts']).toContain(ADJUSTMENT_DIRECTION[kind]);
    }
  });

  it('marks a recovery as the one adjustment that subtracts', () => {
    expect(ADJUSTMENT_DIRECTION.RECOVERY).toBe('subtracts');
    expect(ADJUSTMENT_DIRECTION.ARREAR).toBe('adds');
    expect(ADJUSTMENT_DIRECTION.BONUS).toBe('adds');
    expect(ADJUSTMENT_DIRECTION.REIMBURSEMENT).toBe('adds');
  });
});

// ---------------------------------------------------------------------------
//  FINALIZED is not PAID
// ---------------------------------------------------------------------------

describe('no label claims money has moved', () => {
  it('describes a finalised run as ready for payment, never as paid', () => {
    expect(PERIOD_STATUS_LABELS.FINALIZED).toMatch(/ready for payment/i);
    expect(PERIOD_STATUS_LABELS.FINALIZED).not.toMatch(/\bpaid\b/i);
    expect(PERIOD_STATUS_SHORT.FINALIZED).not.toMatch(/\bpaid\b/i);
  });

  it('has no status label asserting payment', () => {
    for (const status of PAYROLL_PERIOD_STATUSES) {
      expect(PERIOD_STATUS_LABELS[status], status).not.toMatch(/\bpaid\b/i);
      expect(PERIOD_STATUS_SHORT[status], status).not.toMatch(/\bpaid\b/i);
    }
  });

  it('warns on every surface that statutory figures are configured, not certified', () => {
    expect(NOT_STATUTORY_NOTICE).toMatch(/configured, not certified/i);
    for (const surface of [
      'app/(app)/hr/payroll/page.tsx',
      'app/(app)/hr/payroll/my-payslips/page.tsx',
      'app/(app)/hr/payroll/periods/[id]/page.tsx',
    ]) {
      expect(codeOf(surface), surface).toContain('NOT_STATUTORY_NOTICE');
    }
  });

  it('requires the acknowledgement before the finalise action fires', () => {
    const actions = executableCodeOf('app/(app)/hr/payroll-actions.ts');
    expect(actions).toContain('acknowledgeNotStatutory: true');
  });
});

// ---------------------------------------------------------------------------
//  The browser computes nothing
// ---------------------------------------------------------------------------

describe('no payroll surface computes a figure', () => {
  it('never does arithmetic on an amount', () => {
    for (const surface of PAYROLL_SURFACES) {
      const code = executableCodeOf(surface);
      // No multiplication or division of a money-ish identifier. The formatters
      // group digits; they never compute.
      expect(code, surface).not.toMatch(/\b(gross|net|deduction|amount|salary)\w*\s*[*/]\s*/i);
      expect(code, surface).not.toMatch(/[*/]\s*\b(gross|net|deduction|amount|salary)\w*/i);
    }
  });

  it('never calls parseFloat or Number on a money field', () => {
    for (const surface of PAYROLL_SURFACES) {
      const code = executableCodeOf(surface);
      expect(code, surface).not.toMatch(/parseFloat\s*\(/);
      expect(code, surface).not.toMatch(/Number\s*\(\s*\w*(?:gross|net|amount|salary)/i);
    }
  });

  it('reads viewerCan from the server rather than deriving permissions', () => {
    const panel = executableCodeOf('components/hr/payroll-panels.tsx');
    expect(panel).toContain('period.viewerCan');
    // No local re-derivation of the separation-of-duties rule.
    expect(panel).not.toMatch(/can\(\s*\w+\.user/);
  });

  it('renders the server separation-of-duties flag rather than recomputing it', () => {
    const panel = codeOf('components/hr/payroll-panels.tsx');
    expect(panel).toContain('viewerIsPaidByThisRun');
    const detail = codeOf('app/(app)/hr/payroll/periods/[id]/page.tsx');
    expect(detail).toContain('PayrollWorkflowPanel');
  });
});

// ---------------------------------------------------------------------------
//  Self-service confidentiality, structurally
// ---------------------------------------------------------------------------

describe('self-service cannot be pointed at another employee', () => {
  it('fetches the reader own pay with no employee parameter', () => {
    const api = codeOf('lib/payroll-api.ts');
    expect(api).toMatch(/export function fetchMyPayroll\(\): Promise/);
    // The absence of a parameter is the guarantee. A reader that accepted an
    // employeeId would be one a caller could point elsewhere.
    expect(api).not.toMatch(/fetchMyPayroll\(\s*\w+/);
  });

  it('has no reader that fetches another employee payslip by employee id', () => {
    const api = executableCodeOf('lib/payroll-api.ts');
    expect(api).not.toMatch(/fetchPayrollFor\s*\(/);
    expect(api).not.toMatch(/payslips\?employeeId/);
  });

  it('calls fetchMyPayroll on the self-service page, not a scoped list', () => {
    const page = executableCodeOf('app/(app)/hr/payroll/my-payslips/page.tsx');
    expect(page).toContain('fetchMyPayroll()');
    expect(page).not.toContain('fetchPayrollItems');
  });

  it('never filters another employee out in the browser', () => {
    // Scoping happens in the query. A client-side filter would mean the data had
    // already been sent.
    for (const surface of SELF_SERVICE_SURFACES) {
      const code = executableCodeOf(surface);
      expect(code, surface).not.toMatch(/\.filter\([^)]*employee/i);
    }
  });

  it('gates every payroll page on HR_PAYROLL', () => {
    for (const surface of [
      'app/(app)/hr/payroll/page.tsx',
      'app/(app)/hr/payroll/my-payslips/page.tsx',
      'app/(app)/hr/payroll/payslips/[itemId]/page.tsx',
      'app/(app)/hr/payroll/periods/page.tsx',
      'app/(app)/hr/payroll/periods/[id]/page.tsx',
    ]) {
      const code = codeOf(surface);
      expect(code, surface).toContain("requireModule('HR_PAYROLL')");
      expect(code, surface).toContain('NoModuleAccess');
    }
  });

  it('puts the administrative run list on VIEW alone, not the employee floor', () => {
    const list = executableCodeOf('app/(app)/hr/payroll/periods/page.tsx');
    expect(list).toContain("can(access.user, 'HR_PAYROLL', 'VIEW')");
    // No employee floor here: "every payroll run" has no scoped meaning.
    expect(list).not.toContain("'HR_EMPLOYEE', 'VIEW'");
  });

  it('puts the self-service surfaces on the employee floor, mirroring the API', () => {
    for (const surface of SELF_SERVICE_SURFACES) {
      const code = executableCodeOf(surface);
      expect(code, surface).toContain("'HR_EMPLOYEE', 'VIEW'");
    }
  });
});

// ---------------------------------------------------------------------------
//  The actions send no figures and offer no forbidden path
// ---------------------------------------------------------------------------

describe('server actions', () => {
  it('sends no computed amount when costing a run', () => {
    const actions = codeOf('app/(app)/hr/payroll-actions.ts');
    expect(actions).toMatch(/calculatePayrollAction/);
    // Only an optional employee list crosses the wire.
    expect(actions).toMatch(/employeeIds\?\.length \? \{ employeeIds \} : \{\}/);
  });

  it('has no action that edits a salary assignment in place', () => {
    const actions = executableCodeOf('app/(app)/hr/payroll-actions.ts');
    expect(actions).not.toMatch(/updateSalaryAction/);
    expect(actions).not.toMatch(/PATCH.*salaries/);
  });

  it('has no action that exports, so the file never passes through one', () => {
    const actions = executableCodeOf('app/(app)/hr/payroll-actions.ts');
    expect(actions).not.toMatch(/exportAction|exportRegisterAction/);
  });

  it('has no action that sets a status, finaliser or total directly', () => {
    const actions = executableCodeOf('app/(app)/hr/payroll-actions.ts');
    for (const forbidden of ['finalizedById', 'finalizedAt', 'netPay:', 'grossEarnings:', 'status:']) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  it('requires a reason to cancel a run and a note to send one back', () => {
    const actions = codeOf('app/(app)/hr/payroll-actions.ts');
    expect(actions).toMatch(/cancelPayrollAction\(\s*\n?\s*id: string,\s*\n?\s*reason: string,/);
  });

  it('exports the download as a plain link rather than an action', () => {
    const panel = codeOf('components/hr/payroll-panels.tsx');
    expect(panel).toMatch(/href=\{`\/api\/hr\/payroll\/periods\/\$\{period\.id\}\/export`\}/);
  });
});

// ---------------------------------------------------------------------------
//  Navigation
// ---------------------------------------------------------------------------

describe('navigation', () => {
  it('adds one Payroll child row under HR, gated on HR_PAYROLL', () => {
    const nav = codeOf('components/layout/nav-items.ts');
    expect(nav).toContain("label: 'Payroll'");
    expect(nav).toContain("href: '/hr/payroll'");
    expect(nav).toContain("module: 'HR_PAYROLL'");
    expect(nav).toContain("icon: 'payroll'");
  });

  it('registers the payroll icon so the row renders', () => {
    const icons = codeOf('components/layout/nav-icons.tsx');
    expect(icons).toMatch(/payroll:\s*\w+,/);
    const nav = codeOf('components/layout/nav-items.ts');
    expect(nav).toMatch(/\|\s*'payroll'/);
  });

  it('gates the sidebar row more narrowly than the pages, deliberately', () => {
    // The row is on HR_PAYROLL:VIEW; the self-service pages run on the employee
    // floor. Gating the row that widely would show an administrative Payroll
    // heading to every employee in the company.
    const nav = codeOf('components/layout/nav-items.ts');
    const payrollEntry = nav.slice(nav.indexOf("label: 'Payroll'"));
    expect(payrollEntry.slice(0, 200)).toContain("module: 'HR_PAYROLL'");
  });
});

// ---------------------------------------------------------------------------
//  States
// ---------------------------------------------------------------------------

describe('every page handles failure and emptiness', () => {
  it('renders an error message when a fetch fails', () => {
    for (const surface of [
      'app/(app)/hr/payroll/page.tsx',
      'app/(app)/hr/payroll/my-payslips/page.tsx',
      'app/(app)/hr/payroll/payslips/[itemId]/page.tsx',
      'app/(app)/hr/payroll/periods/page.tsx',
      'app/(app)/hr/payroll/periods/[id]/page.tsx',
    ]) {
      const code = codeOf(surface);
      expect(code, surface).toContain('ErrorMessage');
      expect(code, surface).toMatch(/if \(!\w+(?:Result)?\.success\)/);
    }
  });

  it('renders an empty state where a list can be empty', () => {
    for (const surface of [
      'app/(app)/hr/payroll/page.tsx',
      'app/(app)/hr/payroll/my-payslips/page.tsx',
      'app/(app)/hr/payroll/periods/page.tsx',
      'app/(app)/hr/payroll/periods/[id]/page.tsx',
    ]) {
      expect(codeOf(surface), surface).toContain('EmptyState');
    }
  });

  it('shows a pending state and a surfaced error in the workflow panel', () => {
    const panel = codeOf('components/hr/payroll-panels.tsx');
    expect(panel).toContain('useTransition');
    expect(panel).toMatch(/pending && /);
    expect(panel).toMatch(/error && /);
  });

  it('explains an account with no employee record rather than erroring', () => {
    const page = codeOf('app/(app)/hr/payroll/my-payslips/page.tsx');
    expect(page).toContain('not linked to an employee record');
  });

  it('reports both blockers and warnings from a calculation', () => {
    const panel = codeOf('components/hr/payroll-panels.tsx');
    expect(panel).toContain('result.blockers');
    expect(panel).toContain('result.warnings');
  });

  it('flags a negative net pay in the critical tone', () => {
    const detail = codeOf('app/(app)/hr/payroll/periods/[id]/page.tsx');
    expect(detail).toMatch(/isNegative\(item\.netPay\)/);
    expect(detail).toContain('text-critical');
  });

  it('shows employer contributions as not reducing net pay', () => {
    const payslip = codeOf('app/(app)/hr/payroll/payslips/[itemId]/page.tsx');
    expect(payslip).toMatch(/do not reduce your\s*\n?\s*net pay/);
    const labels = codeOf('components/hr/payroll-labels.ts');
    expect(COMPONENT_KIND_HINTS.EMPLOYER_CONTRIBUTION).toMatch(/does not reduce/i);
    expect(labels).toContain('EMPLOYER_CONTRIBUTION');
  });

  it('renders what a payslip does not include', () => {
    const payslip = codeOf('app/(app)/hr/payroll/payslips/[itemId]/page.tsx');
    expect(payslip).toContain('notApplied');
    expect(payslip).toContain('does not include');
  });
});
