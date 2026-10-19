/**
 * Payroll notifications — four events, and not one of them carries an amount.
 *
 * ### The rule this file exists to enforce
 *
 * **No payroll notification ever contains a monetary figure.** Not a gross, not
 * a net, not a deduction, not a percentage.
 *
 * A notification is the one part of this module that arrives unasked. It lands
 * in a bell a colleague may glance at over a shoulder, it is frequently mirrored
 * to email, and it is retained in a table that more people can read than can
 * read a payslip. "Your payslip for March 2026 is available" tells the employee
 * exactly what they need to know. "Your net pay is 42,318.50" tells the room.
 *
 * `assertNoAmount` below is not decoration: it is called on every title and body
 * this file produces, and it throws rather than sending. A notification that
 * leaked a salary cannot be recalled, so the failure has to happen before the
 * send rather than being noticed afterwards.
 *
 * ### Failures never fail the write
 *
 * Every function swallows its own errors, mirroring `hr.notify.ts`,
 * `recruitment.notify.ts`, `performance.notify.ts` and the audit service. The
 * payroll run is what matters; if a notice cannot be raised, the figures still
 * stand and the employee sees them on their own page.
 *
 * The one exception is `assertNoAmount`, which throws **out of** the try block
 * deliberately — a developer adding an amount to a notification should get a
 * loud failure in testing, not a swallowed one in production.
 */

import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { deliver, persist } from '../notification/notification.service.js';

type Kind =
  | 'HR_PAYROLL_APPROVAL_REQUIRED'
  | 'HR_PAYSLIP_AVAILABLE'
  | 'HR_PAYROLL_FINALIZED'
  | 'HR_PAYROLL_ADJUSTMENT_RECORDED';

/**
 * Refuses any notification text that looks like it carries money.
 *
 * Deliberately broad. It rejects grouped thousands ("42,318.50"), bare decimals
 * ("42318.50") and currency symbols or codes next to digits. A false positive
 * here costs a developer one rephrasing; a false negative puts somebody's salary
 * in a shared notification table.
 *
 * Period names like "March 2026" and counts like "12 employees" pass, because
 * neither matches a decimal amount or a currency marker.
 */
export function assertNoAmount(field: string, text: string): void {
  const patterns: Array<[RegExp, string]> = [
    [/\d[\d,]*\.\d{2}\b/, 'a two-decimal amount'],
    [/[₹$€£]\s*\d/, 'a currency symbol before digits'],
    [/\b(?:INR|USD|EUR|GBP)\s*\d/i, 'a currency code before digits'],
    [/\d[\d.]*\s*(?:INR|USD|EUR|GBP)\b/i, 'a currency code after digits'],
    [/\b\d{1,3}(?:,\d{2,3})+\b/, 'a grouped-thousands figure'],
  ];
  for (const [pattern, what] of patterns) {
    if (pattern.test(text)) {
      throw new Error(
        `Payroll notification ${field} contains ${what}: notifications must never carry monetary figures. Text was: ${text}`,
      );
    }
  }
}

async function raise(
  recipientIds: readonly string[],
  type: Kind,
  entity: { entityType: string; entityId: string; href: string },
  title: string,
  body: string,
): Promise<void> {
  // Outside the try, on purpose: a leaked amount must fail loudly in testing
  // rather than be swallowed like a transport error.
  assertNoAmount('title', title);
  assertNoAmount('body', body);

  const unique = [...new Set(recipientIds)];
  if (unique.length === 0) return;

  try {
    await prisma.$transaction((tx) =>
      persist(tx, unique, {
        type,
        title,
        body,
        href: entity.href,
        entityType: entity.entityType,
        entityId: entity.entityId,
      }),
    );
    await deliver(unique, type, entity.entityId);
  } catch (error) {
    logger.error(
      { err: error, type, entityId: entity.entityId },
      'Failed to raise payroll notification',
    );
  }
}

/**
 * A costed run is waiting for a decision.
 *
 * To the approvers. Nobody is paid until somebody decides, so this is the one
 * payroll notice with a deadline attached to somebody else's livelihood.
 *
 * Carries the employee *count* but no totals: how many people are in the run is
 * what an approver needs to know before opening it, and the figures are on the
 * page behind the link.
 */
export async function notifyPayrollApprovalRequired(
  recipientUserIds: readonly string[],
  periodId: string,
  periodName: string,
  employeeCount: number,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_PAYROLL_APPROVAL_REQUIRED',
    { entityType: 'PayrollPeriod', entityId: periodId, href: `/hr/payroll/periods/${periodId}` },
    'A payroll run needs approval',
    `${periodName} has been costed for ${employeeCount} employees and is waiting for a decision.`,
  );
}

/**
 * A payslip is available.
 *
 * To the employee, naming the period and nothing else. This is the notice the
 * no-amounts rule was written for.
 */
export async function notifyPayslipAvailable(
  recipientUserIds: readonly string[],
  itemId: string,
  periodName: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_PAYSLIP_AVAILABLE',
    { entityType: 'PayrollItem', entityId: itemId, href: `/hr/payroll/my-payslips` },
    'Your payslip is available',
    `Your payslip for ${periodName} has been issued and can be viewed on your payslips page.`,
  );
}

/**
 * A run has been locked.
 *
 * To the HR team that ran it, because the period is no longer theirs to change
 * and a correction now requires an adjustment in a later period. The employees
 * get `HR_PAYSLIP_AVAILABLE` instead — they do not need to know about the run,
 * only about their own payslip.
 */
export async function notifyPayrollFinalized(
  recipientUserIds: readonly string[],
  periodId: string,
  periodName: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_PAYROLL_FINALIZED',
    { entityType: 'PayrollPeriod', entityId: periodId, href: `/hr/payroll/periods/${periodId}` },
    'A payroll run has been finalised',
    `${periodName} is now locked. Corrections require an adjustment in a later period.`,
  );
}

/**
 * An adjustment has been recorded against this person.
 *
 * To the affected employee. They would otherwise discover an arrear or a
 * recovery from the figure alone, which is how a payroll question becomes a
 * grievance. The *kind* is named — an arrear and a recovery mean opposite things
 * — and the amount is not.
 */
export async function notifyAdjustmentRecorded(
  recipientUserIds: readonly string[],
  adjustmentId: string,
  kindLabel: string,
): Promise<void> {
  await raise(
    recipientUserIds,
    'HR_PAYROLL_ADJUSTMENT_RECORDED',
    {
      entityType: 'PayrollAdjustment',
      entityId: adjustmentId,
      href: `/hr/payroll/my-payslips`,
    },
    `A payroll ${kindLabel.toLowerCase()} has been recorded`,
    `A ${kindLabel.toLowerCase()} has been added to your next payroll. The details are on your payslips page.`,
  );
}
