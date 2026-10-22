/**
 * What the Inventory Alerts API returns.
 *
 * Counts are numbers because they count things; every identifier is a string.
 * Dates are ISO strings, matching the rest of the CRM.
 */

import type { InventoryAlertResolutionValue } from '../utils/inventory-alert.js';

export type InventoryAlertStatusValue = 'ACTIVE' | 'RESOLVED';

/**
 * One monitored variant, with everything the page needs to render a row.
 *
 * `variantId` is the identity throughout — `ShopifyVariant.id`, a cuid. The SKU
 * is shown because people recognise it, but it is never the key: the live
 * catalogue holds five duplicate SKU groups and two variants with none.
 */
export type MonitoredVariantView = {
  id: string;
  /**
   * Null once the variant has been deleted.
   *
   * The configuration row survives detached so its alert history does; the
   * snapshots on each alert remain the description of what happened.
   */
  variantId: string | null;
  threshold: number;
  isActive: boolean;
  /** Set when the variant this watched no longer exists. */
  archivedAt: string | null;

  /** Live variant facts. Null once the variant has been removed. */
  sku: string | null;
  variantTitle: string | null;
  productTitle: string;
  rsProductId: string;
  /** The CRM's own count — what the threshold is compared against. */
  crmStockQty: number;
  /**
   * Shopify's figure, shown beside CRM stock so the two are never conflated.
   * Deliberately not used in any alert decision.
   */
  inventoryQty: number;

  /** The live alert, when there is one. */
  activeAlert: InventoryAlertView | null;
  /** How many lifecycles this configuration has been through. */
  alertCount: number;

  createdAt: string;
  updatedAt: string;
};

/**
 * One low-stock episode.
 *
 * The `*AtRaise` fields are snapshots, not lookups. An alert says "stock was 2
 * against a threshold of 10 on this date"; reading the threshold live would
 * rewrite that sentence whenever somebody edited the configuration, and the
 * product title would vanish entirely once the variant did.
 */
export type InventoryAlertView = {
  id: string;
  monitoredVariantId: string;
  /** Null once the variant has been deleted — the snapshots are then all there is. */
  variantId: string | null;

  status: InventoryAlertStatusValue;
  resolution: InventoryAlertResolutionValue | null;

  thresholdAtRaise: number;
  stockAtRaise: number;
  productTitleAtRaise: string;
  skuAtRaise: string | null;
  rsProductIdAtRaise: string;

  raisedAt: string;
  resolvedAt: string | null;
  stockAtResolve: number | null;
};

/** The dashboard card, and the page header. */
export type InventoryAlertSummary = {
  /** Live alerts across every enabled configuration. */
  activeAlerts: number;
  /** Configurations being evaluated. */
  monitoredVariants: number;
  /** Configurations whose variant has gone — nothing left to watch. */
  archivedConfigurations: number;
  /** Units short of threshold, summed across active alerts. */
  totalShortfall: number;
  /**
   * Variants whose CRM stock is negative.
   *
   * `crmStockSchema` forbids one, so this should be zero. Surfaced rather than
   * clamped: a non-zero count means stock reached the column through a path
   * that bypassed validation, which is a defect to see.
   */
  negativeStockVariants: number;
};

/** A variant offered for monitoring, from the product/SKU search. */
export type MonitorCandidateView = {
  variantId: string;
  sku: string | null;
  variantTitle: string | null;
  productTitle: string;
  rsProductId: string;
  crmStockQty: number;
  inventoryQty: number;
  /** True when this variant already has a configuration. */
  isMonitored: boolean;
};
