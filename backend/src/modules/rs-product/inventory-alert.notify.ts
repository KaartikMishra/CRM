/**
 * Inventory Alerts — notification drafts and delivery.
 *
 * ### Why `entityId` is the ALERT id, not the variant id
 *
 * `Notification` is uniquely keyed on `(recipientId, type, entityId)`, which is
 * what stops a retried request raising the same notice twice. If the entity
 * were the variant, that constraint would also block the *second* low-stock
 * episode for the same variant forever: stock goes low, recovers, goes low
 * again, and the third event silently collides with the first.
 *
 * Using the alert id makes each lifecycle its own entity. A new episode is a
 * new row, a retry of the same episode still collides, and nothing had to
 * change in the notification schema.
 *
 * ### Recipients
 *
 * `RS_PRODUCTS:EDIT`, not VIEW. Deliberately the narrower group: a low-stock
 * notice is a prompt to reorder or to adjust a threshold, and only an EDIT
 * holder can do either. Sending it to everyone who may merely read the
 * catalogue would put an unactionable alert in a salesperson's bell several
 * times a day. VIEW still sees every alert on the Inventory Alerts page — the
 * notice is a nudge, not the record.
 *
 * ### No money in a notice
 *
 * The body carries the product, the SKU, the stock and the threshold. Never
 * `costPrice` or a stock valuation: a bell is read by more colleagues than may
 * read what stock cost, and the same rule is stated in the payroll module.
 */

import { logger } from '../../config/logger.js';
import * as notifications from '../notification/notification.service.js';
import { usersWithPermission } from '../../services/permission.service.js';

/** Everyone who could act on a low-stock alert. */
export async function alertRecipients(): Promise<string[]> {
  const users = await usersWithPermission('RS_PRODUCTS', 'EDIT');
  return users.map((u) => u.id);
}

type LowStockFacts = {
  alertId: string;
  productTitle: string;
  sku: string | null;
  crmStockQty: number;
  threshold: number;
};

/**
 * The low-stock notice.
 *
 * The SKU is included when there is one because staff recognise `RS2473` more
 * readily than an 80-character title — but it is never the identity: the
 * catalogue holds duplicate SKUs, so the href carries the alert id.
 */
export const lowStockDraft = (facts: LowStockFacts) => ({
  type: 'INVENTORY_LOW_STOCK' as const,
  title: 'Low stock',
  body: facts.sku
    ? `${facts.sku} — ${facts.crmStockQty} left (threshold ${facts.threshold})`
    : `${facts.productTitle} — ${facts.crmStockQty} left (threshold ${facts.threshold})`,
  href: '/rs-products/alerts',
  entityType: 'InventoryAlert',
  entityId: facts.alertId,
});

/** The recovery notice, for the same recipients and the same alert. */
export const stockRecoveredDraft = (facts: {
  alertId: string;
  productTitle: string;
  sku: string | null;
  crmStockQty: number;
}) => ({
  type: 'INVENTORY_STOCK_RECOVERED' as const,
  title: 'Stock recovered',
  body: facts.sku
    ? `${facts.sku} is back above its threshold (${facts.crmStockQty} in stock)`
    : `${facts.productTitle} is back above its threshold (${facts.crmStockQty} in stock)`,
  href: '/rs-products/alerts',
  entityType: 'InventoryAlert',
  entityId: facts.alertId,
});

/**
 * Pushes an already-persisted notice to whoever is connected.
 *
 * Called only after the caller's transaction has committed. Every failure is
 * logged and swallowed: the notification row is already durable, so the worst
 * case is that a recipient sees it on their next fetch rather than instantly.
 * A delivery failure must never be able to disturb the alert lifecycle or the
 * stock change that caused it.
 */
export async function deliver(
  recipientIds: string[],
  type: 'INVENTORY_LOW_STOCK' | 'INVENTORY_STOCK_RECOVERED',
  alertId: string,
): Promise<void> {
  try {
    await notifications.deliver(recipientIds, type, alertId);
  } catch (error) {
    logger.error({ err: error, type, alertId }, 'Failed to deliver inventory alert notification');
  }
}
