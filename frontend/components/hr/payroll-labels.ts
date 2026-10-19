import type {
  DailyRateBasis,
  MonetaryRoundingMode,
  PayrollAdjustmentKind,
  PayrollExclusionReason,
  PayrollItemStatus,
  PayrollPeriodStatus,
  SalaryCalculationKind,
  SalaryComponentKind,
} from '@rs/shared';

/**
 * How HR Phase 6 payroll values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend suite can
 * assert them directly — the project's convention for presentation logic, and
 * the reason none of this is inlined into the components.
 *
 * **Nothing here computes a figure.** Not a gross, not a deduction, not a net,
 * not a proration. Every amount arrives from the server as an exact decimal
 * string and these functions decide only how it is written down. `formatMoney`
 * in particular does **not** do arithmetic: it groups digits and prefixes a
 * currency, nothing more.
 *
 * ### FINALIZED is not PAID
 *
 * `PERIOD_STATUS_LABELS.FINALIZED` says "Finalised — ready for payment", never
 * "Paid". No bank integration exists in this system, so no label may claim money
 * has moved. That phrasing is load-bearing: an employee reading "Paid" when
 * nothing has been transferred has been told something untrue about their own
 * livelihood.
 */

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline';

// ---------------------------------------------------------------------------
//  Money
// ---------------------------------------------------------------------------

/**
 * Groups an exact decimal string for display, without arithmetic.
 *
 * Takes the digits the server sent and inserts separators. It never parses to a
 * float, because `Number('12345678901234.56')` loses precision and a payslip
 * total that drifts in the last place is a figure somebody will dispute.
 *
 * Indian digit grouping (1,23,456.78) because the system's default currency is
 * INR and that is how the figure is read locally. A different currency falls
 * back to three-digit grouping.
 */
export function formatMoney(amount: string | null, currency = 'INR'): string {
  if (amount === null || amount === '') return '—';

  const negative = amount.trimStart().startsWith('-');
  const bare = negative ? amount.trim().slice(1) : amount.trim();
  const [whole = '0', fraction = '00'] = bare.split('.');

  const grouped =
    currency === 'INR'
      ? groupIndian(whole)
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

/** 1234567 -> 12,34,567. Last three digits, then pairs. */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/** Whether a figure is negative, read from the string rather than parsed. */
export function isNegative(amount: string | null): boolean {
  return amount !== null && amount.trimStart().startsWith('-');
}

/** Days, as the server sent them: "26.00" reads as "26", "26.50" as "26.5". */
export function formatDays(days: string | null): string {
  if (days === null) return '—';
  const trimmed = days.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return trimmed;
}

/** Minutes as hours and minutes, for overtime. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null || minutes === 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

/**
 * What each period status means, in the words the business uses.
 *
 * FINALIZED deliberately says "ready for payment" rather than "paid" — see the
 * note at the top of this file.
 */
export const PERIOD_STATUS_LABELS: Record<PayrollPeriodStatus, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Costed',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  FINALIZED: 'Finalised — ready for payment',
  CANCELLED: 'Cancelled',
};

/** A short form for table cells and badges, where the long label will not fit. */
export const PERIOD_STATUS_SHORT: Record<PayrollPeriodStatus, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Costed',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved',
  FINALIZED: 'Finalised',
  CANCELLED: 'Cancelled',
};

export const PERIOD_STATUS_TONES: Record<PayrollPeriodStatus, Tone> = {
  DRAFT: 'outline',
  CALCULATED: 'accent',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'accent',
  FINALIZED: 'positive',
  CANCELLED: 'neutral',
};

/** What the payroll team does next, by status. */
export const PERIOD_NEXT_STEP: Record<PayrollPeriodStatus, string> = {
  DRAFT: 'Cost the run to see every employee’s figures.',
  CALCULATED: 'Review the figures, then submit them for approval.',
  PENDING_APPROVAL: 'Waiting for somebody with payroll approval rights to decide.',
  APPROVED: 'Approved. Finalising will lock the figures and issue payslips.',
  FINALIZED: 'Locked. A correction is recorded as an adjustment in a later period.',
  CANCELLED: 'This run was abandoned. Open a new one if the month still needs paying.',
};

export const ITEM_STATUS_LABELS: Record<PayrollItemStatus, string> = {
  PENDING: 'Not costed',
  CALCULATED: 'Costed',
  EXCLUDED: 'Excluded',
  FINALIZED: 'Finalised',
};

export const ITEM_STATUS_TONES: Record<PayrollItemStatus, Tone> = {
  PENDING: 'outline',
  CALCULATED: 'accent',
  EXCLUDED: 'neutral',
  FINALIZED: 'positive',
};

/**
 * Why somebody was held out of a run, in words they could be told.
 *
 * "Why was I not paid" is the one question this module must always answer, so
 * none of these is a code or an abbreviation.
 */
export const EXCLUSION_REASON_LABELS: Record<PayrollExclusionReason, string> = {
  NOT_ELIGIBLE: 'Not eligible for this period',
  NO_SALARY_ASSIGNMENT: 'No salary assignment in force',
  JOINED_AFTER_PERIOD: 'Joined after the period ended',
  EXITED_BEFORE_PERIOD: 'Left before the period began',
  MANUALLY_EXCLUDED: 'Held out of this run by HR',
};

// ---------------------------------------------------------------------------
//  Components and policy
// ---------------------------------------------------------------------------

export const COMPONENT_KIND_LABELS: Record<SalaryComponentKind, string> = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
};

export const COMPONENT_KIND_TONES: Record<SalaryComponentKind, Tone> = {
  EARNING: 'positive',
  DEDUCTION: 'warning',
  EMPLOYER_CONTRIBUTION: 'neutral',
};

/**
 * What each component kind does to net pay.
 *
 * Spelled out because the third one is the common misunderstanding: an employer
 * contribution is a company cost that never passes through the employee's hands,
 * so it does not reduce what they are paid.
 */
export const COMPONENT_KIND_HINTS: Record<SalaryComponentKind, string> = {
  EARNING: 'Adds to gross pay.',
  DEDUCTION: 'Subtracts from net pay.',
  EMPLOYER_CONTRIBUTION: 'A company cost. Does not reduce the employee’s net pay.',
};

export const CALCULATION_LABELS: Record<SalaryCalculationKind, string> = {
  FIXED: 'Fixed amount',
  PERCENT_OF_BASE: 'Percentage of base',
  PERCENT_OF_GROSS: 'Percentage of gross',
  FORMULA_BALANCE: 'Balance of the agreed gross',
};

export const CALCULATION_HINTS: Record<SalaryCalculationKind, string> = {
  FIXED: 'A stated monthly amount.',
  PERCENT_OF_BASE: 'A percentage of the one component marked as the base.',
  PERCENT_OF_GROSS: 'A percentage of total gross earnings, worked out last.',
  FORMULA_BALANCE:
    'Whatever is left of the agreed monthly gross once every other earning is assigned.',
};

export const BASIS_LABELS: Record<DailyRateBasis, string> = {
  CALENDAR_DAYS: 'Calendar days',
  WORKING_DAYS: 'Working days',
  FIXED_THIRTY: 'Fixed 30 days',
};

/**
 * What each divisor basis means for a day's pay.
 *
 * All three are in real use and they disagree by up to 10% on the same salary,
 * which is why the choice is recorded on each period rather than derived.
 */
export const BASIS_HINTS: Record<DailyRateBasis, string> = {
  CALENDAR_DAYS: 'A day is the monthly salary divided by the length of the month (28–31).',
  WORKING_DAYS: 'A day is the monthly salary divided by the days work was expected.',
  FIXED_THIRTY: 'A day is always the monthly salary divided by 30, whatever the month.',
};

export const ROUNDING_LABELS: Record<MonetaryRoundingMode, string> = {
  HALF_UP: 'Half up',
  HALF_EVEN: 'Half to even',
  DOWN: 'Round down',
};

export const ADJUSTMENT_KIND_LABELS: Record<PayrollAdjustmentKind, string> = {
  ARREAR: 'Arrear',
  RECOVERY: 'Recovery',
  BONUS: 'Bonus',
  REIMBURSEMENT: 'Reimbursement',
};

export const ADJUSTMENT_KIND_TONES: Record<PayrollAdjustmentKind, Tone> = {
  ARREAR: 'accent',
  RECOVERY: 'warning',
  BONUS: 'positive',
  REIMBURSEMENT: 'neutral',
};

/** Which direction an adjustment moves pay, since the amount is always positive. */
export const ADJUSTMENT_DIRECTION: Record<PayrollAdjustmentKind, 'adds' | 'subtracts'> = {
  ARREAR: 'adds',
  RECOVERY: 'subtracts',
  BONUS: 'adds',
  REIMBURSEMENT: 'adds',
};

// ---------------------------------------------------------------------------
//  Dates
// ---------------------------------------------------------------------------

/** A month and year, from a period's own fields. */
export function formatPeriodMonth(year: number, month: number): string {
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${year}`;
}

/** A date, in the company's reading order. Never a time — payroll is daily. */
export function formatPayrollDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A moment, for audit stamps where the time matters. */
export function formatPayrollMoment(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * The standing caveat shown wherever payroll figures are presented.
 *
 * Not decoration. This module computes what it is configured to compute and
 * makes no compliance claim, and the person reading a payslip or locking a run
 * is entitled to know that before acting on it.
 */
export const NOT_STATUTORY_NOTICE =
  'Statutory calculations in this system are configured, not certified. Verify contributions and tax against current rules before paying.';
