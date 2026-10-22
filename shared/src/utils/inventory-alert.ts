/**
 * Low-stock rules — the one place they live.
 *
 * Pure: no database, no clock, no I/O. Both CRM stock writers call the lifecycle
 * service, and the service asks these functions what should happen. There is no
 * second implementation to drift from, which is what makes the Inventory Alerts
 * page and the dashboard agree.
 *
 * ### CRM stock, never Shopify's
 *
 * Every decision here reads `crmStockQty` — the count somebody maintains by
 * hand. `inventoryQty` is Shopify's sellable figure: it is overwritten by every
 * sync and every inventory webhook, it can legitimately be negative, and it
 * says nothing about what the warehouse holds. Alerting on it would raise
 * notices about a number the CRM does not own.
 *
 * ### The rule
 *
 *     low  ⟺  crmStockQty <= threshold
 *
 * `<=`, not `<`: a threshold of 10 means "tell me when ten or fewer are left",
 * which is how a buyer reads it. Exactly-at-threshold is the case most likely
 * to be written wrongly, so it has its own test.
 */

/** What the evaluator needs to know. Deliberately not the whole variant row. */
export type AlertEvaluationInput = {
  /** The CRM's own count. Never Shopify's `inventoryQty`. */
  crmStockQty: number;
  threshold: number;
  /** False when monitoring is switched off, or its variant has gone. */
  isMonitoringActive: boolean;
  /** Whether a live alert already exists for this configuration. */
  hasActiveAlert: boolean;
};

/** Why an alert stopped being active. Mirrors the Prisma enum exactly. */
export const INVENTORY_ALERT_RESOLUTIONS = [
  'STOCK_RECOVERED',
  'MONITORING_DISABLED',
  'THRESHOLD_CHANGED',
  'VARIANT_REMOVED',
] as const;
export type InventoryAlertResolutionValue = (typeof INVENTORY_ALERT_RESOLUTIONS)[number];

/**
 * What the lifecycle service should do about one configuration.
 *
 * `NONE` is a first-class answer rather than a null, because "stock is low and
 * an alert already exists" and "stock is fine and no alert exists" are both
 * correct steady states. Returning a decision for them is what makes repeated
 * evaluation idempotent: the second call reports NONE and the service writes
 * nothing.
 */
export type AlertDecision =
  | { action: 'RAISE' }
  | { action: 'RESOLVE'; resolution: InventoryAlertResolutionValue }
  | { action: 'NONE' };

/** Whether this stock level is at or below the level somebody chose to watch. */
export function isLowStock(crmStockQty: number, threshold: number): boolean {
  return crmStockQty <= threshold;
}

/**
 * The decision for one monitoring configuration.
 *
 * Ordered so the disabled case is answered first: a switched-off configuration
 * must never raise, whatever the stock is, and an alert it left behind has to
 * be resolved rather than abandoned as permanently live.
 *
 * A negative `crmStockQty` is treated as low — it is, arithmetically — and is
 * never rewritten here. `crmStockSchema` forbids entering one and the live
 * catalogue holds none, so a negative means stock moved through a path that
 * bypassed validation. Raising on it surfaces that; silently clamping it to
 * zero would hide a real oversell.
 */
export function decideAlert(input: AlertEvaluationInput): AlertDecision {
  if (!input.isMonitoringActive) {
    // Switched off, or the variant is gone. An alert it was holding is closed;
    // the caller supplies the reason, because only it knows which happened.
    return input.hasActiveAlert
      ? { action: 'RESOLVE', resolution: 'MONITORING_DISABLED' }
      : { action: 'NONE' };
  }

  const low = isLowStock(input.crmStockQty, input.threshold);

  if (low && !input.hasActiveAlert) return { action: 'RAISE' };

  if (!low && input.hasActiveAlert) {
    return { action: 'RESOLVE', resolution: 'STOCK_RECOVERED' };
  }

  /*
    Steady state, either way:
      - low and already alerting → the SAME alert stands. Not a new one: a
        second active alert for one configuration would double-count on the
        dashboard, and the partial unique index refuses it anyway.
      - not low and not alerting → nothing to say.
  */
  return { action: 'NONE' };
}

/**
 * The decision after a threshold edit.
 *
 * Separate from `decideAlert` only in the resolution it reports: stock did not
 * move, the bar did, and a history that said STOCK_RECOVERED would be a lie
 * about what happened. Raising is identical — a lowered bar that newly catches
 * the current stock is an ordinary new lifecycle.
 */
export function decideAfterThresholdChange(input: AlertEvaluationInput): AlertDecision {
  const decision = decideAlert(input);
  if (decision.action === 'RESOLVE' && decision.resolution === 'STOCK_RECOVERED') {
    return { action: 'RESOLVE', resolution: 'THRESHOLD_CHANGED' };
  }
  return decision;
}

/**
 * How short of the threshold this variant is, for display.
 *
 * Zero when stock is at the threshold exactly — that is low, but nothing is
 * missing yet. Never negative: a variant above its threshold has no shortfall,
 * and a negative number there would read as a surplus the caller did not ask
 * for.
 */
export function stockShortfall(crmStockQty: number, threshold: number): number {
  if (!isLowStock(crmStockQty, threshold)) return 0;
  return threshold - crmStockQty;
}
