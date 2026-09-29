/**
 * Packing & Dispatch — the shared contracts.
 *
 * Pure validation, no database and no network. These run against the same
 * schemas the API validates with, so a rule proved here is the rule the backend
 * enforces.
 *
 * Two rules carry most of the weight, and both are mirrored by CHECK
 * constraints in the database so neither tier can drift from the other:
 *
 *   - ALLOW needs a reason and may have a plan of action; DISALLOW needs both.
 *   - "Other" plus a written name is one answer: naming a channel or carrier
 *     *and* filling in the free-text partner is a contradiction, and so is
 *     choosing Other and leaving it blank.
 */

import { describe, expect, it } from 'vitest';
import {
  AWB_MAX_LENGTH,
  DISPATCH_CARRIERS,
  DISPATCH_CARRIER_LABELS,
  DISPATCH_CHANNELS,
  DISPATCH_CHANNEL_LABELS,
  DISPATCH_STATUSES,
  PARTIAL_DISPATCH_DEADLINE_HOURS,
  PARTIAL_DISPATCH_STATUSES,
  createDispatchSchema,
  createPartialDispatchRequestSchema,
  decidePartialDispatchSchema,
  dispatchOrderSchema,
  updateDispatchSchema,
} from '@rs/shared';

const CUID = 'clx0000000000000000000000';
const CUID2 = 'clx0000000000000000000001';

const shipment = (over: Record<string, unknown> = {}) => ({
  channel: 'BIGSHIP',
  carrier: 'DELHIVERY',
  awb: 'AWB123456',
  ...over,
});

// ---------------------------------------------------------------------------
//  The vocabularies
// ---------------------------------------------------------------------------

describe('the dispatch vocabularies match the database', () => {
  it('has the five dispatch states, in lifecycle order', () => {
    expect([...DISPATCH_STATUSES]).toEqual([
      'DRAFT',
      'PACKING',
      'PACKED',
      'DISPATCHED',
      'CANCELLED',
    ]);
  });

  it('has the four partial-dispatch states, including MOOT', () => {
    expect([...PARTIAL_DISPATCH_STATUSES]).toEqual([
      'PENDING',
      'ALLOWED',
      'DISALLOWED',
      'MOOT',
    ]);
  });

  it('offers the three requested channels and no more', () => {
    expect([...DISPATCH_CHANNELS]).toEqual(['BIGSHIP', 'SHIPROCKET', 'OTHER']);
  });

  it('offers the 26 named carriers plus Other', () => {
    expect(DISPATCH_CARRIERS).toHaveLength(27);
    expect(DISPATCH_CARRIERS.at(-1)).toBe('OTHER');
  });

  it('labels every channel and every carrier', () => {
    for (const c of DISPATCH_CHANNELS) expect(DISPATCH_CHANNEL_LABELS[c], c).toBeTruthy();
    for (const c of DISPATCH_CARRIERS) expect(DISPATCH_CARRIER_LABELS[c], c).toBeTruthy();
    expect(Object.keys(DISPATCH_CARRIER_LABELS)).toHaveLength(27);
  });

  it('spells the carriers the way the couriers do', () => {
    expect(DISPATCH_CARRIER_LABELS.BLUE_DART).toBe('Blue Dart');
    expect(DISPATCH_CARRIER_LABELS.ITHINK_LOGISTICS).toBe('iThink Logistics');
    expect(DISPATCH_CARRIER_LABELS.XPRESSBEES).toBe('XpressBees');
    expect(DISPATCH_CARRIER_LABELS.FEDEX).toBe('FedEx');
    expect(DISPATCH_CARRIER_LABELS.DHL_EXPRESS).toBe('DHL Express');
  });

  it('gives Procurement 24 hours to answer', () => {
    expect(PARTIAL_DISPATCH_DEADLINE_HOURS).toBe(24);
  });
});

// ---------------------------------------------------------------------------
//  Creating a shipment
// ---------------------------------------------------------------------------

describe('opening a shipment', () => {
  it('needs an order and at least one line', () => {
    expect(
      createDispatchSchema.safeParse({
        salesOrderId: CUID,
        items: [{ salesOrderItemId: CUID2, quantity: 2 }],
      }).success,
    ).toBe(true);
  });

  it('refuses a shipment carrying nothing', () => {
    expect(createDispatchSchema.safeParse({ salesOrderId: CUID, items: [] }).success).toBe(false);
  });

  it('refuses a zero or negative quantity, matching the CHECK constraint', () => {
    for (const quantity of [0, -1]) {
      expect(
        createDispatchSchema.safeParse({
          salesOrderId: CUID,
          items: [{ salesOrderItemId: CUID2, quantity }],
        }).success,
        String(quantity),
      ).toBe(false);
    }
  });

  it('accepts no carrier or AWB — those arrive later', () => {
    // A pack is started before anybody knows how it will travel.
    const parsed = createDispatchSchema.safeParse({
      salesOrderId: CUID,
      items: [{ salesOrderItemId: CUID2, quantity: 1 }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'awb' in parsed.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Other + free text is one answer
// ---------------------------------------------------------------------------

describe('"Other" and its written name travel together', () => {
  it('requires the name when the channel is Other', () => {
    const bad = dispatchOrderSchema.safeParse(shipment({ channel: 'OTHER' }));
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0]!.path).toEqual(['channelOther']);
  });

  it('accepts Other once it is named', () => {
    expect(
      dispatchOrderSchema.safeParse(shipment({ channel: 'OTHER', channelOther: 'Local courier' }))
        .success,
    ).toBe(true);
  });

  it('refuses a written name beside a named channel', () => {
    // Two contradictory statements about how it was booked.
    const bad = dispatchOrderSchema.safeParse(
      shipment({ channel: 'BIGSHIP', channelOther: 'Local courier' }),
    );
    expect(bad.success).toBe(false);
  });

  it('applies the same rule to the carrier', () => {
    expect(dispatchOrderSchema.safeParse(shipment({ carrier: 'OTHER' })).success).toBe(false);
    expect(
      dispatchOrderSchema.safeParse(shipment({ carrier: 'OTHER', carrierOther: 'Local van' }))
        .success,
    ).toBe(true);
    expect(
      dispatchOrderSchema.safeParse(shipment({ carrier: 'DTDC', carrierOther: 'Local van' }))
        .success,
    ).toBe(false);
  });

  it('refuses free text with no choice at all, while packing', () => {
    expect(updateDispatchSchema.safeParse({ carrierOther: 'Local van' }).success).toBe(false);
    expect(updateDispatchSchema.safeParse({ channelOther: 'Someone' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Dispatching needs tracing
// ---------------------------------------------------------------------------

describe('sending the goods requires a traceable shipment', () => {
  it('accepts a complete shipment', () => {
    expect(dispatchOrderSchema.safeParse(shipment()).success).toBe(true);
  });

  it('refuses a missing AWB, carrier or channel', () => {
    for (const field of ['awb', 'carrier', 'channel'] as const) {
      const body = shipment();
      delete (body as Record<string, unknown>)[field];
      expect(dispatchOrderSchema.safeParse(body).success, field).toBe(false);
    }
  });

  it('refuses a blank AWB', () => {
    expect(dispatchOrderSchema.safeParse(shipment({ awb: '   ' })).success).toBe(false);
  });

  it('keeps an AWB as text, preserving leading zeros', () => {
    const parsed = dispatchOrderSchema.safeParse(shipment({ awb: '000123456' }));
    expect(parsed.success && parsed.data.awb).toBe('000123456');
  });

  it('trims an AWB and caps its length', () => {
    const parsed = dispatchOrderSchema.safeParse(shipment({ awb: '  AWB99  ' }));
    expect(parsed.success && parsed.data.awb).toBe('AWB99');
    expect(dispatchOrderSchema.safeParse(shipment({ awb: '1'.repeat(AWB_MAX_LENGTH) })).success).toBe(
      true,
    );
    expect(
      dispatchOrderSchema.safeParse(shipment({ awb: '1'.repeat(AWB_MAX_LENGTH + 1) })).success,
    ).toBe(false);
  });

  it('refuses a carrier that is not on the list', () => {
    expect(dispatchOrderSchema.safeParse(shipment({ carrier: 'MADE_UP' })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The partial-dispatch decision — the asymmetry
// ---------------------------------------------------------------------------

describe('raising a partial-dispatch request', () => {
  it('needs only the order — the reason belongs to the answer', () => {
    expect(createPartialDispatchRequestSchema.safeParse({ salesOrderId: CUID }).success).toBe(true);
  });

  it('accepts an optional note for the procurement person', () => {
    expect(
      createPartialDispatchRequestSchema.safeParse({ salesOrderId: CUID, note: 'Customer waiting' })
        .success,
    ).toBe(true);
  });
});

describe('ALLOW needs a reason; POA is optional', () => {
  it('accepts a reason on its own', () => {
    expect(
      decidePartialDispatchSchema.safeParse({ decision: 'ALLOW', reason: 'Customer agreed' })
        .success,
    ).toBe(true);
  });

  it('accepts a reason with a plan of action', () => {
    expect(
      decidePartialDispatchSchema.safeParse({
        decision: 'ALLOW',
        reason: 'Customer agreed',
        poa: 'Rest follows next week',
      }).success,
    ).toBe(true);
  });

  it('refuses an allow with no reason', () => {
    expect(decidePartialDispatchSchema.safeParse({ decision: 'ALLOW' }).success).toBe(false);
    expect(
      decidePartialDispatchSchema.safeParse({ decision: 'ALLOW', reason: '   ' }).success,
    ).toBe(false);
  });
});

describe('DISALLOW needs a reason AND a plan of action', () => {
  it('accepts both', () => {
    expect(
      decidePartialDispatchSchema.safeParse({
        decision: 'DISALLOW',
        reason: 'Cooker arrives Friday',
        poa: 'Hold and ship complete on Friday',
      }).success,
    ).toBe(true);
  });

  it('refuses a refusal with no plan of action', () => {
    // Refusing leaves goods sitting; somebody has to say what happens instead.
    const bad = decidePartialDispatchSchema.safeParse({
      decision: 'DISALLOW',
      reason: 'Cooker arrives Friday',
    });
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0]!.path).toEqual(['poa']);
  });

  it('refuses a refusal with no reason', () => {
    expect(
      decidePartialDispatchSchema.safeParse({ decision: 'DISALLOW', poa: 'Wait' }).success,
    ).toBe(false);
  });

  it('is the one place the two decisions differ', () => {
    // Same body: valid as an ALLOW, invalid as a DISALLOW. That asymmetry is
    // the business rule, and it is mirrored by the database CHECK constraints.
    const body = { reason: 'Same wording either way' };
    expect(decidePartialDispatchSchema.safeParse({ ...body, decision: 'ALLOW' }).success).toBe(true);
    expect(decidePartialDispatchSchema.safeParse({ ...body, decision: 'DISALLOW' }).success).toBe(
      false,
    );
  });

  it('accepts no decision other than ALLOW or DISALLOW', () => {
    // MOOT and the automatic allow are reached by the system, never posted.
    for (const decision of ['MOOT', 'ALLOWED', 'AUTO', 'PENDING', '']) {
      expect(
        decidePartialDispatchSchema.safeParse({ decision, reason: 'x', poa: 'y' }).success,
        decision,
      ).toBe(false);
    }
  });
});
