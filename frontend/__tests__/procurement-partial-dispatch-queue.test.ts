/**
 * The Procurement decision queue for partial dispatch.
 *
 * The defect this covers: a partial-dispatch request reached Procurement as a
 * notification and nowhere else. There was no endpoint listing pending
 * requests, no Procurement UI fetching one, and the only ALLOW/DISALLOW
 * controls lived on `/dispatch/[id]` — a page behind PACKING_DISPATCH:VIEW,
 * which a procurement reviewer has no reason to hold.
 *
 * These assertions are structural, in the style of the rest of this suite:
 * comments are stripped first, so a test cannot pass on the strength of the
 * prose describing it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = read('app/(app)/procurement/page.tsx');
const queue = read('components/procurement/partial-dispatch-queue.tsx');
const dialog = read('components/dispatch/decide-partial-dialog.tsx');
const panel = read('components/dispatch/partial-dispatch-panel.tsx');
const api = read('lib/procurement-api.ts');

// ---------------------------------------------------------------------------
//  The Procurement page
// ---------------------------------------------------------------------------

describe('the Procurement page', () => {
  it('fetches pending partial-dispatch requests', () => {
    const code = codeOf(page);
    expect(code).toContain('fetchPendingPartialDispatches');
  });

  it('renders the queue', () => {
    expect(codeOf(page)).toContain('<PartialDispatchQueue rows={partialDispatches} />');
  });

  it('fetches and renders it only for somebody who can decide', () => {
    const code = codeOf(page);
    // The same ASSIGN gate the product-change queue uses — not a new one.
    expect(code).toContain('canReview ? fetchPendingPartialDispatches() : Promise.resolve([])');
    expect(code).toContain('{canReview && <PartialDispatchQueue');
    expect(code).toContain("can(access.user, 'PROCUREMENT', 'ASSIGN')");
  });
});

// ---------------------------------------------------------------------------
//  The reader
// ---------------------------------------------------------------------------

describe('the queue reader', () => {
  it('calls the pending endpoint, which needs no order or request id', () => {
    const code = codeOf(api);
    expect(code).toContain("'/api/dispatch/partial-requests/pending'");
  });

  it('returns an empty list on failure rather than breaking the page', () => {
    // One section of a page: a Procurement page that refused to render because
    // this call failed would hide the purchase bills too.
    const code = codeOf(api);
    const fn = code.slice(code.indexOf('fetchPendingPartialDispatches'));
    expect(fn).toContain('result.success ? result.data.requests : []');
  });
});

// ---------------------------------------------------------------------------
//  The queue itself
// ---------------------------------------------------------------------------

describe('a queued request', () => {
  it('shows the order, the customer and who asked', () => {
    const code = codeOf(queue);
    expect(code).toContain('row.orderId');
    expect(code).toContain('row.customerName');
    expect(code).toContain('row.request.requestedBy.name');
  });

  it('shows the deadline and the time left, because it expires', () => {
    const code = codeOf(queue);
    expect(code).toContain('deadlineCountdown');
    expect(code).toContain('row.request.deadline');
    expect(code).toContain('Deadline passed');
  });

  it('shows the quantities the decision turns on', () => {
    const code = codeOf(queue);
    for (const field of ['requiredQty', 'readyQty', 'pendingQty', 'readyLines', 'totalLines']) {
      expect(code).toContain(`row.${field}`);
    }
  });

  it('offers both decisions', () => {
    const code = codeOf(queue);
    expect(code).toContain('Allow partial');
    expect(code).toContain('Disallow');
  });

  it('never shows a requester reason or plan of action — there is none', () => {
    /*
      The requester supplies neither: the question is stated by the order's own
      readiness. Rendering `request.reason` on a PENDING row could only ever
      show null, and would imply the requester was supposed to explain.
    */
    const code = codeOf(queue);
    expect(code).not.toContain('row.request.reason');
    expect(code).not.toContain('row.request.poa');
  });

  it('refetches from the server after a decision, so the row drops out', () => {
    expect(codeOf(queue)).toContain('router.refresh()');
  });
});

// ---------------------------------------------------------------------------
//  The decision dialog — one copy, two modules
// ---------------------------------------------------------------------------

describe('the decision dialog', () => {
  it('is shared rather than duplicated', () => {
    // Two copies would be two places for the reason/POA asymmetry to drift.
    expect(codeOf(queue)).toContain("from '@/components/dispatch/decide-partial-dialog'");
    expect(codeOf(panel)).toContain("from './decide-partial-dialog'");
    expect(codeOf(panel)).not.toContain('function DecideDialog(');
  });

  it('requires a reason either way, and a plan of action only when refusing', () => {
    const code = codeOf(dialog);
    expect(code).toContain("reason.trim() === '' || (refusing && poa.trim() === '')");
  });

  it('labels the plan of action optional when allowing', () => {
    expect(codeOf(dialog)).toContain("Plan of action{refusing ? '' : ' (optional)'}");
  });

  it('goes through the one existing decision action', () => {
    const code = codeOf(dialog);
    expect(code).toContain('decidePartialRequestAction');
    // No second validation path and no direct fetch: the API stays authoritative.
    expect(code).not.toContain('fetch(');
  });

  it('disables the button while the decision is in flight', () => {
    expect(codeOf(dialog)).toContain('disabled={saving || incomplete}');
  });
});

// ---------------------------------------------------------------------------
//  Independence from the Dispatch module
// ---------------------------------------------------------------------------

describe('a procurement reviewer needs no dispatch access', () => {
  it('reaches the queue without any PACKING_DISPATCH capability', () => {
    const code = codeOf(page) + codeOf(queue) + codeOf(api);
    expect(code).not.toContain('PACKING_DISPATCH');
  });

  it('does not send the reviewer to the dispatch order page to decide', () => {
    /*
      That page is guarded by requireModule('PACKING_DISPATCH'), so a link there
      would dead-end a reviewer holding only PROCUREMENT:ASSIGN. Checked as
      navigation rather than as a substring: the queue legitimately *imports*
      the shared dialog from components/dispatch, which is code reuse, not a
      link.
    */
    const code = codeOf(queue);
    expect(code).not.toContain('<Link');
    expect(code).not.toMatch(/href=|router\.push/);
  });
});
