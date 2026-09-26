/**
 * The cancellation and refund screens, and the promises they make.
 *
 * These are source-reading structural tests, the convention this suite already
 * uses: the behaviour itself is enforced by the API and proved end to end by
 * the backend suite, so what is worth pinning here is the contract the UI is
 * written against. A screen that gets one of these wrong is not a cosmetic
 * problem — it tells somebody their customer has been paid back when they have
 * not, or hides the fact that three units were ordered and one called off.
 *
 * Three claims in particular:
 *
 *   1. Money is never recomputed in the browser. Every figure on these screens
 *      comes from the API's money view, which derived it with the same function
 *      the money guard mirrors in SQL.
 *
 *   2. Cancelling is never presented as refunding. The words are in the
 *      confirmation because the consequence is financial.
 *
 *   3. Ordered, cancelled and remaining are three numbers, not one that
 *      quietly shrinks.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const actions = read('app/(app)/sales/actions.ts');
const page = read('app/(app)/sales/[id]/page.tsx');
const bar = read('components/sales/sales-order-actions.tsx');
const cancelOrder = read('components/sales/cancel-order-dialog.tsx');
const cancelItems = read('components/sales/cancel-items-dialog.tsx');
const refunds = read('components/sales/refund-panel.tsx');
const payments = read('components/sales/payment-history.tsx');
const summary = read('components/sales/money-summary.tsx');
const itemList = read('components/sales/sales-item-list.tsx');

// ===========================================================================
//  1 — the endpoints, exactly as the API defines them
// ===========================================================================

describe('the server actions call the endpoints that already exist', () => {
  it('cancels an order and its individual units', () => {
    expect(actions).toContain('/api/sales/${orderId}/cancel`');
    expect(actions).toContain('/api/sales/${orderId}/cancel-items`');
  });

  it('creates, settles and rejects a refund', () => {
    expect(actions).toContain('/api/sales/${orderId}/refunds`');
    expect(actions).toContain('/api/sales/${orderId}/refunds/${refundId}/settle`');
    expect(actions).toContain('/api/sales/${orderId}/refunds/${refundId}/reject`');
  });

  it('invents no endpoint of its own', () => {
    // Every Sales path the actions file names must be one the router mounts.
    const paths = [...actions.matchAll(/\/api\/sales\/[^`]*/g)].map((m) => m[0]);
    const known = [
      '/api/sales/${orderId}',
      '/api/sales/${orderId}/charges',
      '/api/sales/${orderId}/payments',
      '/api/sales/${orderId}/dispatch',
      '/api/sales/${orderId}/close',
      '/api/sales/${orderId}/cancel',
      '/api/sales/${orderId}/cancel-items',
      '/api/sales/${orderId}/refunds',
      '/api/sales/${orderId}/refunds/${refundId}/settle',
      '/api/sales/${orderId}/refunds/${refundId}/reject',
      '/api/sales/${orderId}/change-requests',
      '/api/sales/${orderId}/change-requests/${requestId}/approve',
      '/api/sales/${orderId}/change-requests/${requestId}/reject',
      '/api/sales/${orderId}/charge-requests/${requestId}/approve',
      '/api/sales/${orderId}/charge-requests/${requestId}/reject',
    ];
    for (const path of paths) {
      expect(known, `unknown endpoint ${path}`).toContain(path);
    }
  });

  it('omits optional fields rather than sending them empty', () => {
    // The API reads an absent method as "the arrangement is unchanged"; an
    // empty string would fail validation for no reason.
    expect(actions).toContain("...(input.method ? { method: input.method } : {})");
    expect(actions).toContain("...(input.reference?.trim() ? { reference: input.reference.trim() } : {})");
  });
});

// ===========================================================================
//  2 — cancelling is not refunding
// ===========================================================================

describe('the cancellation confirmation says what it costs', () => {
  it('names the amount that becomes refundable', () => {
    expect(cancelOrder).toContain('becomes refundable');
    expect(cancelOrder).toContain('formatCurrency(paid, order.money.currency)');
  });

  it('says in so many words that no money is sent back', () => {
    expect(cancelOrder).toContain('Cancelling does not send any money back');
  });

  it('says nothing is deleted', () => {
    expect(cancelOrder).toMatch(/payment history\s*\n?\s*are kept exactly as they are/);
  });

  it('requires a reason before it will submit', () => {
    expect(cancelOrder).toContain('const usable = reason.trim().length > 0');
    expect(cancelOrder).toContain('disabled={pending || !usable}');
  });

  it('confirms rather than firing from the button', () => {
    expect(cancelOrder).toContain('AlertDialog');
    expect(cancelOrder).toContain('Keep the order');
  });

  it('relays the backend refusal rather than interpreting it', () => {
    expect(cancelOrder).toContain('toast.error(result.message');
  });
});

// ===========================================================================
//  3 — ordered, cancelled, remaining
// ===========================================================================

describe('the partial cancellation dialog keeps the three quantities apart', () => {
  it('shows all three as their own column', () => {
    for (const heading of ['Ordered', 'Cancelled', 'Left']) {
      expect(cancelItems, heading).toContain(`>${heading}</span>`);
    }
    expect(cancelItems).toContain('{item.quantity}');
    expect(cancelItems).toContain('{item.cancelledQty}');
    expect(cancelItems).toContain('{item.remainingQty}');
  });

  it('bounds what may be cancelled by what is left, not by what was ordered', () => {
    expect(cancelItems).toContain('row.quantity > row.item.remainingQty');
    expect(cancelItems).not.toContain('row.quantity > row.item.quantity');
  });

  it('offers cancelling everything remaining in one action', () => {
    expect(cancelItems).toContain('cancelAllRemaining');
    expect(cancelItems).toContain('item.remainingQty > 0');
  });

  it('warns when the selection would cancel the whole order', () => {
    expect(cancelItems).toContain('cancellingEverything');
    expect(cancelItems).toContain('the order itself will be cancelled');
  });

  it('sends how many MORE units to cancel, as the API expects', () => {
    expect(cancelItems).toContain('lines: chosen.map((row) => ({ itemId: row.item.id, quantity: row.quantity }))');
  });

  it('reconciles no stock of its own', () => {
    /*
      It must name no stock figure at all. The word "allocation" is deliberately
      NOT forbidden — the dialog explains the backend's allocation refusal, and
      that explanation is the correct behaviour rather than a leak of
      Procurement logic. What would be wrong is touching the numbers.
    */
    for (const forbidden of ['crmStockQty', 'stockedQty', 'receivedQty', 'reconcileLineStock']) {
      expect(cancelItems, forbidden).not.toContain(forbidden);
    }
  });
});

describe('the item table never shrinks the ordered quantity', () => {
  it('shows what is left against what was ordered once anything is cancelled', () => {
    expect(itemList).toContain('item.cancelledQty > 0');
    expect(itemList).toContain('{item.remainingQty}');
    expect(itemList).toContain('of {item.quantity}');
    expect(itemList).toContain('cancelled');
  });
});

// ===========================================================================
//  4 — refunds, and the three states
// ===========================================================================

describe('the refund panel distinguishes agreed from sent', () => {
  it('labels all three states', () => {
    expect(refunds).toContain('PENDING:');
    expect(refunds).toContain('COMPLETED:');
    expect(refunds).toContain('REJECTED:');
  });

  it('shows refundable, owed and returned as separate figures', () => {
    expect(refunds).toContain('Refundable');
    expect(refunds).toContain('>Owed<');
    expect(refunds).toContain('>Returned<');
    // Each rendered from the order's own money view, destructured once above.
    expect(refunds).toContain('formatCurrency(refundable, currency)');
    expect(refunds).toContain('formatCurrency(refundPending, currency)');
    expect(refunds).toContain('formatCurrency(refunded, currency)');
  });

  it('takes every figure from the API rather than summing them', () => {
    // No reduce, no running total: the order already derived these.
    expect(refunds).not.toContain('.reduce(');
    expect(refunds).toContain('const { currency, refundable, refunded, refundPending } = order.money');
  });

  it('bounds a new refund by the refundable figure', () => {
    expect(refunds).toContain("compareAmount(normaliseAmount(typed), refundable) > 0");
    expect(refunds).toContain('disabled={pending || !createUsable}');
  });

  it('refuses to mark a refund sent with no reference', () => {
    expect(refunds).toContain('reference.trim().length === 0');
    expect(refunds).toContain('disabled={pending || reference.trim().length === 0}');
  });

  it('says a pending refund is agreed and not sent', () => {
    expect(refunds).toContain('Agreed, not sent');
  });

  it('says recording one sends nothing', () => {
    expect(refunds).toContain('It does not send anything');
  });

  it('offers the decisions only to somebody who may make them', () => {
    expect(refunds).toContain('canRefund && awaiting');
  });

  it('hides itself when there is nothing owed and nothing recorded', () => {
    expect(refunds).toContain('if (!hasRefunds && !anythingRefundable) return null');
  });
});

// ===========================================================================
//  5 — the payment ledger
// ===========================================================================

describe('the payment history exposes each instalment', () => {
  it('shows the amount, method, reference, note and who took it', () => {
    expect(payments).toContain('payment.amount');
    expect(payments).toContain('PAYMENT_METHOD_LABELS[payment.method]');
    expect(payments).toContain('payment.reference');
    expect(payments).toContain('payment.note');
    expect(payments).toContain('payment.recordedBy.name');
    expect(payments).toContain('payment.recordedAt');
  });

  it('sums nothing — the order already reports what was paid', () => {
    expect(payments).not.toContain('.reduce(');
  });

  it('is rendered from the order, beside the existing summary', () => {
    expect(page).toContain('<PaymentHistory payments={order.payments}');
    expect(page).toContain('<MoneySummary money={order.money} />');
  });
});

describe('recording a payment captures the reference', () => {
  it('asks for the method, the reference and a note', () => {
    expect(bar).toContain('paymentReference');
    expect(bar).toContain('paymentMethod');
    expect(bar).toContain('paymentNote');
  });

  it('sends them with the instalment', () => {
    expect(bar).toContain('...(reference.trim() ? { reference: reference.trim() } : {})');
    expect(bar).toContain('...(method ? { method } : {})');
  });
});

// ===========================================================================
//  6 — action safety against order state
// ===========================================================================

describe('the page offers no action the API would refuse', () => {
  it('treats CLOSED and CANCELLED alike for editing', () => {
    expect(page).toContain("const closed = order.status === 'CLOSED' || order.status === 'CANCELLED'");
    expect(page).toContain('const canEdit = mayEdit && !closed');
    expect(page).toContain('const canCancel = mayEdit && !closed');
  });

  it('keeps refunds available on a cancelled order but not a closed one', () => {
    // Money owed back is settled AFTER the goods are called off; refusing it on
    // a cancelled order would make the workflow impossible to finish.
    expect(page).toContain("const canRefund = mayEdit && order.status !== 'CLOSED'");
  });

  it('gates dispatch and close on the exact status each needs', () => {
    expect(page).toContain("const canDispatch = mayEdit && order.status === 'OPEN'");
    expect(page).toContain("const canClose = mayEdit && order.status === 'DISPATCHED'");
  });

  it('resolves every one of them from the permission matrix, never the role', () => {
    expect(page).toContain("const mayEdit = can(user, 'SALES', 'EDIT')");
    expect(page).not.toContain("user.role === 'ADMIN'");
  });

  it('offers Cancel items only while something is left to cancel', () => {
    expect(bar).toContain('order.items.some((item) => item.remainingQty > 0)');
  });

  it('says who cancelled a cancelled order, and why', () => {
    expect(page).toContain("order.status === 'CANCELLED'");
    expect(page).toContain('order.cancellationReason');
    expect(page).toContain('order.cancelledBy.name');
  });
});

// ===========================================================================
//  7 — one source of truth for money
// ===========================================================================

describe('no screen recomputes the order money', () => {
  it('shows the cancelled value from the API', () => {
    expect(summary).toContain('money.cancelledTotal');
    expect(summary).toContain('money.activeTotal');
  });

  it('keeps the ordered total visible once something is cancelled', () => {
    // `total` still means what was ORDERED, so the order keeps saying what was
    // agreed even after units are called off.
    expect(summary).toContain('Originally ordered');
    expect(summary).toContain('formatCurrency(money.total, money.currency)');
  });

  it('adds no tax or payable arithmetic anywhere in the new screens', () => {
    for (const [name, source] of [
      ['cancel order', cancelOrder],
      ['refund panel', refunds],
      ['payment history', payments],
      ['money summary', summary],
    ] as const) {
      expect(source, `${name} computes tax`).not.toContain('computeSalesTotals');
      expect(source, `${name} computes a split`).not.toContain('taxSplitFor');
    }
  });
});
