/**
 * Inventory Alerts — database access.
 *
 * Two shapes of query live here: the ones the lifecycle evaluator runs inside a
 * caller's transaction, and the ones the pages read. The first group all take a
 * `Prisma.TransactionClient` so a stock write and its alert decision commit or
 * roll back together — a stock change that rolls back must not leave an alert
 * claiming it happened.
 */

import type { Prisma } from '@prisma/client';
import type { ListInventoryAlertsQuery, ListMonitoredVariantsQuery } from '@rs/shared';
import { prisma } from '../../config/database.js';

/** Everything the evaluator needs about one configuration, in one read. */
export type MonitorState = {
  id: string;
  /** Null once the variant has been deleted — the row survives, detached. */
  variantId: string | null;
  threshold: number;
  isActive: boolean;
  archivedAt: Date | null;
  variant: {
    id: string;
    crmStockQty: number;
    sku: string | null;
    rsProductId: string;
    rsProduct: { title: string };
  } | null;
  activeAlertId: string | null;
};

const MONITOR_STATE_SELECT = {
  id: true,
  variantId: true,
  threshold: true,
  isActive: true,
  archivedAt: true,
  variant: {
    select: {
      id: true,
      crmStockQty: true,
      sku: true,
      rsProductId: true,
      rsProduct: { select: { title: true } },
    },
  },
  /*
    The live alert, if any. `take: 1` with the status filter rather than a
    count: the evaluator needs its id to resolve it, and the partial unique
    index guarantees there is at most one.
  */
  alerts: {
    where: { status: 'ACTIVE' as const },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.MonitoredVariantSelect;

type MonitorRow = Prisma.MonitoredVariantGetPayload<{ select: typeof MONITOR_STATE_SELECT }>;

const toState = (row: MonitorRow): MonitorState => ({
  id: row.id,
  variantId: row.variantId,
  threshold: row.threshold,
  isActive: row.isActive,
  archivedAt: row.archivedAt,
  variant: row.variant,
  activeAlertId: row.alerts[0]?.id ?? null,
});

/**
 * The configuration for one variant, locked for the rest of the transaction.
 *
 * `FOR UPDATE` on the configuration row is what serialises two concurrent stock
 * updates to the same variant. Without it both could read "no active alert" and
 * both try to raise; the partial unique index would reject the loser, but as a
 * P2002 the caller then has to interpret. Taking the lock first means the second
 * transaction reads the first one's result and decides correctly.
 *
 * Returns null when nothing is monitoring this variant — the common case, since
 * only a chosen few of several hundred variants are watched.
 */
export async function lockMonitorForVariant(
  tx: Prisma.TransactionClient,
  variantId: string,
): Promise<MonitorState | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "MonitoredVariant" WHERE "variantId" = ${variantId} FOR UPDATE
  `;
  const id = locked[0]?.id;
  if (!id) return null;

  const row = await tx.monitoredVariant.findUnique({
    where: { id },
    select: MONITOR_STATE_SELECT,
  });
  return row ? toState(row) : null;
}

/** The same, addressed by configuration id — for threshold and enable edits. */
export async function lockMonitorById(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<MonitorState | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "MonitoredVariant" WHERE "id" = ${id} FOR UPDATE
  `;
  if (!locked[0]) return null;

  const row = await tx.monitoredVariant.findUnique({ where: { id }, select: MONITOR_STATE_SELECT });
  return row ? toState(row) : null;
}

/**
 * Raises an alert, snapshotting what was true.
 *
 * The snapshot columns are the whole point: an alert must still be readable
 * after a Shopify sync deletes its variant, and must not change meaning when
 * somebody later edits the threshold.
 */
export function raiseAlert(
  tx: Prisma.TransactionClient,
  input: {
    monitoredVariantId: string;
    variantId: string;
    thresholdAtRaise: number;
    stockAtRaise: number;
    productTitleAtRaise: string;
    skuAtRaise: string | null;
    rsProductIdAtRaise: string;
  },
): Promise<{ id: string }> {
  return tx.inventoryAlert.create({ data: input, select: { id: true } });
}

/**
 * Closes an alert.
 *
 * Conditional on `status: 'ACTIVE'` via updateMany rather than update: if
 * another transaction resolved it first, this matches nothing and reports 0
 * instead of overwriting a resolution that has already been recorded with a
 * different reason.
 */
export async function resolveAlert(
  tx: Prisma.TransactionClient,
  alertId: string,
  resolution: 'STOCK_RECOVERED' | 'MONITORING_DISABLED' | 'THRESHOLD_CHANGED' | 'VARIANT_REMOVED',
  stockAtResolve: number | null,
  at: Date,
): Promise<number> {
  const result = await tx.inventoryAlert.updateMany({
    where: { id: alertId, status: 'ACTIVE' },
    data: { status: 'RESOLVED', resolution, resolvedAt: at, stockAtResolve },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
//  Read paths
// ---------------------------------------------------------------------------

const MONITOR_VIEW_SELECT = {
  id: true,
  variantId: true,
  threshold: true,
  isActive: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  variant: {
    select: {
      sku: true,
      title: true,
      crmStockQty: true,
      inventoryQty: true,
      rsProductId: true,
      rsProduct: { select: { title: true } },
    },
  },
  alerts: {
    where: { status: 'ACTIVE' as const },
    take: 1,
  },
  _count: { select: { alerts: true } },
} satisfies Prisma.MonitoredVariantSelect;

export type MonitorViewRow = Prisma.MonitoredVariantGetPayload<{
  select: typeof MONITOR_VIEW_SELECT;
}>;

/**
 * A page of monitored variants.
 *
 * One query including the live alert and a count, not one query per row: a
 * table showing an alert badge per row is exactly the shape that becomes an
 * N+1 by accident.
 */
export async function listMonitored(query: ListMonitoredVariantsQuery): Promise<{
  rows: MonitorViewRow[];
  nextCursor: string | null;
}> {
  const where: Prisma.MonitoredVariantWhereInput = {};

  // Archived configurations are hidden unless asked for: their variant is gone,
  // so there is nothing to act on, but the history still matters.
  if (!query.includeArchived) where.archivedAt = null;
  if (query.alerting) where.alerts = { some: { status: 'ACTIVE' } };

  if (query.q) {
    // Title or SKU, matching the catalogue's own search so the two feel alike.
    where.variant = {
      OR: [
        { sku: { contains: query.q, mode: 'insensitive' } },
        { rsProduct: { title: { contains: query.q, mode: 'insensitive' } } },
      ],
    };
  }

  const rows = await prisma.monitoredVariant.findMany({
    where,
    select: MONITOR_VIEW_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

export function findMonitored(id: string): Promise<MonitorViewRow | null> {
  return prisma.monitoredVariant.findUnique({ where: { id }, select: MONITOR_VIEW_SELECT });
}

export async function listAlerts(query: ListInventoryAlertsQuery): Promise<{
  rows: Prisma.InventoryAlertGetPayload<Record<string, never>>[];
  nextCursor: string | null;
}> {
  const where: Prisma.InventoryAlertWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.monitoredVariantId) where.monitoredVariantId = query.monitoredVariantId;

  const rows = await prisma.inventoryAlert.findMany({
    where,
    // Active first, then newest — the order the page reads in.
    orderBy: [{ status: 'asc' }, { raisedAt: 'desc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

/**
 * The summary, as four aggregate queries rather than a scan.
 *
 * `totalShortfall` is computed from the active alerts' live variant stock where
 * the variant still exists; an alert whose variant has gone contributes nothing,
 * because there is no current stock to be short of.
 */
export async function summarise(): Promise<{
  activeAlerts: number;
  monitoredVariants: number;
  archivedConfigurations: number;
  shortfallRows: { threshold: number; crmStockQty: number }[];
  negativeStockVariants: number;
}> {
  const [activeAlerts, monitoredVariants, archivedConfigurations, shortfallRows, negativeStock] =
    await Promise.all([
      prisma.inventoryAlert.count({ where: { status: 'ACTIVE' } }),
      prisma.monitoredVariant.count({ where: { isActive: true, archivedAt: null } }),
      prisma.monitoredVariant.count({ where: { archivedAt: { not: null } } }),
      prisma.monitoredVariant.findMany({
        where: { isActive: true, archivedAt: null, alerts: { some: { status: 'ACTIVE' } } },
        select: { threshold: true, variant: { select: { crmStockQty: true } } },
      }),
      prisma.shopifyVariant.count({ where: { crmStockQty: { lt: 0 } } }),
    ]);

  return {
    activeAlerts,
    monitoredVariants,
    archivedConfigurations,
    shortfallRows: shortfallRows
      .filter((r): r is typeof r & { variant: { crmStockQty: number } } => r.variant !== null)
      .map((r) => ({ threshold: r.threshold, crmStockQty: r.variant.crmStockQty })),
    negativeStockVariants: negativeStock,
  };
}

/** Variants offered in the add-monitor picker, with their existing config state. */
export async function searchCandidates(query: {
  q?: string;
  limit: number;
  cursor?: string;
}): Promise<{
  rows: {
    id: string;
    sku: string | null;
    title: string | null;
    crmStockQty: number;
    inventoryQty: number;
    rsProductId: string;
    rsProduct: { title: string };
    monitoring: { id: string } | null;
  }[];
  nextCursor: string | null;
}> {
  const where: Prisma.ShopifyVariantWhereInput = {};
  if (query.q) {
    where.OR = [
      { sku: { contains: query.q, mode: 'insensitive' } },
      { rsProduct: { title: { contains: query.q, mode: 'insensitive' } } },
    ];
  }

  const rows = await prisma.shopifyVariant.findMany({
    where,
    select: {
      id: true,
      sku: true,
      title: true,
      crmStockQty: true,
      inventoryQty: true,
      rsProductId: true,
      rsProduct: { select: { title: true } },
      monitoring: { select: { id: true } },
    },
    orderBy: [{ rsProductId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
}

/** Creates a configuration. P2002 on `variantId` means one already exists. */
export function createMonitor(
  tx: Prisma.TransactionClient,
  input: { variantId: string; threshold: number; createdById: string },
): Promise<{ id: string }> {
  return tx.monitoredVariant.create({
    data: { variantId: input.variantId, threshold: input.threshold, createdById: input.createdById },
    select: { id: true },
  });
}

export async function updateMonitor(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.MonitoredVariantUpdateInput,
): Promise<void> {
  await tx.monitoredVariant.update({ where: { id }, data });
}

/**
 * Configurations whose variant has been deleted.
 *
 * Reachable now that `MonitoredVariant.variantId` is nullable with `SetNull`: a
 * Shopify sync removing a variant detaches these rows instead of deleting them,
 * which is what keeps their alert history alive. Each one still needs archiving
 * and any live alert closing with VARIANT_REMOVED, and that is what this feeds.
 *
 * Filtered on `archivedAt: null` so an already-reconciled row is not returned
 * twice — the sweep is idempotent and can run as often as is convenient.
 */
export function findDetachedMonitors(): Promise<{ id: string }[]> {
  return prisma.monitoredVariant.findMany({
    where: { variantId: null, archivedAt: null },
    select: { id: true },
  });
}
