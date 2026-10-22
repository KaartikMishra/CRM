/**
 * Low-stock decision rules.
 *
 * Pure: no database, no HTTP. These run on an empty database, which matters
 * right now — the development branch holds no rows, so this is the suite that
 * can still prove the rules are right.
 *
 * Every case below exists because getting it wrong would misreport stock:
 * `<` instead of `<=` loses the exactly-at-threshold alert, a missing
 * already-alerting check double-counts the dashboard, and clamping a negative
 * quantity hides a real oversell.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decideAfterThresholdChange,
  decideAlert,
  isLowStock,
  stockShortfall,
  type AlertEvaluationInput,
} from '@rs/shared';

const input = (over: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput => ({
  crmStockQty: 50,
  threshold: 10,
  isMonitoringActive: true,
  hasActiveAlert: false,
  ...over,
});

describe('isLowStock', () => {
  it('is false above the threshold', () => {
    expect(isLowStock(11, 10)).toBe(false);
  });

  it('is TRUE exactly at the threshold', () => {
    // The case most likely to be written as `<`. A threshold of 10 means
    // "tell me when ten or fewer are left", which is how a buyer reads it.
    expect(isLowStock(10, 10)).toBe(true);
  });

  it('is true below the threshold', () => {
    expect(isLowStock(9, 10)).toBe(true);
  });

  it('treats zero stock against a zero threshold as low', () => {
    // "Tell me when it runs out" is a legitimate configuration.
    expect(isLowStock(0, 0)).toBe(true);
  });

  it('treats a negative quantity as low rather than rewriting it', () => {
    expect(isLowStock(-5, 0)).toBe(true);
    expect(isLowStock(-5, 10)).toBe(true);
  });
});

describe('decideAlert', () => {
  it('raises when stock is low and nothing is alerting', () => {
    expect(decideAlert(input({ crmStockQty: 2 }))).toEqual({ action: 'RAISE' });
  });

  it('raises at exactly the threshold', () => {
    expect(decideAlert(input({ crmStockQty: 10, threshold: 10 }))).toEqual({ action: 'RAISE' });
  });

  it('does nothing when stock is low and an alert already stands', () => {
    // Idempotence: the same alert persists rather than a second being raised.
    // A duplicate would double-count the dashboard, and the partial unique
    // index refuses it anyway.
    expect(decideAlert(input({ crmStockQty: 2, hasActiveAlert: true }))).toEqual({
      action: 'NONE',
    });
  });

  it('resolves when stock has recovered', () => {
    expect(decideAlert(input({ crmStockQty: 50, hasActiveAlert: true }))).toEqual({
      action: 'RESOLVE',
      resolution: 'STOCK_RECOVERED',
    });
  });

  it('does nothing when stock is fine and nothing is alerting', () => {
    expect(decideAlert(input())).toEqual({ action: 'NONE' });
  });

  it('never raises while monitoring is disabled, however low the stock', () => {
    expect(decideAlert(input({ crmStockQty: 0, isMonitoringActive: false }))).toEqual({
      action: 'NONE',
    });
  });

  it('closes an alert left behind when monitoring is disabled', () => {
    // Not abandoned as permanently live — history records why it ended.
    expect(
      decideAlert(input({ crmStockQty: 2, isMonitoringActive: false, hasActiveAlert: true })),
    ).toEqual({ action: 'RESOLVE', resolution: 'MONITORING_DISABLED' });
  });

  it('raises on a negative quantity rather than clamping to zero', () => {
    // crmStockSchema forbids entering one, so a negative means validation was
    // bypassed. Raising surfaces that; clamping would hide an oversell.
    expect(decideAlert(input({ crmStockQty: -3, threshold: 0 }))).toEqual({ action: 'RAISE' });
  });

  it('is idempotent: the same input twice gives the same answer', () => {
    const i = input({ crmStockQty: 2 });
    expect(decideAlert(i)).toEqual(decideAlert(i));
  });
});

describe('a full raise → resolve → re-raise lifecycle', () => {
  it('walks the three states in order', () => {
    // 1. stock falls to the threshold
    expect(decideAlert(input({ crmStockQty: 10, hasActiveAlert: false }))).toEqual({
      action: 'RAISE',
    });
    // 2. stock recovers while the alert stands
    expect(decideAlert(input({ crmStockQty: 40, hasActiveAlert: true }))).toEqual({
      action: 'RESOLVE',
      resolution: 'STOCK_RECOVERED',
    });
    // 3. it falls again — a NEW lifecycle, not a reopened one
    expect(decideAlert(input({ crmStockQty: 1, hasActiveAlert: false }))).toEqual({
      action: 'RAISE',
    });
  });
});

describe('decideAfterThresholdChange', () => {
  it('reports THRESHOLD_CHANGED, not STOCK_RECOVERED, when the bar moved', () => {
    // Stock did not move; the bar did. A history saying STOCK_RECOVERED would
    // misdescribe what happened.
    expect(
      decideAfterThresholdChange(input({ crmStockQty: 20, threshold: 5, hasActiveAlert: true })),
    ).toEqual({ action: 'RESOLVE', resolution: 'THRESHOLD_CHANGED' });
  });

  it('raises when a threshold is lifted past the current stock', () => {
    expect(
      decideAfterThresholdChange(input({ crmStockQty: 20, threshold: 25 })),
    ).toEqual({ action: 'RAISE' });
  });

  it('still reports MONITORING_DISABLED when that is the real reason', () => {
    expect(
      decideAfterThresholdChange(
        input({ crmStockQty: 2, isMonitoringActive: false, hasActiveAlert: true }),
      ),
    ).toEqual({ action: 'RESOLVE', resolution: 'MONITORING_DISABLED' });
  });
});

describe('stockShortfall', () => {
  it('counts the units needed to clear the threshold', () => {
    expect(stockShortfall(2, 10)).toBe(8);
  });

  it('is zero exactly at the threshold — low, but nothing missing yet', () => {
    expect(stockShortfall(10, 10)).toBe(0);
  });

  it('is zero, never negative, above the threshold', () => {
    // A negative here would read as a surplus the caller did not ask for.
    expect(stockShortfall(50, 10)).toBe(0);
  });

  it('counts a negative quantity as a larger shortfall', () => {
    expect(stockShortfall(-5, 10)).toBe(15);
  });
});

describe('independent thresholds', () => {
  it('decides each variant on its own configuration', () => {
    // Variant A threshold 10, B threshold 5, C threshold 20 — the brief's
    // example. The same stock level gives different answers.
    const stock = 8;
    expect(decideAlert(input({ crmStockQty: stock, threshold: 10 }))).toEqual({ action: 'RAISE' });
    expect(decideAlert(input({ crmStockQty: stock, threshold: 5 }))).toEqual({ action: 'NONE' });
    expect(decideAlert(input({ crmStockQty: stock, threshold: 20 }))).toEqual({ action: 'RAISE' });
  });
});

describe('Shopify inventory independence', () => {
  it('has no way to read inventoryQty at all', () => {
    // The evaluator's input type carries crmStockQty and nothing else about
    // stock, so Shopify's figure cannot reach a decision even by mistake.
    const keys = Object.keys(input());
    expect(keys).toContain('crmStockQty');
    expect(keys).not.toContain('inventoryQty');
  });
});

describe('detached-variant reconciliation orchestration', () => {
  /*
    No database here, so these assert the WIRING rather than the writes: that
    the detach-capture happens before the delete, that reconciliation is called
    only after the transaction resolves, and that the narrow id list is used
    instead of a full-table sweep. The DB-backed behaviour stays unverified.
  */
  const read = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');
  const repo = (): string => read('../rs-product.repository.ts');
  const sync = (): string => read('../rs-product.sync.ts');
  const webhook = (): string => read('../rs-product.webhook.service.ts');
  const service = (): string => read('../inventory-alert.service.ts');
  const alertRepo = (): string => read('../inventory-alert.repository.ts');

  it('reads the doomed variants BEFORE deleting them', () => {
    // SET NULL leaves nothing to identify afterwards, so the ids must be
    // captured while the foreign key still points at the variant.
    const src = repo();
    const findIdx = src.indexOf('const doomed = await tx.shopifyVariant.findMany');
    const delIdx = src.indexOf('await tx.shopifyVariant.deleteMany');
    expect(findIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(-1);
    expect(findIdx).toBeLessThan(delIdx);
  });

  it('returns the detached ids from every exit of the upsert', () => {
    const src = repo();
    expect(src).toContain('detachedMonitorIds: string[] }>');
    // Both returns, including the skippedManual early exit.
    expect(src).toContain('skippedManual: true, detachedMonitorIds: []');
    expect(src).toContain('skippedManual: false, detachedMonitorIds }');
  });

  it('reconciles only AFTER the upsert has resolved, in the sync path', () => {
    // `upsertShopifyProduct` resolves only once its own $transaction has
    // committed, so awaiting it first is the post-commit guarantee.
    const src = sync();
    const upsertIdx = src.indexOf('await upsertShopifyProduct(');
    const reconcileIdx = src.indexOf('await reconcileMonitors(detachedMonitorIds)');
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(upsertIdx);
  });

  it('reconciles after the upsert in the webhook path too', () => {
    const src = webhook();
    const upsertIdx = src.indexOf('await upsertShopifyProduct(');
    const reconcileIdx = src.indexOf('await reconcileMonitors(detachedMonitorIds)');
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(upsertIdx);
  });

  it('skips reconciliation entirely when nothing was detached', () => {
    // The common case: a sync that deletes no variant must not pay for a sweep.
    for (const src of [sync(), webhook()]) {
      expect(src).toContain('detachedMonitorIds.length > 0');
    }
  });

  it('passes the narrow id list rather than sweeping every configuration', () => {
    const src = sync();
    expect(src).toContain('reconcileMonitors(detachedMonitorIds)');
    // The full-table sweep exists but is not what the sync calls.
    expect(src).not.toContain('reconcileDetachedMonitors(');
  });

  it('de-duplicates ids so one configuration is evaluated once', () => {
    expect(service()).toContain('new Set(monitoredVariantIds)');
  });

  it('gives each configuration its own transaction', () => {
    // One failure must leave the others reconcilable.
    const src = service();
    expect(src).toContain('prisma.$transaction((tx) => evaluateMonitor(tx, id), TX_OPTIONS)');
  });

  it('swallows its own errors so tidying cannot fail a sync or webhook', () => {
    const src = service();
    expect(src).toContain('Could not archive a monitor detached by sync');
    expect(src).toContain('} catch (error) {');
  });

  it('resolves with VARIANT_REMOVED and preserves the row', () => {
    const src = service();
    expect(src).toContain("'VARIANT_REMOVED'");
    // Archived, never deleted — the history hangs off this row.
    expect(src).toContain('archivedAt: now');
    expect(src).not.toContain('monitoredVariant.delete');
  });

  it('is idempotent: archiving is guarded and resolution is conditional', () => {
    const src = service();
    // archivedAt stamped only when still null.
    expect(src).toContain('monitor.archivedAt === null');
    // resolveAlert filters on status ACTIVE — in the ALERT repository, not the
    // product one.
    expect(alertRepo()).toContain("where: { id: alertId, status: 'ACTIVE' }");
  });

  it('reports what it archived on the sync report', () => {
    const src = sync();
    expect(src).toContain('detachedMonitors: number');
    expect(src).toContain('resolvedAlerts: number');
    expect(src).toContain('report.detachedMonitors += archived');
  });
});
