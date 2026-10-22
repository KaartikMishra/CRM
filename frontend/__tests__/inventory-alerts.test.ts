/**
 * Inventory Alerts — display and wiring rules.
 *
 * Pure-logic, like the rest of this suite: no DOM, no database. The helpers are
 * asserted directly; pages and components are asserted against their source,
 * which is how this suite already checks declarations it cannot execute.
 *
 * These run on an empty development database, which is why they matter right
 * now — they are the frontend coverage that is not blocked by the data loss.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { MonitoredVariantView } from '@rs/shared';
import { monitorState, resolutionLabel, variantLabel } from '@/components/rs-products/alert-tables';

const monitored = (over: Partial<MonitoredVariantView> = {}): MonitoredVariantView => ({
  id: 'clx0000000000000000000001',
  variantId: 'clx0000000000000000000002',
  threshold: 10,
  isActive: true,
  archivedAt: null,
  sku: 'RS2473',
  variantTitle: 'Default Title',
  productTitle: 'Copper Kadai',
  rsProductId: 'clx0000000000000000000003',
  crmStockQty: 2,
  inventoryQty: 1000,
  activeAlert: null,
  alertCount: 0,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  ...over,
});

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = (): string => read('../app/(app)/rs-products/alerts/page.tsx');
const tables = (): string => read('../components/rs-products/alert-tables.tsx');
const controls = (): string => read('../components/rs-products/alert-controls.tsx');
const card = (): string => read('../components/rs-products/alert-summary-card.tsx');
const nav = (): string => read('../components/layout/nav-items.ts');

describe('variant identity in the UI', () => {
  it('combines SKU and variant title when both say something', () => {
    expect(variantLabel({ sku: 'RS2525', variantTitle: 'Red / Large' })).toBe('RS2525 · Red / Large');
  });

  it("suppresses Shopify's Default Title placeholder", () => {
    // 465 of 501 products carry it; printing it would say nothing.
    expect(variantLabel({ sku: 'RS2473', variantTitle: 'Default Title' })).toBe('RS2473');
  });

  it('falls back to the title when a variant has no SKU', () => {
    // Two live variants have none, so the SKU can never be the only label.
    expect(variantLabel({ sku: null, variantTitle: 'Red / Large' })).toBe('Red / Large');
  });

  it('shows the placeholder when a variant has neither', () => {
    expect(variantLabel({ sku: null, variantTitle: null })).toBe('—');
  });
});

describe('monitor state', () => {
  it('is Alerting when a live alert exists', () => {
    const row = monitored({
      activeAlert: {
        id: 'a',
        monitoredVariantId: 'm',
        variantId: 'v',
        status: 'ACTIVE',
        resolution: null,
        thresholdAtRaise: 10,
        stockAtRaise: 2,
        productTitleAtRaise: 'Copper Kadai',
        skuAtRaise: 'RS2473',
        rsProductIdAtRaise: 'p',
        raisedAt: '2026-10-22T00:00:00.000Z',
        resolvedAt: null,
        stockAtResolve: null,
      },
    });
    expect(monitorState(row)).toBe('Alerting');
  });

  it('is Paused when monitoring is switched off', () => {
    expect(monitorState(monitored({ isActive: false }))).toBe('Paused');
  });

  it('is Removed when the variant has gone, whatever else is true', () => {
    expect(monitorState(monitored({ archivedAt: '2026-10-22T00:00:00.000Z' }))).toBe('Removed');
  });

  it('is OK when monitored and not low', () => {
    expect(monitorState(monitored({ crmStockQty: 50 }))).toBe('OK');
  });
});

describe('resolution labels', () => {
  const alert = (over: Record<string, unknown>) =>
    ({
      id: 'a',
      monitoredVariantId: 'm',
      variantId: 'v',
      status: 'RESOLVED',
      resolution: null,
      thresholdAtRaise: 10,
      stockAtRaise: 2,
      productTitleAtRaise: 'x',
      skuAtRaise: null,
      rsProductIdAtRaise: 'p',
      raisedAt: '2026-10-22T00:00:00.000Z',
      resolvedAt: '2026-10-22T01:00:00.000Z',
      stockAtResolve: 20,
      ...over,
    }) as never;

  it('distinguishes every reason an alert can end', () => {
    // Four distinct stories. A history that collapsed them would misreport.
    expect(resolutionLabel(alert({ resolution: 'STOCK_RECOVERED' }))).toBe('Stock recovered');
    expect(resolutionLabel(alert({ resolution: 'MONITORING_DISABLED' }))).toBe(
      'Monitoring switched off',
    );
    expect(resolutionLabel(alert({ resolution: 'THRESHOLD_CHANGED' }))).toBe('Threshold changed');
    expect(resolutionLabel(alert({ resolution: 'VARIANT_REMOVED' }))).toBe('Variant removed');
  });

  it('calls an active alert Active, never resolved', () => {
    expect(resolutionLabel(alert({ status: 'ACTIVE', resolution: null }))).toBe('Active');
  });
});

describe('CRM stock, never Shopify inventory', () => {
  it('compares the threshold against crmStockQty in the table', () => {
    const src = tables();
    expect(src).toContain('row.crmStockQty');
    expect(src).toContain('stockShortfall(row.crmStockQty, row.threshold)');
    // inventoryQty appears only as its own labelled column.
    expect(src).toContain('Shopify qty');
    expect(src).not.toContain('stockShortfall(row.inventoryQty');
  });

  it('says so on the page itself', () => {
    expect(page()).toContain("Shopify's own quantity is never used for these alerts");
  });
});

describe('threshold validation in the UI', () => {
  it('mirrors the backend rules without replacing them', () => {
    const src = controls();
    expect(src).toContain('must be a whole number');
    expect(src).toContain('cannot be negative');
    // Stated as a convenience, with the API named as the real authority.
    expect(src).toContain('the API stays the only authority');
    expect(src).toContain('spare a round trip');
  });
});

describe('dismissal is presentation, never resolution', () => {
  it('says plainly that dismissing does not resolve the alerts', () => {
    expect(controls()).toContain('does not resolve the alerts');
  });

  it('calls no resolve action from the popup', () => {
    const src = controls();
    expect(src).not.toContain('resolveAlertAction');
    expect(src).not.toContain("status: 'RESOLVED'");
  });
});

describe('the alerts page', () => {
  it('is gated on VIEW to read and EDIT to configure', () => {
    const src = page();
    expect(src).toContain("requireModule('RS_PRODUCTS')");
    expect(src).toContain("'RS_PRODUCTS', 'VIEW'");
    expect(src).toContain("can(access.user, 'RS_PRODUCTS', 'EDIT')");
    expect(src).toContain('NoModuleAccess');
  });

  it('offers the add and edit controls only to an editor', () => {
    const src = page();
    expect(src).toContain('canEdit &&');
    expect(src).toContain('<AddMonitorForm');
    expect(src).toContain('<MonitorControls');
  });

  it('renders loading-free parallel fetches rather than sequential ones', () => {
    expect(page()).toContain('await Promise.all([');
  });

  it('renders an error state for each failed request', () => {
    const src = page();
    expect(src).toContain('ErrorMessage');
    expect(src).toContain('!monitored.result.success');
    expect(src).toContain('!history.result.success');
  });

  it('states the empty cases rather than showing bare tables', () => {
    const src = tables();
    expect(src).toContain('No variants are being monitored yet');
    expect(src).toContain('No alerts have been raised yet');
  });

  it('paginates rather than loading hundreds of rows', () => {
    expect(read('../lib/rs-product-api.ts')).toContain('RS_PRODUCT_PAGE_LIMIT');
  });

  it('shows history snapshots, not live lookups', () => {
    // What keeps history readable after a variant is deleted.
    const src = tables();
    expect(src).toContain('a.productTitleAtRaise');
    expect(src).toContain('a.skuAtRaise');
    expect(src).toContain('variant since removed');
  });

  it('surfaces negative CRM stock as an anomaly', () => {
    expect(page()).toContain('negativeStockVariants');
    expect(page()).toContain('negative CRM stock');
  });
});

describe('the dashboard summary card', () => {
  it('shows the active-alert count and links to the page', () => {
    const src = card();
    expect(src).toContain('summary.activeAlerts');
    expect(src).toContain("href=\"/rs-products/alerts\"");
  });

  it('renders on failure rather than disappearing', () => {
    // The stock-valuation card's lesson: an absent card looks like an unbuilt
    // feature.
    const src = card();
    expect(src).toContain('unavailable');
    expect(src).toContain('misleading zero');
  });

  it('is wired into the dashboard behind the module gate', () => {
    const src = read('../app/(app)/dashboard/page.tsx');
    expect(src).toContain('canProducts ? fetchAlertSummary() : null');
    expect(src).toContain('<AlertSummaryCard');
  });
});

describe('navigation', () => {
  it('adds Inventory Alerts under RS Products with the same module gate', () => {
    const src = nav();
    expect(src).toContain("label: 'Inventory Alerts'");
    expect(src).toContain("href: '/rs-products/alerts'");
    expect(src).toContain("icon: 'inventory-alerts'");
  });

  it('registers the icon key so the sidebar can render it', () => {
    expect(nav()).toContain("| 'inventory-alerts'");
    expect(read('../components/layout/nav-icons.tsx')).toContain("'inventory-alerts':");
  });
});
