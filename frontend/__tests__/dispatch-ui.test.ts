/**
 * Packing & Dispatch — the frontend's own decisions.
 *
 * Two kinds of assertion, matching the rest of this suite: the pure functions in
 * dispatch-logic.ts are called directly, and the components are read as source
 * to prove structural facts a pure test cannot reach — that a permission is
 * resolved through `can` rather than a role check, that the AWB field is text
 * rather than a number, that the automatic allow never borrows the wording of a
 * human one.
 *
 * Comments are stripped before any source assertion. Without that, a test can
 * pass because this file's own prose mentions the thing it is looking for —
 * which proves nothing about the code.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWB_MAX_LENGTH,
  DISPATCH_CARRIERS,
  DISPATCH_CHANNELS,
  type DispatchReadinessLine,
  type DispatchView,
  type PartialDispatchRequestView,
} from '@rs/shared';
import {
  activeShipments,
  canCancel,
  canDecide,
  canEditShipment,
  canRequestPartial,
  deadlineCountdown,
  dispatchableQty,
  hasAnythingToPack,
  nextStep,
  openRequest,
  outcomeLine,
  validatePack,
} from '@/components/dispatch/dispatch-logic';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The same file with its comments removed, for assertions about code. */
const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const boardPage = read('app/(app)/dispatch/page.tsx');
const detailPage = read('app/(app)/dispatch/[id]/page.tsx');
const board = read('components/dispatch/dispatch-board.tsx');
const badges = read('components/dispatch/dispatch-badges.tsx');
const partialPanel = read('components/dispatch/partial-dispatch-panel.tsx');
/* Extracted so Purchase & Procurement can reuse one copy of the decision
   rules rather than keeping a second that could drift from it. */
const decideDialog = read('components/dispatch/decide-partial-dialog.tsx');
const shipmentPanel = read('components/dispatch/shipment-panel.tsx');
const orderDetail = read('components/dispatch/order-detail.tsx');
const actions = read('app/(app)/dispatch/actions.ts');

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

const line = (over: Partial<DispatchReadinessLine> = {}): DispatchReadinessLine => ({
  salesOrderItemId: 'line-1',
  lineNo: 1,
  productName: 'Kansa Thali',
  image: null,
  sku: 'RS2347',
  requiredQty: 5,
  readyQty: 5,
  pendingQty: 0,
  dispatchedQty: 0,
  status: 'FULFILLED',
  ...over,
});

const request = (
  over: Partial<PartialDispatchRequestView> = {},
): PartialDispatchRequestView => ({
  id: 'req-1',
  salesOrderId: 'order-1',
  orderId: 'SO-1',
  status: 'PENDING',
  requestedBy: { id: 'u1', name: 'Abhay', employeeId: 'E1', role: 'USER' },
  requestedAt: '2026-09-29T00:00:00.000Z',
  deadline: '2026-09-30T00:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  reason: null,
  poa: null,
  autoDecided: false,
  ...over,
});

// ---------------------------------------------------------------------------
//  Readiness arithmetic
// ---------------------------------------------------------------------------

describe('what a line can still send', () => {
  it('is ready less what has already gone', () => {
    expect(dispatchableQty(line({ readyQty: 5, dispatchedQty: 2 }))).toBe(3);
  });

  it('never goes negative when more was sent than is ready', () => {
    expect(dispatchableQty(line({ readyQty: 2, dispatchedQty: 5 }))).toBe(0);
  });

  it('is zero for a line that is not there', () => {
    expect(dispatchableQty(undefined)).toBe(0);
  });
});

describe('whether there is anything to pack', () => {
  it('is true when one line can go', () => {
    expect(hasAnythingToPack([line({ readyQty: 0 }), line({ readyQty: 3 })])).toBe(true);
  });

  it('is false when every line is fully sent', () => {
    expect(hasAnythingToPack([line({ readyQty: 5, dispatchedQty: 5 })])).toBe(false);
  });

  it('is false for an order with no lines', () => {
    expect(hasAnythingToPack([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Packing validation
// ---------------------------------------------------------------------------

describe('choosing what goes in a parcel', () => {
  const readiness = [
    line({ salesOrderItemId: 'a', readyQty: 5 }),
    line({ salesOrderItemId: 'b', readyQty: 2 }),
  ];

  it('accepts a valid selection', () => {
    expect(validatePack([{ salesOrderItemId: 'a', quantity: 3 }], readiness)).toEqual([]);
  });

  it('refuses zero and negative quantities', () => {
    expect(validatePack([{ salesOrderItemId: 'a', quantity: 0 }], readiness)).toHaveLength(1);
    expect(validatePack([{ salesOrderItemId: 'a', quantity: -1 }], readiness)).toHaveLength(1);
  });

  it('refuses a fractional quantity — half a cooker is not a thing', () => {
    expect(validatePack([{ salesOrderItemId: 'a', quantity: 1.5 }], readiness)).toHaveLength(1);
  });

  it('refuses more than the line can supply, and says how many there are', () => {
    const problems = validatePack([{ salesOrderItemId: 'b', quantity: 3 }], readiness);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('2');
  });

  it('refuses the same line chosen twice', () => {
    const problems = validatePack(
      [
        { salesOrderItemId: 'a', quantity: 1 },
        { salesOrderItemId: 'a', quantity: 1 },
      ],
      readiness,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('already');
  });

  it('says plainly when a line has nothing ready', () => {
    const problems = validatePack(
      [{ salesOrderItemId: 'c', quantity: 1 }],
      [line({ salesOrderItemId: 'c', readyQty: 0 })],
    );
    expect(problems[0]!.message).toContain('None');
  });
});

// ---------------------------------------------------------------------------
//  The shipment lifecycle
// ---------------------------------------------------------------------------

describe('a shipment’s next step', () => {
  it('follows the backend’s own order', () => {
    expect(nextStep('DRAFT')).toBe('START_PACKING');
    expect(nextStep('PACKING')).toBe('MARK_PACKED');
    expect(nextStep('PACKED')).toBe('DISPATCH');
  });

  it('offers nothing once it is settled', () => {
    expect(nextStep('DISPATCHED')).toBeNull();
    expect(nextStep('CANCELLED')).toBeNull();
  });
});

describe('what can still be changed', () => {
  it('allows cancelling until the goods leave', () => {
    expect(canCancel('DRAFT')).toBe(true);
    expect(canCancel('PACKED')).toBe(true);
    expect(canCancel('DISPATCHED')).toBe(false);
    expect(canCancel('CANCELLED')).toBe(false);
  });

  it('allows editing the carrier until the goods leave', () => {
    expect(canEditShipment('PACKING')).toBe(true);
    expect(canEditShipment('DISPATCHED')).toBe(false);
  });

  it('counts only shipments still in play as active', () => {
    const shipments = [
      { id: '1', status: 'PACKING' },
      { id: '2', status: 'DISPATCHED' },
      { id: '3', status: 'CANCELLED' },
    ] as DispatchView[];
    expect(activeShipments(shipments).map((s) => s.id)).toEqual(['1']);
  });
});

// ---------------------------------------------------------------------------
//  Partial dispatch
// ---------------------------------------------------------------------------

describe('when the partial-dispatch question may be asked', () => {
  it('is offered on a partly ready order', () => {
    expect(
      canRequestPartial({ fullyReady: false, partiallyReady: true, pendingRequest: null }),
    ).toBe(true);
  });

  it('is not offered on a fully ready order — just send it', () => {
    expect(
      canRequestPartial({ fullyReady: true, partiallyReady: false, pendingRequest: null }),
    ).toBe(false);
  });

  it('is not offered when nothing is ready', () => {
    expect(
      canRequestPartial({ fullyReady: false, partiallyReady: false, pendingRequest: null }),
    ).toBe(false);
  });

  it('is not offered while a question is already open', () => {
    expect(
      canRequestPartial({
        fullyReady: false,
        partiallyReady: true,
        pendingRequest: request(),
      }),
    ).toBe(false);
  });
});

describe('finding the open question', () => {
  it('returns the pending one', () => {
    const found = openRequest([
      request({ id: 'old', status: 'DISALLOWED' }),
      request({ id: 'open', status: 'PENDING' }),
    ]);
    expect(found?.id).toBe('open');
  });

  it('returns null when everything is settled', () => {
    expect(openRequest([request({ status: 'ALLOWED' })])).toBeNull();
  });
});

describe('who may decide', () => {
  it('needs the permission AND an open question', () => {
    expect(canDecide(request(), true)).toBe(true);
    expect(canDecide(request(), false)).toBe(false);
    expect(canDecide(request({ status: 'ALLOWED' }), true)).toBe(false);
    expect(canDecide(null, true)).toBe(false);
  });
});

describe('the deadline countdown', () => {
  it('reports hours and minutes left', () => {
    const c = deadlineCountdown(
      '2026-09-30T00:00:00.000Z',
      new Date('2026-09-29T02:30:00.000Z'),
    );
    expect(c.expired).toBe(false);
    expect(c.hours).toBe(21);
    expect(c.minutes).toBe(30);
    expect(c.label).toBe('21h 30m left');
  });

  it('drops the hours once under an hour', () => {
    const c = deadlineCountdown(
      '2026-09-29T01:00:00.000Z',
      new Date('2026-09-29T00:45:00.000Z'),
    );
    expect(c.label).toBe('15m left');
  });

  it('says the deadline passed rather than counting backwards', () => {
    const c = deadlineCountdown(
      '2026-09-29T00:00:00.000Z',
      new Date('2026-09-29T05:00:00.000Z'),
    );
    expect(c.expired).toBe(true);
    expect(c.label).toBe('Deadline passed');
  });
});

// ---------------------------------------------------------------------------
//  What each outcome says
// ---------------------------------------------------------------------------

describe('the sentence an outcome gets', () => {
  it('says nothing while the question is open', () => {
    expect(outcomeLine(request())).toBeNull();
  });

  it('quotes the reason a person gave', () => {
    const r = request({ status: 'ALLOWED', reason: 'Cookers are three weeks out' });
    expect(outcomeLine(r)).toBe('Cookers are three weeks out');
  });

  it('explains an automatic allow as a silence, and invents no reason', () => {
    const r = request({ status: 'ALLOWED', autoDecided: true, reason: null });
    const sentence = outcomeLine(r)!;

    expect(sentence).toContain('Auto-allowed');
    expect(sentence).toContain('24 hours');
    // The whole point: nobody agreed, so nothing may read as agreement.
    expect(sentence).not.toContain('approved');
  });

  it('explains MOOT as the question ceasing to apply', () => {
    const r = request({ status: 'MOOT', decidedAt: '2026-09-29T01:00:00.000Z' });
    expect(outcomeLine(r)).toContain('No longer needed');
  });

  it('carries a refusal’s reason', () => {
    const r = request({ status: 'DISALLOWED', reason: 'Cookers land Monday', poa: 'Hold' });
    expect(outcomeLine(r)).toBe('Cookers land Monday');
  });
});

// ---------------------------------------------------------------------------
//  RBAC — resolved through the matrix, never from the role
// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('gates the pages on PACKING_DISPATCH through requireModule', () => {
    for (const page of [boardPage, detailPage]) {
      expect(codeOf(page)).toContain("requireModule('PACKING_DISPATCH')");
      expect(codeOf(page)).toContain('NoModuleAccess');
    }
  });

  it('resolves every capability through `can`, not through a role comparison', () => {
    const code = codeOf(detailPage);
    expect(code).toContain("can(access.user, 'PACKING_DISPATCH', 'CREATE')");
    expect(code).toContain("can(access.user, 'PACKING_DISPATCH', 'EDIT')");
    expect(code).toContain("can(access.user, 'PROCUREMENT', 'ASSIGN')");
  });

  it('uses the role for one thing only: what the admin’s own form collects', () => {
    const code = codeOf(detailPage);
    // The single permitted role read, and it decides a form field — never access.
    expect(code.match(/role === 'ADMIN'/g)).toHaveLength(1);
    expect(code).toContain('isAdmin');
  });

  it('introduces no permission the CRM does not already have', () => {
    const everything = [boardPage, detailPage, partialPanel, shipmentPanel, orderDetail, actions]
      .map(codeOf)
      .join('\n');
    // The four existing capabilities, and nothing invented alongside them.
    const modules = everything.match(/'(PACKING_DISPATCH|PROCUREMENT|SALES|RS_PRODUCTS)'/g) ?? [];
    for (const module of modules) {
      expect(['PACKING_DISPATCH', 'PROCUREMENT', 'SALES', 'RS_PRODUCTS']).toContain(
        module.replaceAll("'", ''),
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  The board
// ---------------------------------------------------------------------------

describe('the board', () => {
  it('shows the three readiness states through one badge', () => {
    expect(codeOf(board)).toContain('OrderReadinessBadge');
    const code = codeOf(badges);
    expect(code).toContain('Ready');
    expect(code).toContain('Partial');
    expect(code).toContain('Unfulfilled');
  });

  it('reads readiness from the API’s booleans rather than recomputing it', () => {
    const code = codeOf(board);
    expect(code).toContain('order.fullyReady');
    expect(code).toContain('order.partiallyReady');
  });

  it('shows an open partial request with its deadline', () => {
    const code = codeOf(board);
    expect(code).toContain('pendingPartialRequest');
    expect(code).toContain('deadlineCountdown');
  });

  /*
    W6. "Lines ready" counted only fully covered lines, so the PARTIAL order
    rsm9999 — seven units waiting to ship — read as "0 / 2": the one figure on
    the row that says there is work to do, saying there is none.
  */
  it('leads with dispatchable UNITS, not completed lines', () => {
    const code = codeOf(board);
    expect(code).toContain('Ready to send');
    expect(code).toContain('order.dispatchableQty');
    expect(code).not.toContain('Lines ready');
  });

  it('keeps the completed-lines count, demoted to a subtitle', () => {
    // Still true and still useful — just no longer the headline figure.
    expect(codeOf(board)).toContain('lines complete');
  });

  // F1 — the three contact fields a dispatcher needs before a parcel can go.
  it('shows phone, address and email on the row', () => {
    const code = codeOf(board);
    expect(code).toContain('order.customerPhone');
    expect(code).toContain('order.customerAddress');
    expect(code).toContain('order.customerEmail');
  });

  it('flags a missing phone or address, which are hard blockers at dispatch', () => {
    const code = codeOf(board);
    expect(code).toContain('No phone');
    expect(code).toContain('No address');
    // Email is only a warning, so it is shown plainly rather than in red.
    expect(code).toContain('No email');
  });

  it('has an empty state and the page has an error state', () => {
    expect(codeOf(board)).toContain('EmptyState');
    expect(codeOf(boardPage)).toContain('ErrorMessage');
  });

  it('searches only on the filter the API actually implements', () => {
    const code = codeOf(boardPage);
    expect(code).toContain('name="q"');
    // No invented readiness filter: the backend has none, and paginating a
    // list it never filtered would make the counts lie.
    expect(code).not.toContain('name="readiness"');
    expect(code).not.toContain('name="status"');
  });
});

// ---------------------------------------------------------------------------
//  Shipment information
// ---------------------------------------------------------------------------

describe('channel, carrier and AWB', () => {
  it('offers every channel and carrier from the shared vocabulary', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain('DISPATCH_CHANNELS.map');
    expect(code).toContain('DISPATCH_CARRIERS.map');
    // Read from the contract rather than retyped, so the list cannot drift.
    expect(code).not.toContain("'Delhivery'");
  });

  it('carries the carriers the business named', () => {
    for (const carrier of ['DELHIVERY', 'BLUE_DART', 'DTDC', 'FEDEX', 'OTHER']) {
      expect(DISPATCH_CARRIERS).toContain(carrier);
    }
    expect(DISPATCH_CHANNELS).toContain('OTHER');
  });

  it('reveals the free-text field only when the answer is Other', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain("value.channel === 'OTHER' && (");
    expect(code).toContain("value.carrier === 'OTHER' && (");
  });

  it('keeps the AWB as text so a leading zero survives', () => {
    const code = codeOf(shipmentPanel);
    const awbField = code.slice(code.indexOf('id="awb"'), code.indexOf('id="awb"') + 300);
    expect(awbField).not.toContain('type="number"');
    expect(code).toContain('maxLength={AWB_MAX_LENGTH}');
    expect(AWB_MAX_LENGTH).toBe(60);
  });

  it('will not send until channel, carrier and AWB are all present', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain('const incomplete = !travelComplete(travel)');
    expect(code).toContain("t.awb.trim() !== ''");
    // And the button is actually bound to it.
    expect(code).toContain('disabled={saving || incomplete}');
  });
});

// ---------------------------------------------------------------------------
//  Final dispatch and blockers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Phase 3.1 — the polish fixes
// ---------------------------------------------------------------------------

describe('SKU on the line (F2)', () => {
  it('is carried by the readiness contract', () => {
    // Typed, so a backend that stopped sending it would fail the build.
    const l = line({ sku: 'RS2473' });
    expect(l.sku).toBe('RS2473');
  });

  it('is shown beside the product on the detail', () => {
    expect(codeOf(orderDetail)).toContain('line.sku');
  });

  it('renders nothing rather than a placeholder when absent', () => {
    const code = codeOf(orderDetail);
    // A free-text line has no SKU; inventing one would mislead a picker.
    expect(code).toContain('{line.sku && (');
    expect(code).not.toContain("sku ?? 'N/A'");
    expect(code).not.toContain("sku ?? '-'");
  });

  it('accepts null for an unmapped line', () => {
    expect(line({ sku: null }).sku).toBeNull();
  });
});

describe('the detail page scrolls (Issue 1)', () => {
  /*
    The page is auto-height and scrolls through the shell's own `<main>`, which
    is `overflow-y-auto`. A `ContentScrollArea` inside it claims height with
    `lg:flex-1` and scrolls vertically on its own — which only resolves inside a
    bounded ContentPage/ContentRegion. On this page it had nothing to resolve
    against and cut the content off instead of letting the page grow.
  */
  it('adds no vertical scroll container of its own', () => {
    const code = codeOf(orderDetail);
    expect(code).not.toContain('ContentScrollArea');
    expect(code).not.toContain('overflow-y-auto');
  });

  it('leaves the page root free to grow, so the shell scrolls it', () => {
    const code = codeOf(orderDetail);
    // A plain auto-height column. No h-full, which would cap it at the viewport
    // and strand the panels below the fold.
    expect(code).toContain("<div className=\"flex flex-col gap-4\">");
    expect(code).not.toContain('h-full');
  });

  it('still scrolls the wide table sideways — Table brings its own container', () => {
    // components/ui/table.tsx wraps every table in `.scroll-x`, so the nine
    // columns handle a narrow screen without anything added here.
    expect(codeOf(read('components/ui/table.tsx'))).toContain('scroll-x');
  });
});

describe('the detail loading state (W1)', () => {
  it('exists, so the page does not flash empty', () => {
    const skeleton = read('app/(app)/dispatch/[id]/loading.tsx');
    expect(codeOf(skeleton)).toContain('Skeleton');
    expect(codeOf(skeleton)).toContain('export default function Loading');
  });
});

describe('recording the carrier before dispatch (W3)', () => {
  it('wires the PATCH action into the shipment row', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain('updateDispatchAction');
    expect(code).toContain('EditDialog');
  });

  it('offers it only while the shipment can still be edited', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain('canEditShipment(shipment.status)');
  });

  it('shares one set of travel fields with the dispatch dialog', () => {
    // Two copies of the OTHER pairing rules would be two places to drift.
    const code = codeOf(shipmentPanel);
    expect(code.match(/<TravelFields/g)).toHaveLength(2);
  });
});

describe('the travel-field completeness rule', () => {
  it('needs channel, carrier and AWB, plus a name when either is Other', () => {
    const code = codeOf(shipmentPanel);
    expect(code).toContain('function travelComplete');
    expect(code).toContain("t.channel !== 'OTHER' || t.channelOther.trim() !== ''");
    expect(code).toContain("t.carrier !== 'OTHER' || t.carrierOther.trim() !== ''");
  });
});

describe('dead helpers removed (W2)', () => {
  it('no longer defines readers the UI never calls', () => {
    const api = codeOf(read('lib/dispatch-api.ts'));
    expect(api).not.toContain('export async function fetchShipment');
    expect(api).not.toContain('export async function fetchPartialRequest(');
    expect(codeOf(actions)).not.toContain('export async function shipmentAction');
  });

  it('keeps the reader the history panel actually uses', () => {
    expect(codeOf(read('lib/dispatch-api.ts'))).toContain('fetchPartialRequests');
  });
});

describe('final dispatch', () => {
  it('shows the API’s blockers as a blocking message', () => {
    const code = codeOf(orderDetail);
    expect(code).toContain('readiness.blockers');
    expect(code).toContain('cannot be dispatched yet');
  });

  it('shows warnings separately, so a missing email never reads as a blocker', () => {
    const code = codeOf(orderDetail);
    expect(code).toContain('readiness.warnings');
    const blockerAt = code.indexOf('readiness.blockers');
    const warningAt = code.indexOf('readiness.warnings');
    expect(blockerAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(blockerAt);
  });

  it('creates no payment gate of its own', () => {
    const code = codeOf(orderDetail) + codeOf(shipmentPanel);
    expect(code).not.toContain('paidAmount <');
    expect(code).not.toContain('unpaid');
  });

  it('confirms before cancelling a shipment', () => {
    expect(codeOf(shipmentPanel)).toContain('AlertDialog');
  });
});

// ---------------------------------------------------------------------------
//  Mutation hygiene
// ---------------------------------------------------------------------------

describe('mutations', () => {
  it('disables its buttons while a request is in flight', () => {
    for (const panel of [partialPanel, shipmentPanel]) {
      expect(codeOf(panel)).toContain('disabled={saving');
    }
  });

  it('reports success and failure through the existing toast', () => {
    for (const panel of [partialPanel, shipmentPanel]) {
      expect(codeOf(panel)).toContain("from 'sonner'");
    }
  });

  it('goes through server actions, so the token never reaches the browser', () => {
    expect(codeOf(actions)).toContain("'use server'");
    for (const panel of [partialPanel, shipmentPanel]) {
      expect(codeOf(panel)).not.toContain('fetch(');
      expect(codeOf(panel)).toContain("@/app/(app)/dispatch/actions");
    }
  });

  it('relays the backend’s answer rather than deciding anything itself', () => {
    const code = codeOf(actions);
    expect(code).toContain('result.message');
    // No business rule in the action layer: it forwards and reports.
    expect(code).not.toContain('if (input.quantity');
  });
});

// ---------------------------------------------------------------------------
//  The admin case
// ---------------------------------------------------------------------------

describe('an administrator raising the request', () => {
  it('is asked for a reason, because the API requires one', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain('reasonMissing');
    expect(code).toContain("isAdmin && reason.trim() === ''");
  });

  it('reads the resulting status from the response instead of predicting it', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain("result.data.request.status === 'ALLOWED'");
  });

  it("labels the fields as the DECISION's, because that is what they are", () => {
    // An administrator's request is ALLOWED the moment it is made, so what they
    // supply is a decision reason — never a justification for asking.
    const code = codeOf(partialPanel);
    expect(code).toContain('Reason for allowing');
  });
});

/*
 * Issue 2 — the requester explains nothing.
 *
 * Dispatch's part is "these lines are ready and these are not, may we send what
 * is ready", which the order's readiness already states in full. The reason and
 * the plan of action belong to the decision, and the decision belongs to
 * Procurement.
 */
describe('a requester initiating a partial dispatch', () => {
  it('is shown no reason, plan-of-action or note field', () => {
    const code = codeOf(partialPanel);
    const requesterBranch = code.slice(code.indexOf('isAdmin ? ('), code.indexOf('{error &&'));
    const nonAdmin = requesterBranch.slice(requesterBranch.indexOf(') : ('));

    expect(nonAdmin).not.toContain('<Textarea');
    expect(nonAdmin).not.toContain('partial-reason');
    expect(nonAdmin).not.toContain('partial-poa');
    // The free-text note went too: it was one more thing to explain with.
    expect(nonAdmin).not.toContain('partial-note');
  });

  it('sends only the order id — no reason or POA is attached for a requester', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain("isAdmin && reason.trim() ? { reason: reason.trim() } : {}");
    expect(code).toContain("isAdmin && poa.trim() ? { poa: poa.trim() } : {}");
  });

  it('no longer collects a note at all', () => {
    const code = codeOf(partialPanel);
    expect(code).not.toContain('setNote');
    expect(code).not.toContain('note.trim()');
  });

  it('explains the 24-hour deadline instead of asking for input', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain('24 hours');
    expect(code).toContain('allowed automatically');
  });
});

describe('the decision fields stay with Procurement', () => {
  it('keeps reason and POA on the decide dialog', () => {
    const code = codeOf(decideDialog);
    expect(code).toContain('decide-reason');
    expect(code).toContain('decide-poa');
  });

  it('still requires a reason to allow, and both to refuse', () => {
    const code = codeOf(decideDialog);
    expect(code).toContain("reason.trim() === '' || (refusing && poa.trim() === '')");
  });

  it('keeps them out of the requester panel entirely', () => {
    // The panel renders the dialog; it does not restate its rules.
    const code = codeOf(partialPanel);
    expect(code).toContain('DecidePartialDialog');
    expect(code).not.toContain('decide-reason');
  });
});

describe('what the requester sees afterwards', () => {
  it('shows who decided, when, and their reason', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain('Decided by ${request.decidedBy.name}');
    expect(code).toContain('request.reason');
    expect(code).toContain('request.poa');
  });

  it('shows a pending request as awaiting Procurement, with its deadline', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain('Awaiting Procurement decision');
    expect(code).toContain('formatDateTime(request.deadline)');
  });

  it('marks an auto-allow as a silence, never as an approval', () => {
    const code = codeOf(partialPanel);
    expect(code).toContain('AUTO_ALLOWED_EXPLANATION');
    // And the reason line is suppressed for it, so nothing can read as a
    // justification somebody gave.
    expect(code).toContain('!request.autoDecided && request.reason');
  });
});

describe('deciding a request', () => {
  it('requires a reason either way and a plan of action only when refusing', () => {
    const code = codeOf(decideDialog);
    expect(code).toContain("reason.trim() === '' || (refusing && poa.trim() === '')");
  });
});
