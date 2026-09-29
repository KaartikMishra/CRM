/**
 * Dispatch readiness, as pure arithmetic.
 *
 * No database and no HTTP: these are the functions the board and the detail
 * page both read through, and the point of testing them alone is that the rules
 * they encode are business rules, not plumbing.
 *
 * The two cases from the brief are asserted by name below — five thalis and two
 * cookers, fully and partially procured — because they are the shapes the
 * feature exists to tell apart.
 */

import { describe, expect, it } from 'vitest';
import {
  customerDispatchChecks,
  lineReadiness,
  orderFullyDispatched,
  orderFullyReady,
  orderNothingReady,
  orderPartiallyReady,
  type LineReadiness,
} from '../dispatch.calc.js';

const line = (over: Partial<Parameters<typeof lineReadiness>[0]> = {}) =>
  lineReadiness({
    quantity: 5,
    cancelledQty: 0,
    alreadyFulfilled: 0,
    allocations: [],
    dispatchedQty: 0,
    ...over,
  });

// ---------------------------------------------------------------------------
//  One line
// ---------------------------------------------------------------------------

describe('a line that is fully procured', () => {
  it('is FULFILLED and entirely dispatchable', () => {
    const r = line({ allocations: [{ quantity: 5 }] });
    expect(r.requiredQty).toBe(5);
    expect(r.readyQty).toBe(5);
    expect(r.pendingQty).toBe(0);
    expect(r.dispatchableQty).toBe(5);
    expect(r.status).toBe('FULFILLED');
  });

  it('counts hand-supplied units the same as allocated ones', () => {
    // alreadyFulfilled and allocations are different in kind but both mean
    // "the customer has it or will get it from us".
    const r = line({ alreadyFulfilled: 2, allocations: [{ quantity: 3 }] });
    expect(r.readyQty).toBe(5);
    expect(r.status).toBe('FULFILLED');
  });
});

describe('a line that is partly procured', () => {
  it('is PARTIAL, with only the ready units dispatchable', () => {
    const r = line({ quantity: 5, allocations: [{ quantity: 3 }] });
    expect(r.readyQty).toBe(3);
    expect(r.pendingQty).toBe(2);
    expect(r.dispatchableQty).toBe(3);
    expect(r.status).toBe('PARTIAL');
  });
});

describe('a line with nothing procured', () => {
  it('is UNFULFILLED and dispatchable nowhere', () => {
    const r = line();
    expect(r.readyQty).toBe(0);
    expect(r.pendingQty).toBe(5);
    expect(r.dispatchableQty).toBe(0);
    expect(r.status).toBe('UNFULFILLED');
  });
});

describe('cancellation reduces what is owed', () => {
  it('needs only the uncancelled units', () => {
    // Five ordered, two called off: three is the requirement, and three
    // allocated is fully ready — not "short by two".
    const r = line({ quantity: 5, cancelledQty: 2, allocations: [{ quantity: 3 }] });
    expect(r.requiredQty).toBe(3);
    expect(r.pendingQty).toBe(0);
    expect(r.status).toBe('FULFILLED');
  });

  it('treats an entirely cancelled line as owing nothing', () => {
    const r = line({ quantity: 5, cancelledQty: 5 });
    expect(r.requiredQty).toBe(0);
    expect(r.pendingQty).toBe(0);
    expect(r.dispatchableQty).toBe(0);
  });
});

describe('what has already gone is not offered again', () => {
  it('subtracts dispatched units from what can be packed', () => {
    const r = line({ allocations: [{ quantity: 5 }], dispatchedQty: 2 });
    expect(r.readyQty).toBe(5);
    expect(r.dispatchableQty).toBe(3);
  });

  it('never offers a negative quantity', () => {
    // Over-dispatch is a data problem to report, not a negative amount to pack.
    const r = line({ allocations: [{ quantity: 2 }], dispatchedQty: 5 });
    expect(r.dispatchableQty).toBe(0);
  });

  it('caps readiness at the requirement, so one over-supplied line cannot carry an order', () => {
    const r = line({ quantity: 5, allocations: [{ quantity: 9 }] });
    expect(r.readyQty).toBe(5);
    expect(r.dispatchableQty).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  The whole order — the two cases from the brief
// ---------------------------------------------------------------------------

describe('EXAMPLE 1 — everything procured', () => {
  const lines: LineReadiness[] = [
    line({ quantity: 5, allocations: [{ quantity: 5 }] }), // 5 Kansa Thali
    line({ quantity: 2, allocations: [{ quantity: 2 }] }), // 2 Cooker
  ];

  it('is fully ready', () => {
    expect(orderFullyReady(lines)).toBe(true);
  });

  it('is not the partial case', () => {
    expect(orderPartiallyReady(lines)).toBe(false);
  });

  it('is not yet dispatched — ready is not the same as sent', () => {
    expect(orderFullyDispatched(lines)).toBe(false);
  });
});

describe('EXAMPLE 2 — thalis ready, cookers not', () => {
  const lines: LineReadiness[] = [
    line({ quantity: 5, allocations: [{ quantity: 5 }] }), // 5 ready
    line({ quantity: 2 }), // 2 not ready
  ];

  it('is not fully ready', () => {
    expect(orderFullyReady(lines)).toBe(false);
  });

  it('is partially ready — which is what offers a partial dispatch', () => {
    expect(orderPartiallyReady(lines)).toBe(true);
  });

  it('reports five dispatchable and two still pending', () => {
    expect(lines[0]!.dispatchableQty).toBe(5);
    expect(lines[1]!.pendingQty).toBe(2);
  });
});

describe('an order with nothing ready', () => {
  const lines = [line({ quantity: 5 }), line({ quantity: 2 })];

  it('is neither fully nor partially ready', () => {
    expect(orderFullyReady(lines)).toBe(false);
    expect(orderPartiallyReady(lines)).toBe(false);
    expect(orderNothingReady(lines)).toBe(true);
  });
});

describe('an order with no lines', () => {
  it('is not ready — there is nothing to send', () => {
    expect(orderFullyReady([])).toBe(false);
    expect(orderPartiallyReady([])).toBe(false);
    expect(orderFullyDispatched([])).toBe(false);
  });
});

describe('an order whose lines were all cancelled', () => {
  it('holds nothing back, but offers nothing either', () => {
    const lines = [line({ quantity: 5, cancelledQty: 5 })];
    // Nothing is pending, so it does not sit on the board as unready...
    expect(orderFullyReady(lines)).toBe(true);
    // ...but there is nothing to pack.
    expect(orderPartiallyReady(lines)).toBe(false);
    expect(lines[0]!.dispatchableQty).toBe(0);
  });
});

describe('fully dispatched', () => {
  it('is true only once every line has had its requirement sent', () => {
    const sent = [
      line({ quantity: 5, allocations: [{ quantity: 5 }], dispatchedQty: 5 }),
      line({ quantity: 2, allocations: [{ quantity: 2 }], dispatchedQty: 2 }),
    ];
    expect(orderFullyDispatched(sent)).toBe(true);
  });

  it('is false while one line is still partly out', () => {
    const partly = [
      line({ quantity: 5, allocations: [{ quantity: 5 }], dispatchedQty: 5 }),
      line({ quantity: 2, allocations: [{ quantity: 2 }], dispatchedQty: 1 }),
    ];
    expect(orderFullyDispatched(partly)).toBe(false);
  });

  it('counts a cancelled line as satisfied', () => {
    const lines = [
      line({ quantity: 5, allocations: [{ quantity: 5 }], dispatchedQty: 5 }),
      line({ quantity: 2, cancelledQty: 2 }),
    ];
    expect(orderFullyDispatched(lines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Customer checks
// ---------------------------------------------------------------------------

const customer = (over: Partial<Parameters<typeof customerDispatchChecks>[0]> = {}) =>
  customerDispatchChecks({
    name: 'Abhay',
    address: '14 Station Road, Moradabad',
    phone: '+91 98765 43210',
    email: 'abhay@example.com',
    ...over,
  });

describe('what stops a parcel leaving', () => {
  it('passes a complete customer', () => {
    const c = customer();
    expect(c.blockers).toHaveLength(0);
    expect(c.warnings).toHaveLength(0);
  });

  it('blocks a missing address — a parcel cannot be addressed', () => {
    expect(customer({ address: null }).blockers).toHaveLength(1);
    expect(customer({ address: '   ' }).blockers).toHaveLength(1);
  });

  it('blocks a missing phone — a courier needs one', () => {
    expect(customer({ phone: null }).blockers).toHaveLength(1);
  });

  it('blocks a missing name', () => {
    expect(customer({ name: '  ' }).blockers).toHaveLength(1);
  });

  it('only WARNS about a missing email, and never blocks on it', () => {
    const c = customer({ email: null });
    expect(c.blockers).toHaveLength(0);
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain('email');
  });

  it('reports every blocker at once rather than one at a time', () => {
    const c = customer({ address: null, phone: null, email: null });
    expect(c.blockers).toHaveLength(2);
    expect(c.warnings).toHaveLength(1);
  });
});
