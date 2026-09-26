/**
 * Payment method, and what the charges editor promises.
 *
 * Both are UX only — the API decides in both cases — so these assert the
 * contract the form is written against rather than the enforcement, which is
 * covered end to end on the backend. What makes them worth having is that a
 * form which asks for the wrong thing sends the wrong thing: a method offered
 * on an order with nothing paid produces a value that says something untrue,
 * and an editor that says "updated" when the API filed a request for approval
 * tells somebody their money moved when it did not.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  createSalesOrderSchema,
  recordPaymentSchema,
} from '@rs/shared';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const form = read('components/sales/create-sales-order-form.tsx');
const dialog = read('components/sales/edit-charges-dialog.tsx');

const CUID = 'clx0000000000000000000000';

const order = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderId: '#1001',
  customerId: CUID,
  items: [{ productName: 'Brass lamp', quantity: 1, price: '1000.00', gstMode: 'EXCLUSIVE' }],
  charges: [],
  paidAmount: '0',
  orderDate: '2026-09-25T00:00:00.000Z',
  toBeDispatchedBy: '2026-09-30T00:00:00.000Z',
  ...overrides,
});

// ===========================================================================
//  A — the three methods, and when one is asked for
// ===========================================================================

describe('payment method', () => {
  it('offers exactly the three the business uses', () => {
    expect([...PAYMENT_METHODS]).toEqual(['PREPAID', 'COD', 'PARTIAL_COD']);
  });

  it('labels every one of them, so no raw enum value reaches a screen', () => {
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_LABELS[method], method).toBeTruthy();
      expect(PAYMENT_METHOD_LABELS[method]).not.toBe(method);
    }
  });

  it('is not required on an order that has taken no payment', () => {
    expect(createSalesOrderSchema.safeParse(order()).success).toBe(true);
  });

  it('is required once an amount is paid', () => {
    const result = createSalesOrderSchema.safeParse(order({ paidAmount: '500.00' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('paymentMethod'))).toBe(true);
    }
  });

  it('accepts a paid order that states one', () => {
    const result = createSalesOrderSchema.safeParse(
      order({ paidAmount: '500.00', paymentMethod: 'PARTIAL_COD' }),
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('refuses a method outside the list', () => {
    expect(
      createSalesOrderSchema.safeParse(
        order({ paidAmount: '500.00', paymentMethod: 'BANK_TRANSFER' }),
      ).success,
    ).toBe(false);
  });

  it('accepts a payment that states one, and one that leaves it unchanged', () => {
    /*
      Optional on the wire deliberately. The form always sends one, but making
      it required there would change who sees which error: validation runs
      before authorization, so a caller with no right to the order would get 422
      instead of 403. Omitted means the order keeps the arrangement it had.
    */
    expect(recordPaymentSchema.safeParse({ amount: '100.00' }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ amount: '100.00', method: 'COD' }).success).toBe(true);
    expect(recordPaymentSchema.safeParse({ amount: '100.00', method: 'CHEQUE' }).success).toBe(
      false,
    );
  });

  it('leaves the payment amount rules exactly as they were', () => {
    // A method is not a licence to pay more, or to pay nothing.
    expect(recordPaymentSchema.safeParse({ amount: '0.00', method: 'COD' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: '-5.00', method: 'COD' }).success).toBe(false);
  });
});

describe('the create form asks for a method only where one applies', () => {
  it('derives that from the amount rather than tracking it separately', () => {
    expect(form).toContain('const paymentEntered =');
    expect(form).toContain("compareAmount(paidAmount.trim(), '0.00') > 0");
  });

  it('disables the control until an amount is entered', () => {
    expect(form).toContain('disabled={!paymentEntered}');
  });

  it('clears the method when the amount is cleared', () => {
    // A disabled Select keeps its value, and submitting one for an unpaid order
    // would state an arrangement that does not exist.
    expect(form).toContain("if (e.target.value.trim() === '') setPaymentMethod('')");
  });

  it('omits it from the payload rather than sending an empty string', () => {
    expect(form).toContain('...(paymentMethod ? { paymentMethod } : {})');
  });

  it('builds the options from the shared list', () => {
    expect(form).toContain('PAYMENT_METHODS.map');
    expect(form).toContain('PAYMENT_METHOD_LABELS[method]');
  });
});

// ===========================================================================
//  B — the charges editor says what it will actually do
// ===========================================================================

describe('editing existing charges is described as a request, not a change', () => {
  it('takes whether approval applies from the caller, not from a guess', () => {
    expect(dialog).toContain('needsApproval = false');
    expect(dialog).toContain('needsApproval?: boolean');
  });

  it('does not claim the charges were updated when they were only proposed', () => {
    expect(dialog).toContain('Sent for approval');
    expect(dialog).toMatch(/needsApproval\s*\?\s*'Sent for approval/);
  });

  it('says so before the button is pressed too', () => {
    expect(dialog).toContain('a change is sent for approval rather than applied');
  });

  it('refuses a second proposal while one is waiting', () => {
    // The API refuses it; the button should not invite it.
    expect(dialog).toContain('pending?: boolean');
    expect(dialog).toContain('disabled={pendingSave || belowPaid || pending}');
  });

  it('still refuses to propose a set below what is already paid', () => {
    // The pre-existing guard, unchanged by any of this.
    expect(dialog).toContain('const belowPaid =');
  });
});

describe('the detail page shows a pending change without letting it move money', () => {
  const page = read('app/(app)/sales/[id]/page.tsx');

  it('finds the one pending request, if there is one', () => {
    expect(page).toContain('const pendingChargeChange =');
    expect(page).toContain("request.status === 'PENDING'");
  });

  it('hands the requests to the component that can also decide them', () => {
    /*
      This was a read-only banner rendered inline. An approver opening the order
      saw exactly what the requester saw and was offered nothing to do about it,
      so a pending change could only be decided by calling the API by hand. The
      banner's job — saying the figures shown are still in force — moved into
      the component along with the buttons.
    */
    expect(page).toContain('<ChargeChangeReview');
    expect(page).toContain('requests={order.chargeChangeRequests}');
  });

  it('resolves who may decide on the server, not in the browser', () => {
    expect(page).toContain('canReview={canReview}');
    expect(page).toContain('currentUserId={user.id}');
  });

  it('still says the figures shown are the ones in force', () => {
    const review = read('components/sales/charge-change-review.tsx');
    expect(review).toContain('The order charges what is shown above until this is approved.');
  });

  it('shows both sides, so an approver can see what would replace what', () => {
    const review = read('components/sales/charge-change-review.tsx');
    expect(review).toContain('request.currentTotal');
    expect(review).toContain('request.proposedTotal');
  });
});
