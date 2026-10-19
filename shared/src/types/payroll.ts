/**
 * HR Phase 6 — Payroll & Compensation, as the API presents it.
 *
 * ### Nothing here is computed by the browser
 *
 * Every gross, every deduction, every net, every proration and every "may this
 * be approved" flag arrives already decided by the service. The frontend renders
 * these shapes and performs no arithmetic on them whatsoever.
 *
 * That rule is stricter in this module than anywhere else in the system, for two
 * reasons. A figure the browser computed would eventually disagree with the
 * figure the employee was paid, and the disagreement would surface as an
 * accusation. And a client that can compute pay is a client that has been sent
 * the inputs to compute it — the salary structure, the component rates — which
 * is precisely the data that must not leave the server for a reader who is only
 * entitled to a total.
 *
 * Monetary values travel as **decimal strings**, never numbers. `0.1 + 0.2 !==
 * 0.3`; a net pay that drifts in the last place is a figure somebody will
 * dispute, and JSON numbers are IEEE 754 doubles. The database holds
 * `Decimal(12, 2)`, the wire carries the exact digits, the UI formats them.
 *
 * ### The confidentiality rule these shapes encode
 *
 * **An employee may read their own pay and nobody else's.** That is not a UI
 * concern and it is not expressed by hiding a column: the service returns
 * *different shapes* to different readers.
 *
 *   - `PayslipView` is what an employee receives for their own payslip. It
 *     carries their own figures and no one else's.
 *   - `PayrollItemView` is what an authorised HR reader receives per employee
 *     within a run.
 *   - `PayrollPeriodSummaryView` carries only aggregates, so a reader entitled
 *     to a total is not handed the individual salaries that compose it.
 *
 * No shape in this file carries a bank account number, an IFSC code or any other
 * payment credential. The module does not collect them — see `PAYROLL-SCOPE.md`.
 *
 * ### FINALIZED is not PAID
 *
 * `PayrollPeriodView.status` reaching `FINALIZED` means the figures are locked
 * and payslips may be issued. It does not mean money moved. No bank integration
 * is configured in this system, so no shape here claims payment has occurred.
 */

import type {
  DailyRateBasis,
  MonetaryRoundingMode,
  PayrollAdjustmentKind,
  PayrollExclusionReason,
  PayrollItemStatus,
  PayrollPeriodStatus,
  SalaryCalculationKind,
  SalaryComponentKind,
} from '../enums.js';

/** An employee as payroll refers to them. Never carries salary. */
export type PayrollEmployeeRef = {
  id: string;
  employeeId: string;
  displayName: string;
  departmentName: string | null;
  designationName: string | null;
};

/** A person who acted, for audit display. */
export type PayrollUserRef = {
  id: string;
  name: string;
};

// ---------------------------------------------------------------------------
//  Compensation configuration
// ---------------------------------------------------------------------------

/**
 * One configurable line that can appear on a payslip.
 *
 * `calculation` and `rate` together are where every statutory figure in this
 * system lives. A provident fund deduction is a `DEDUCTION` with
 * `PERCENT_OF_BASE` and whatever rate the business has configured — the code
 * holds no opinion on what that rate should be.
 */
export type SalaryComponentView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: SalaryComponentKind;
  calculation: SalaryCalculationKind;
  /** Null for FIXED and FORMULA_BALANCE; a decimal percentage otherwise. */
  rate: string | null;
  /** An upper bound on the computed amount, where the policy caps it. */
  capAmount: string | null;
  /** Below this gross, the component does not apply at all. */
  floorAmount: string | null;
  /** Whether this is the single base component percentages are taken of. */
  isBase: boolean;
  /** Whether unpaid-leave proration reduces this component. */
  prorates: boolean;
  /** Whether the component is taxable, for reporting only — no tax is computed. */
  isTaxable: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** A named set of components, assignable to employees. */
export type SalaryStructureView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  currency: string;
  isActive: boolean;
  components: SalaryStructureComponentView[];
  /** Sum of the FIXED earnings, for display. Null when the structure is rate-only. */
  indicativeGross: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One component's place and value within a structure. */
export type SalaryStructureComponentView = {
  id: string;
  component: SalaryComponentView;
  /** The monthly amount, for FIXED components. */
  amount: string | null;
  /** Overrides the component's own rate for this structure, where set. */
  rateOverride: string | null;
  displayOrder: number;
};

/**
 * One employee's salary, effective from a date.
 *
 * Assignments are **append-only**. Changing somebody's pay creates a new row
 * with a later `effectiveFrom`; it never updates an existing one. That is what
 * makes a payslip from eight months ago still explicable: the assignment that
 * produced it is still there, unmodified, and `effectiveTo` records when it
 * stopped applying rather than the row being overwritten.
 */
export type EmployeeSalaryView = {
  id: string;
  employee: PayrollEmployeeRef;
  structure: SalaryStructureView | null;
  /** The agreed monthly gross this assignment is built around. */
  monthlyGross: string;
  currency: string;
  effectiveFrom: string;
  /** Null while current; set when a later assignment supersedes it. */
  effectiveTo: string | null;
  /** Per-employee amounts that differ from the structure's defaults. */
  overrides: EmployeeSalaryComponentView[];
  notes: string | null;
  createdBy: PayrollUserRef | null;
  createdAt: string;
  /** Whether this is the assignment in force today. */
  isCurrent: boolean;
};

export type EmployeeSalaryComponentView = {
  id: string;
  component: SalaryComponentView;
  amount: string | null;
  rateOverride: string | null;
};

// ---------------------------------------------------------------------------
//  Payroll processing
// ---------------------------------------------------------------------------

/**
 * A monthly payroll run.
 *
 * `dailyRateBasis`, `roundingMode`, `calendarDays`, `workingDays` and
 * `payableDaysDivisor` are all stored on the row rather than derived when read.
 * A finalised period must keep the arithmetic it was computed under: if the
 * business switches from a 30-day divisor to working days in April, March's
 * payslips must still reconcile to the figures the employees were paid, and a
 * period that recomputed its own divisor at read time would silently restate
 * history.
 */
export type PayrollPeriodView = {
  id: string;
  code: string;
  name: string;
  /** First and last day the run covers, inclusive. */
  periodStart: string;
  periodEnd: string;
  /** The month this run is *for*, as year and 1-indexed month. */
  year: number;
  month: number;
  status: PayrollPeriodStatus;
  currency: string;

  /** The policy this run was computed under, frozen onto the row. */
  dailyRateBasis: DailyRateBasis;
  roundingMode: MonetaryRoundingMode;
  calendarDays: number;
  workingDays: number;
  /** The divisor actually used, resolved from the basis at calculation time. */
  payableDaysDivisor: number;

  /** Server-computed totals. Null until the run has been calculated. */
  totals: PayrollPeriodTotals | null;

  employeeCount: number;
  calculatedAt: string | null;
  calculatedBy: PayrollUserRef | null;
  approvalRequestId: string | null;
  approvedAt: string | null;
  approvedBy: PayrollUserRef | null;
  finalizedAt: string | null;
  finalizedBy: PayrollUserRef | null;
  notes: string | null;
  createdBy: PayrollUserRef | null;
  createdAt: string;
  updatedAt: string;

  /**
   * What this reader may do, decided by the server.
   *
   * `finalize` is false for a reader who is themselves paid by this run, whatever
   * grants they hold — see `mayFinalizePeriod`. The UI must not re-derive these.
   */
  viewerCan: {
    edit: boolean;
    calculate: boolean;
    submitForApproval: boolean;
    approve: boolean;
    finalize: boolean;
    cancel: boolean;
    export: boolean;
  };
  /** Whether this reader's own salary is inside this run. Drives the SoD notice. */
  viewerIsPaidByThisRun: boolean;
};

export type PayrollPeriodTotals = {
  grossEarnings: string;
  totalDeductions: string;
  employerContributions: string;
  netPay: string;
  /** Lines held out of the run, which a total alone would hide. */
  excludedCount: number;
  /** Lines whose net came out below zero, which must block finalisation. */
  negativeNetCount: number;
};

/**
 * One employee's line within a run, for an authorised HR reader.
 *
 * `snapshot` is populated once the period is finalised and is thereafter
 * immutable. It is the full computation — every component, every input, the
 * divisor and the rounding mode — so that the figure can be re-explained years
 * later without depending on configuration that has since changed.
 */
export type PayrollItemView = {
  id: string;
  periodId: string;
  employee: PayrollEmployeeRef;
  status: PayrollItemStatus;
  exclusionReason: PayrollExclusionReason | null;
  exclusionNote: string | null;

  currency: string;
  /** The assignment this line was computed from. */
  salaryAssignmentId: string | null;
  monthlyGross: string | null;

  /** Attendance-derived inputs, all server-computed. */
  payableDays: string | null;
  unpaidLeaveDays: string | null;
  presentDays: string | null;
  paidLeaveDays: string | null;
  overtimeMinutes: number | null;

  grossEarnings: string | null;
  totalDeductions: string | null;
  employerContributions: string | null;
  netPay: string | null;

  lines: PayrollLineView[];
  adjustments: PayrollAdjustmentView[];
  snapshot: PayrollItemSnapshot | null;
  payslipDocumentId: string | null;
  calculatedAt: string | null;
};

/** One component as it landed on one employee's line. */
export type PayrollLineView = {
  id: string;
  componentCode: string;
  componentName: string;
  kind: SalaryComponentKind;
  calculation: SalaryCalculationKind;
  /** The rate applied, where the component is rate-based. */
  rate: string | null;
  /** The figure before proration, for explicability. */
  fullAmount: string;
  /** What was actually counted after proration and caps. */
  amount: string;
  /** Why the amount differs from fullAmount, in words, where it does. */
  prorationNote: string | null;
  displayOrder: number;
};

/**
 * The immutable record of how one finalised figure was reached.
 *
 * Stored as a structured snapshot rather than recomputed, because every input
 * can legitimately change afterwards: the component rate, the structure, the
 * employee's assignment, the attendance policy. A payslip that recomputed itself
 * would quietly restate what somebody was paid.
 */
export type PayrollItemSnapshot = {
  /** Version of the snapshot shape, so a later change can be read safely. */
  schemaVersion: number;
  computedAt: string;
  dailyRateBasis: DailyRateBasis;
  roundingMode: MonetaryRoundingMode;
  payableDaysDivisor: number;
  calendarDays: number;
  workingDays: number;
  monthlyGross: string;
  currency: string;
  attendance: {
    presentDays: string;
    paidLeaveDays: string;
    unpaidLeaveDays: string;
    holidayDays: string;
    weekOffDays: string;
    payableDays: string;
    overtimeMinutes: number;
    /** Whether overtime was valued, and under what configured multiplier. */
    overtimeMultiplier: string | null;
  };
  lines: Array<{
    componentCode: string;
    componentName: string;
    kind: SalaryComponentKind;
    calculation: SalaryCalculationKind;
    rate: string | null;
    fullAmount: string;
    amount: string;
  }>;
  adjustments: Array<{
    kind: PayrollAdjustmentKind;
    amount: string;
    reference: string | null;
  }>;
  totals: {
    grossEarnings: string;
    totalDeductions: string;
    employerContributions: string;
    netPay: string;
  };
  /**
   * Policies that were NOT applied because nothing was configured.
   *
   * Present so a payslip can state plainly what it does not include rather than
   * implying completeness. An empty list is a meaningful claim; a missing list
   * is not.
   */
  notApplied: string[];
};

/** A correction attaching to a later period. */
export type PayrollAdjustmentView = {
  id: string;
  employee: PayrollEmployeeRef;
  /** The period this adjustment is paid in. */
  periodId: string | null;
  kind: PayrollAdjustmentKind;
  amount: string;
  currency: string;
  reason: string;
  /** The finalised period being corrected, where it corrects one. */
  correctsPeriodId: string | null;
  reference: string | null;
  createdBy: PayrollUserRef | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
//  Payslips and reporting
// ---------------------------------------------------------------------------

/**
 * One payslip, for the employee it belongs to or an authorised HR reader.
 *
 * Built from the finalised snapshot, never recomputed. There is no payslip for a
 * period that is not finalised, which is deliberate: a document an employee can
 * save and forward must not be issuable from figures that are still moving.
 */
export type PayslipView = {
  itemId: string;
  period: {
    id: string;
    code: string;
    name: string;
    year: number;
    month: number;
    periodStart: string;
    periodEnd: string;
  };
  employee: PayrollEmployeeRef;
  currency: string;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  employerContributions: PayslipLine[];
  grossEarnings: string;
  totalDeductions: string;
  netPay: string;
  attendance: {
    payableDays: string;
    unpaidLeaveDays: string;
    overtimeMinutes: number;
  };
  /** What this payslip does not include, from the snapshot. */
  notApplied: string[];
  /** A short-lived signed URL, where a document has been generated. */
  documentUrl: string | null;
  finalizedAt: string | null;
};

export type PayslipLine = {
  label: string;
  amount: string;
};

/** Aggregates only — never the individual salaries behind them. */
export type PayrollPeriodSummaryView = {
  period: {
    id: string;
    code: string;
    name: string;
    year: number;
    month: number;
    status: PayrollPeriodStatus;
    currency: string;
  };
  totals: PayrollPeriodTotals;
  byDepartment: Array<{
    departmentId: string | null;
    departmentName: string;
    employeeCount: number;
    grossEarnings: string;
    totalDeductions: string;
    netPay: string;
  }>;
  byComponent: Array<{
    componentCode: string;
    componentName: string;
    kind: SalaryComponentKind;
    total: string;
  }>;
};

/** An employee's own pay history, for self-service. */
export type MyPayrollView = {
  employee: PayrollEmployeeRef | null;
  currentSalary: {
    monthlyGross: string;
    currency: string;
    effectiveFrom: string;
    structureName: string | null;
  } | null;
  payslips: Array<{
    itemId: string;
    periodId: string;
    periodCode: string;
    periodName: string;
    year: number;
    month: number;
    netPay: string;
    currency: string;
    finalizedAt: string | null;
  }>;
};

/** The payroll dashboard, scoped to what the reader may see. */
export type PayrollOverviewView = {
  canReadAll: boolean;
  openPeriods: Array<{
    id: string;
    code: string;
    name: string;
    status: PayrollPeriodStatus;
    year: number;
    month: number;
    employeeCount: number;
  }>;
  awaitingApprovalCount: number;
  activeComponentCount: number;
  activeStructureCount: number;
  employeesWithoutSalaryCount: number | null;
  lastFinalizedPeriod: {
    id: string;
    code: string;
    name: string;
    netPay: string;
    currency: string;
    finalizedAt: string | null;
  } | null;
  /** The reader's own latest payslip, where they have one. */
  myLatestPayslip: {
    itemId: string;
    periodCode: string;
    periodName: string;
    netPay: string;
    currency: string;
  } | null;
};

/** The result of a calculation attempt, including what it refused to do. */
export type PayrollCalculationResultView = {
  period: PayrollPeriodView;
  calculated: number;
  excluded: number;
  /** Per-employee problems that did not stop the run. */
  warnings: Array<{
    employeeId: string;
    employeeName: string;
    message: string;
  }>;
  /** Conditions that must be resolved before the period can be finalised. */
  blockers: Array<{
    employeeId: string | null;
    message: string;
  }>;
};

export type SalaryComponentListView = { components: SalaryComponentView[] };
export type SalaryStructureListView = {
  structures: SalaryStructureView[];
  nextCursor: string | null;
};
export type EmployeeSalaryListView = { assignments: EmployeeSalaryView[] };
export type PayrollPeriodListView = {
  periods: PayrollPeriodView[];
  nextCursor: string | null;
};
export type PayrollItemListView = {
  items: PayrollItemView[];
  nextCursor: string | null;
};
