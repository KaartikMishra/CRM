/**
 * Three bugs found by hand, and the reason each one existed.
 *
 *   1. The Product Enquiry Add Customer dialog still offered Indian states to a
 *      customer in Honduras. The rule had been written into the Sales dialog
 *      and not this one — because they were two hand-written copies of the same
 *      two fields. The fix is that there is now one copy, so the first block
 *      below mostly asserts that neither form has its own again.
 *
 *   2. A Gujarat customer previewed as CGST + SGST. The preview called
 *      `taxSplitFor(null, …)` — the seller's State never reached the browser —
 *      so every Indian customer read as intra-state whatever the seller was.
 *
 *   3. An admin opening an order with a pending charge change saw the same
 *      read-only banner the requester saw, and had no way to decide it.
 *
 * The shared rule and the API are what actually enforce any of this; these
 * assert the form behaves the way the API already insists.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taxSplitFor } from '@rs/shared';
import {
  customerStateError,
  customerStateOk,
  stateApplies,
} from '@/components/customers/country-state-fields';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const shared = read('components/customers/country-state-fields.tsx');
const enquiryForm = read('components/product-enquiry/create-enquiry-form.tsx');
const salesForm = read('components/sales/create-sales-order-form.tsx');

// ===========================================================================
//  1 — one copy of the country/state pair, used by both dialogs
// ===========================================================================

describe('the country/state rule is written once', () => {
  it('is used by the Product Enquiry dialog', () => {
    expect(enquiryForm).toContain("from '@/components/customers/country-state-fields'");
    expect(enquiryForm).toContain('<CountryStateFields');
  });

  it('is used by the Sales dialog', () => {
    expect(salesForm).toContain("from '@/components/customers/country-state-fields'");
    expect(salesForm).toContain('<CountryStateFields');
  });

  it('leaves neither form with its own copy of the two Selects', () => {
    // The duplication is what let one of them drift. If a form renders the
    // state list itself again, this bug can come back.
    for (const [name, form] of [
      ['Product Enquiry', enquiryForm],
      ['Sales', salesForm],
    ] as const) {
      expect(form, `${name} renders its own state list`).not.toContain('INDIA_STATES.map');
      expect(form, `${name} renders its own country list`).not.toContain('COUNTRIES.map');
    }
  });

  it('leaves neither form deciding for itself whether a state applies', () => {
    for (const [name, form] of [
      ['Product Enquiry', enquiryForm],
      ['Sales', salesForm],
    ] as const) {
      expect(form, `${name} restates the rule`).toContain(
        'customerStateOk(newCustomerCountry, newCustomerState)',
      );
      expect(form, `${name} restates the message`).toContain(
        'customerStateError(newCustomerCountry)',
      );
    }
  });
});

describe('the shared fields disable and clear the state', () => {
  it('disables the control outside India', () => {
    expect(shared).toContain('disabled={disabled || !applies}');
  });

  it('clears the state when the country leaves India', () => {
    // A disabled Select keeps its value and would still be submitted, which the
    // server refuses — so clearing is what makes "disabled" mean "absent".
    expect(shared).toContain('if (!stateApplies(next)) onStateChange(');
    expect(shared).toMatch(/onStateChange\(''\)/);
  });

  it('says why the control is unavailable rather than just greying it out', () => {
    expect(shared).toContain("'Not applicable'");
    expect(shared).toContain("' (India only)'");
  });
});

describe('the rule itself', () => {
  it('applies within India and nowhere else', () => {
    expect(stateApplies('India')).toBe(true);
    expect(stateApplies('Honduras')).toBe(false);
    expect(stateApplies('Lesotho')).toBe(false);
  });

  it('requires a state within India', () => {
    expect(customerStateOk('India', 'Gujarat')).toBe(true);
    expect(customerStateOk('India', 'Delhi')).toBe(true);
    expect(customerStateOk('India', '')).toBe(false);
  });

  it('refuses one outside India, including the exact pair reported', () => {
    expect(customerStateOk('Honduras', 'Haryana')).toBe(false);
    expect(customerStateOk('Honduras', '')).toBe(true);
  });

  it('refuses a state that is not a State or UT at all', () => {
    expect(customerStateOk('India', 'Pondicherry')).toBe(false);
    expect(customerStateOk('India', 'NotARealState')).toBe(false);
  });

  it('explains which way it failed', () => {
    expect(customerStateError('India')).toBe('Choose a state');
    expect(customerStateError('Honduras')).toContain('only recorded for a customer in India');
  });
});

// ===========================================================================
//  2 — the preview knows the seller's State
// ===========================================================================

describe('the GST preview compares against the real seller state', () => {
  it('takes it as a prop rather than assuming it', () => {
    expect(salesForm).toContain('sellerState: string | null');
    expect(salesForm).toContain('taxSplitFor(sellerState, {');
  });

  it('never calls the rule with a null seller again', () => {
    // This was the bug: `taxSplitFor(null, …)` makes every Indian customer
    // intra-state, so a Gujarat customer showed CGST + SGST whatever the
    // seller was configured as.
    expect(salesForm).not.toContain('taxSplitFor(null');
  });

  it('hard-codes no split anywhere in the form', () => {
    expect(salesForm).not.toContain("split: 'CGST_SGST'");
    expect(salesForm).not.toContain("split: 'IGST'");
  });

  it('reaches the browser from the one server-side source', () => {
    expect(read('app/(app)/sales/new/page.tsx')).toContain(
      '<CreateSalesOrderForm sellerState={user.sellerState} />',
    );
    expect(read('lib/current-user.ts')).toContain('sellerState: string | null');
  });
});

describe('the split itself, against a configured seller', () => {
  const SELLER = 'Delhi';

  it('is CGST + SGST within the seller own state', () => {
    expect(taxSplitFor(SELLER, { state: 'Delhi', country: 'India' })).toBe('CGST_SGST');
  });

  it('is IGST for another state — the case that was reported wrong', () => {
    expect(taxSplitFor(SELLER, { state: 'Gujarat', country: 'India' })).toBe('IGST');
    expect(taxSplitFor(SELLER, { state: 'Maharashtra', country: 'India' })).toBe('IGST');
  });

  it('is no Indian head at all outside India', () => {
    expect(taxSplitFor(SELLER, { state: null, country: 'Honduras' })).toBe('NONE');
  });

  it('matches case-insensitively, both ways', () => {
    expect(taxSplitFor('delhi', { state: 'Delhi', country: 'india' })).toBe('CGST_SGST');
  });

  it('falls back to intra-state when the seller is unconfigured', () => {
    // The current production state, and the whole reason a Gujarat customer
    // still shows CGST + SGST: nothing to compare against.
    expect(taxSplitFor(null, { state: 'Gujarat', country: 'India' })).toBe('CGST_SGST');
  });

  it('leaves a customer with no country recorded reading as domestic', () => {
    expect(taxSplitFor(SELLER, { state: 'Gujarat', country: null })).toBe('IGST');
    expect(taxSplitFor(SELLER, { state: 'Delhi', country: null })).toBe('CGST_SGST');
  });
});

// ===========================================================================
//  3 — an approver can actually approve
// ===========================================================================

describe('a pending charge change can be decided from the order', () => {
  const review = read('components/sales/charge-change-review.tsx');
  const actions = read('app/(app)/sales/actions.ts');

  it('offers both decisions', () => {
    expect(review).toContain('Approve');
    expect(review).toContain('Reject');
  });

  it('calls the endpoints that already existed', () => {
    expect(actions).toContain('/charge-requests/${requestId}/approve');
    expect(actions).toContain('/charge-requests/${requestId}/reject');
  });

  it('offers them only to a reviewer, and never on their own request', () => {
    expect(review).toContain('const mayDecide = canReview && awaiting && !isOwnRequest');
    expect(review).toContain('request.requestedBy.id === currentUserId');
  });

  it('offers nothing on a request already decided', () => {
    expect(review).toContain("const awaiting = request.status === 'PENDING'");
  });

  it('mirrors the item change-request card rather than inventing a second one', () => {
    const items = read('components/sales/sales-item-list.tsx');
    for (const shared of ['STATUS_VARIANT', 'mayDecide', 'busyId', 'startTransition']) {
      expect(review, `${shared} should follow the established pattern`).toContain(shared);
      expect(items).toContain(shared);
    }
  });

  it('still says the charges in force are unchanged while it waits', () => {
    expect(review).toContain('The order charges what is shown above until this is approved.');
  });
});
