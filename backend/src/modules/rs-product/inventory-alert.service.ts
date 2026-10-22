/**
 * Inventory Alerts — the lifecycle.
 *
 * `evaluateVariant` is the single entry point every CRM stock writer calls.
 * There are two such writers, and both reach this function:
 *
 *   1. `rs-product.service.updateRsProduct` — the manual PATCH edit;
 *   2. `procurement.service.reconcileLineStock` — bill approval, receipt,
 *      allocation, release and line re-mapping.
 *
 * One function means the rule is stated once. A second implementation for the
 * procurement path would be a second place for "at or below" to be written as
 * "below".
 *
 * ### Transactions
 *
 * Evaluation runs INSIDE the caller's transaction, on the caller's `tx`. That
 * is deliberate and is what makes a rolled-back stock change leave no alert: if
 * the surrounding transaction aborts, so does the alert row. The alternative —
 * evaluating after commit — would need its own retry story and could raise an
 * alert for a stock level that never existed.
 *
 * Notification delivery is the exception. It happens after commit, because a
 * WebSocket push cannot be rolled back and a notice about an alert that did not
 * survive would be worse than a late one.
 */

import type { Prisma } from '@prisma/client';
import type {
  InventoryAlertSummary,
  InventoryAlertView,
  ListInventoryAlertsQuery,
  ListMonitoredVariantsQuery,
  MonitorCandidateView,
  MonitoredVariantView,
  SearchMonitorCandidatesQuery,
} from '@rs/shared';
import {
  decideAfterThresholdChange,
  decideAlert,
  stockShortfall,
  type InventoryAlertResolutionValue,
} from '@rs/shared';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import * as repo from './inventory-alert.repository.js';
import * as notify from './inventory-alert.notify.js';
import * as notifications from '../notification/notification.service.js';

/** Matching the budget used across this codebase's write transactions. */
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** What a caller needs to know happened, so it can notify after commit. */
export type EvaluationOutcome =
  | { action: 'RAISED'; alertId: string; monitoredVariantId: string; variantId: string }
  | { action: 'RESOLVED'; alertId: string; resolution: InventoryAlertResolutionValue }
  | { action: 'NONE' };

const NOTHING: EvaluationOutcome = { action: 'NONE' };

/**
 * Evaluates one variant against its configuration, if it has one.
 *
 * Returns NONE for the overwhelmingly common case — a variant nobody is
 * watching — after a single indexed lookup. Procurement moves stock constantly
 * and most of those variants are not monitored, so this path has to be cheap.
 *
 * `thresholdChanged` only alters the resolution reason recorded in history:
 * stock recovering and a threshold being lowered are different stories, and a
 * history that called both STOCK_RECOVERED would misreport one of them.
 */
export async function evaluateVariant(
  tx: Prisma.TransactionClient,
  variantId: string,
  options: { thresholdChanged?: boolean; now?: Date } = {},
): Promise<EvaluationOutcome> {
  const monitor = await repo.lockMonitorForVariant(tx, variantId);
  if (!monitor) return NOTHING;
  return applyDecision(tx, monitor, options);
}

/** The same, addressed by configuration — for threshold and enable/disable edits. */
export async function evaluateMonitor(
  tx: Prisma.TransactionClient,
  monitoredVariantId: string,
  options: { thresholdChanged?: boolean; now?: Date } = {},
): Promise<EvaluationOutcome> {
  const monitor = await repo.lockMonitorById(tx, monitoredVariantId);
  if (!monitor) return NOTHING;
  return applyDecision(tx, monitor, options);
}

async function applyDecision(
  tx: Prisma.TransactionClient,
  monitor: repo.MonitorState,
  options: { thresholdChanged?: boolean; now?: Date },
): Promise<EvaluationOutcome> {
  const now = options.now ?? new Date();

  /*
    The variant has gone — a Shopify sync removed it. The configuration is
    archived and any live alert closed with the reason that actually applies,
    so history says "the variant was removed" rather than implying somebody
    switched monitoring off.

    Genuinely reachable: `MonitoredVariant.variantId` is nullable with
    `SetNull`, so a Shopify sync deleting a variant detaches this row rather
    than removing it. That is what keeps the alert history alive — it hangs off
    a configuration that still exists, and each alert's snapshots remain the
    readable description of what happened.

    Idempotent. `archivedAt` is only stamped when it is still null, and
    `resolveAlert` is conditional on `status: 'ACTIVE'`, so running this twice
    reports NONE the second time rather than re-archiving or re-resolving.
  */
  if (!monitor.variant) {
    if (monitor.archivedAt === null) {
      await repo.updateMonitor(tx, monitor.id, { isActive: false, archivedAt: now });
    }
    if (monitor.activeAlertId) {
      const closed = await repo.resolveAlert(tx, monitor.activeAlertId, 'VARIANT_REMOVED', null, now);
      if (closed > 0) {
        return {
          action: 'RESOLVED',
          alertId: monitor.activeAlertId,
          resolution: 'VARIANT_REMOVED',
        };
      }
    }
    return NOTHING;
  }

  const input = {
    // CRM stock only. Shopify's inventoryQty is never read here.
    crmStockQty: monitor.variant.crmStockQty,
    threshold: monitor.threshold,
    isMonitoringActive: monitor.isActive && monitor.archivedAt === null,
    hasActiveAlert: monitor.activeAlertId !== null,
  };

  const decision = options.thresholdChanged
    ? decideAfterThresholdChange(input)
    : decideAlert(input);

  if (decision.action === 'NONE') return NOTHING;

  if (decision.action === 'RESOLVE') {
    if (!monitor.activeAlertId) return NOTHING;
    const closed = await repo.resolveAlert(
      tx,
      monitor.activeAlertId,
      decision.resolution,
      monitor.variant.crmStockQty,
      now,
    );
    // 0 means another transaction resolved it first — its reason stands.
    if (closed === 0) return NOTHING;
    return { action: 'RESOLVED', alertId: monitor.activeAlertId, resolution: decision.resolution };
  }

  // RAISE. The configuration row is locked, so a concurrent evaluation is
  // waiting rather than racing; the partial unique index is the backstop.
  try {
    const alert = await repo.raiseAlert(tx, {
      monitoredVariantId: monitor.id,
      variantId: monitor.variant.id,
      thresholdAtRaise: monitor.threshold,
      stockAtRaise: monitor.variant.crmStockQty,
      productTitleAtRaise: monitor.variant.rsProduct.title,
      skuAtRaise: monitor.variant.sku,
      rsProductIdAtRaise: monitor.variant.rsProductId,
    });
    return {
      action: 'RAISED',
      alertId: alert.id,
      monitoredVariantId: monitor.id,
      variantId: monitor.variant.id,
    };
  } catch (error) {
    /*
      P2002 on the partial unique index: somebody raised the alert between our
      read and our insert. That is success, not failure — exactly one active
      alert exists, which is the invariant. The same treatment Notification
      already gives its own dedupe conflict.
    */
    if (isUniqueViolation(error)) {
      logger.debug(
        { monitoredVariantId: monitor.id },
        'Inventory alert already raised by a concurrent evaluation',
      );
      return NOTHING;
    }
    throw error;
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'P2002';

/**
 * Evaluates several variants in one transaction.
 *
 * Used by the procurement path, where one bill approval can reconcile many
 * lines and therefore touch many variants. Sequential rather than concurrent on
 * purpose: each evaluation takes a row lock, and issuing them in parallel on one
 * transaction would serialise anyway while making deadlocks likelier.
 */
export async function evaluateVariants(
  tx: Prisma.TransactionClient,
  variantIds: readonly string[],
  options: { now?: Date } = {},
): Promise<EvaluationOutcome[]> {
  const outcomes: EvaluationOutcome[] = [];
  // De-duplicated: two lines on one bill may map to the same variant, and
  // evaluating it twice would be wasted work with the same answer.
  for (const id of new Set(variantIds)) {
    outcomes.push(await evaluateVariant(tx, id, options));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
//  The API surface: configuring what is watched
// ---------------------------------------------------------------------------

/**
 * Starts monitoring a variant, and evaluates it immediately.
 *
 * The immediate evaluation is a requirement, not a nicety: a buyer who sets a
 * threshold of 10 on a variant holding 2 expects an alert at once, not at the
 * next stock movement — which for a slow-moving item could be weeks.
 *
 * Creation and evaluation share one transaction, so a variant that is already
 * low is monitored and alerting together, or neither.
 */
export async function createMonitoredVariant(
  input: { variantId: string; threshold: number },
  actorId: string,
): Promise<{ id: string; outcome: EvaluationOutcome }> {
  const variant = await prisma.shopifyVariant.findUnique({
    where: { id: input.variantId },
    select: { id: true },
  });
  if (!variant) {
    throw AppError.notFound('VARIANT_NOT_FOUND', 'That product variant could not be found.');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await repo.createMonitor(tx, { ...input, createdById: actorId });
      const outcome = await evaluateMonitor(tx, created.id);
      return { id: created.id, outcome };
    }, TX_OPTIONS);
  } catch (error) {
    // `variantId` is unique: a second configuration for one variant is a
    // conflict to report, not a duplicate to create.
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'ALREADY_MONITORED',
        'That variant is already being monitored. Edit its threshold instead.',
      );
    }
    throw error;
  }
}

/**
 * Changes a threshold, a monitoring state, or both — then re-evaluates.
 *
 * Re-evaluation is inside the same transaction as the edit, so the alert state
 * and the configuration can never disagree. Which reason gets recorded depends
 * on what changed:
 *
 *   - threshold lowered past current stock  → THRESHOLD_CHANGED
 *   - monitoring switched off               → MONITORING_DISABLED
 *
 * Both are distinguishable in history from stock actually recovering, which is
 * why the enum has four values rather than one.
 */
export async function updateMonitoredVariant(
  id: string,
  input: { threshold?: number; isActive?: boolean },
  actorId: string,
): Promise<EvaluationOutcome> {
  return prisma.$transaction(async (tx) => {
    const existing = await repo.lockMonitorById(tx, id);
    if (!existing) {
      throw AppError.notFound('MONITOR_NOT_FOUND', 'That monitoring configuration was not found.');
    }
    if (existing.archivedAt !== null) {
      throw AppError.badRequest(
        'MONITOR_ARCHIVED',
        'That variant no longer exists, so its monitoring cannot be changed.',
      );
    }

    /*
      The relation form, not the scalar: Prisma's update input exposes
      `updatedBy` for a related record rather than `updatedById`. Connecting is
      the same write — it sets the foreign key — and it is the shape the
      generated client accepts.
    */
    const data: Prisma.MonitoredVariantUpdateInput = {
      updatedBy: { connect: { id: actorId } },
    };
    if (input.threshold !== undefined) data.threshold = input.threshold;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    await repo.updateMonitor(tx, id, data);

    const thresholdChanged =
      input.threshold !== undefined && input.threshold !== existing.threshold;

    return evaluateMonitor(tx, id, { thresholdChanged });
  }, TX_OPTIONS);
}

/** The monitored list, shaped for the page. */
export async function listMonitoredVariants(query: ListMonitoredVariantsQuery): Promise<{
  monitored: MonitoredVariantView[];
  nextCursor: string | null;
}> {
  const { rows, nextCursor } = await repo.listMonitored(query);
  return { monitored: rows.map(toMonitoredView), nextCursor };
}

export async function getMonitoredVariant(id: string): Promise<MonitoredVariantView> {
  const row = await repo.findMonitored(id);
  if (!row) {
    throw AppError.notFound('MONITOR_NOT_FOUND', 'That monitoring configuration was not found.');
  }
  return toMonitoredView(row);
}

export async function listAlerts(query: ListInventoryAlertsQuery): Promise<{
  alerts: InventoryAlertView[];
  nextCursor: string | null;
}> {
  const { rows, nextCursor } = await repo.listAlerts(query);
  return { alerts: rows.map(toAlertView), nextCursor };
}

/** The dashboard card and the page header. */
export async function getSummary(): Promise<InventoryAlertSummary> {
  const s = await repo.summarise();
  return {
    activeAlerts: s.activeAlerts,
    monitoredVariants: s.monitoredVariants,
    archivedConfigurations: s.archivedConfigurations,
    // Summed from the shared helper, so the page and the card agree.
    totalShortfall: s.shortfallRows.reduce(
      (sum, r) => sum + stockShortfall(r.crmStockQty, r.threshold),
      0,
    ),
    negativeStockVariants: s.negativeStockVariants,
  };
}

/** The add-monitor picker. */
export async function searchCandidates(query: SearchMonitorCandidatesQuery): Promise<{
  candidates: MonitorCandidateView[];
  nextCursor: string | null;
}> {
  const { rows, nextCursor } = await repo.searchCandidates(query);
  return {
    candidates: rows.map((r) => ({
      variantId: r.id,
      sku: r.sku,
      variantTitle: r.title,
      productTitle: r.rsProduct.title,
      rsProductId: r.rsProductId,
      crmStockQty: r.crmStockQty,
      inventoryQty: r.inventoryQty,
      isMonitored: r.monitoring !== null,
    })),
    nextCursor,
  };
}

const toAlertView = (a: {
  id: string;
  monitoredVariantId: string;
  variantId: string | null;
  status: 'ACTIVE' | 'RESOLVED';
  resolution: InventoryAlertResolutionValue | null;
  thresholdAtRaise: number;
  stockAtRaise: number;
  productTitleAtRaise: string;
  skuAtRaise: string | null;
  rsProductIdAtRaise: string;
  raisedAt: Date;
  resolvedAt: Date | null;
  stockAtResolve: number | null;
}): InventoryAlertView => ({
  id: a.id,
  monitoredVariantId: a.monitoredVariantId,
  variantId: a.variantId,
  status: a.status,
  resolution: a.resolution,
  thresholdAtRaise: a.thresholdAtRaise,
  stockAtRaise: a.stockAtRaise,
  productTitleAtRaise: a.productTitleAtRaise,
  skuAtRaise: a.skuAtRaise,
  rsProductIdAtRaise: a.rsProductIdAtRaise,
  raisedAt: a.raisedAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
  stockAtResolve: a.stockAtResolve,
});

function toMonitoredView(row: repo.MonitorViewRow): MonitoredVariantView {
  const live = row.variant;
  return {
    id: row.id,
    variantId: row.variantId,
    threshold: row.threshold,
    isActive: row.isActive,
    archivedAt: row.archivedAt?.toISOString() ?? null,

    sku: live?.sku ?? null,
    variantTitle: live?.title ?? null,
    productTitle: live?.rsProduct.title ?? '(variant removed)',
    rsProductId: live?.rsProductId ?? '',
    crmStockQty: live?.crmStockQty ?? 0,
    inventoryQty: live?.inventoryQty ?? 0,

    activeAlert: row.alerts[0] ? toAlertView(row.alerts[0]) : null,
    alertCount: row._count.alerts,

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Raises the notices for an alert that has just been created.
 *
 * Called only after the raising transaction has committed. Two steps, in this
 * order and for this reason:
 *
 *   1. `persist` writes a row per recipient. Durable, so a dropped socket does
 *      not lose the notice — it appears on their next fetch.
 *   2. `deliver` pushes to whoever is connected, swallowing its own failures.
 *
 * The notification's `entityId` is the ALERT id, not the variant's. That is
 * what lets a variant alert again after recovering: `Notification` is unique on
 * `(recipientId, type, entityId)`, so a variant-keyed notice would collide with
 * the previous episode forever.
 */
export async function notifyRaised(alertId: string): Promise<void> {
  const alert = await prisma.inventoryAlert.findUnique({
    where: { id: alertId },
    select: {
      id: true,
      productTitleAtRaise: true,
      skuAtRaise: true,
      stockAtRaise: true,
      thresholdAtRaise: true,
    },
  });
  if (!alert) return;

  const recipients = await notify.alertRecipients();
  if (recipients.length === 0) return;

  const draft = notify.lowStockDraft({
    alertId: alert.id,
    productTitle: alert.productTitleAtRaise,
    sku: alert.skuAtRaise,
    crmStockQty: alert.stockAtRaise,
    threshold: alert.thresholdAtRaise,
  });

  try {
    await prisma.$transaction(async (tx) => {
      await notifications.persist(tx, recipients, draft);
    }, TX_OPTIONS);
  } catch (error) {
    /*
      A notice that cannot be stored must not undo an alert that is already
      committed and correct. The alert remains visible on the Inventory Alerts
      page, which is the record; the bell is the convenience.
    */
    logger.error({ err: error, alertId }, 'Failed to persist inventory alert notification');
    return;
  }

  await notify.deliver(recipients, 'INVENTORY_LOW_STOCK', alert.id);
}


/**
 * Archives configurations whose variant has been deleted, closing live alerts.
 *
 * A Shopify sync detaches these rows (`variantId` → null) but cannot archive
 * them: the sync has no knowledge of Inventory Alerts, and giving it some would
 * couple two modules that are better left apart. So reconciliation is a
 * separate, idempotent pass over whatever the sync left behind.
 *
 * Each configuration is handled in its own transaction. One that fails leaves
 * the rest reconcilable on the next pass, which is the same containment
 * `syncOneProduct` already uses for a per-product failure.
 *
 * Safe to call repeatedly: `findDetachedMonitors` excludes rows already
 * archived, and `evaluateMonitor`'s VARIANT_REMOVED branch is itself
 * idempotent.
 */
export async function reconcileDetachedMonitors(): Promise<{
  archived: number;
  resolved: number;
}> {
  const detached = await repo.findDetachedMonitors();
  let archived = 0;
  let resolved = 0;

  for (const { id } of detached) {
    try {
      const outcome = await prisma.$transaction(
        (tx) => evaluateMonitor(tx, id),
        TX_OPTIONS,
      );
      archived += 1;
      if (outcome.action === 'RESOLVED') resolved += 1;
    } catch (error) {
      // Logged and skipped: a configuration that cannot be archived now is
      // still detached, so the next pass will find it again.
      logger.error({ err: error, monitoredVariantId: id }, 'Could not archive a detached monitor');
    }
  }

  if (detached.length > 0) {
    logger.info({ detached: detached.length, archived, resolved }, 'Reconciled detached monitors');
  }
  return { archived, resolved };
}


/**
 * Archives named configurations whose variant a sync has just deleted.
 *
 * The narrow counterpart to `reconcileDetachedMonitors`. The sync knows exactly
 * which configurations it detached — it read them before deleting their
 * variants — so this takes those ids rather than scanning every configuration
 * in the catalogue on every product of every sync.
 *
 * MUST be called after the deleting transaction has COMMITTED. Called inside
 * it, the configuration would still appear attached: `SET NULL` has not been
 * applied from this transaction's point of view, so `evaluateMonitor` would see
 * a live variant and decide nothing. The caller therefore awaits
 * `upsertShopifyProduct` first and passes the ids it returned.
 *
 * Idempotent and safe to repeat. `evaluateMonitor`'s detached branch stamps
 * `archivedAt` only when it is still null, and `resolveAlert` is conditional on
 * `status: 'ACTIVE'` — a retried sync that reports the same ids resolves
 * nothing a second time. An id whose configuration has since been archived by
 * the sweep answers NONE.
 *
 * Each configuration gets its own transaction, so one failure leaves the others
 * reconcilable — the same containment `syncOneProduct` already applies
 * per-product. Nothing here can fail a sync: every error is logged and
 * swallowed, because the variant deletion is already committed and correct, and
 * an unarchived configuration is a tidiness problem that the next sync or the
 * sweep will clear.
 */
export async function reconcileMonitors(
  monitoredVariantIds: readonly string[],
): Promise<{ archived: number; resolved: number }> {
  let archived = 0;
  let resolved = 0;

  // De-duplicated: one product's payload cannot name a configuration twice,
  // but a caller batching several products could.
  for (const id of new Set(monitoredVariantIds)) {
    try {
      const outcome = await prisma.$transaction((tx) => evaluateMonitor(tx, id), TX_OPTIONS);
      archived += 1;
      if (outcome.action === 'RESOLVED') resolved += 1;
    } catch (error) {
      logger.error(
        { err: error, monitoredVariantId: id },
        'Could not archive a monitor detached by sync',
      );
    }
  }

  return { archived, resolved };
}
