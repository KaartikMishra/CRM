/**
 * The Zod contracts for the cross-cutting foundation.
 *
 * ### Why these are tested directly rather than through HTTP
 *
 * Every other schema in this codebase is exercised by posting to its route, which
 * is better: it proves the schema is actually wired into the request path. Phase
 * 0.5 deliberately mounts no routes — an endpoint with no screen behind it is
 * surface nobody has asked for and nothing exercises — so there is no request to
 * post. Testing the schemas directly is the honest alternative, and it is stated
 * here so the absence of route tests is not mistaken for an omission.
 *
 * What these pin is the pairing between each schema and the database CHECK beside
 * it. Both exist on purpose: the schema rejects bad input with a message somebody
 * can act on, and the constraint refuses it again so no script, console or future
 * endpoint can write a row that contradicts itself. A schema that drifted from its
 * constraint would produce either an unexplainable 500 or a row the application
 * believes is impossible.
 */

import { describe, expect, it } from 'vitest';
import {
  cancelApprovalRequestSchema,
  createApprovalRequestSchema,
  createSecureDocumentSchema,
  decideApprovalRequestSchema,
  hrSettingKeySchema,
  upsertHRSettingSchema,
  upsertHRSettingSchema as upsertSettingSchema,
} from '@rs/shared';

const CUID = 'clzz0000000000000000000a';

describe('raising an approval request', () => {
  const valid = {
    entityType: 'LeaveRequest',
    entityId: CUID,
    module: 'HR_LEAVE' as const,
  };

  it('accepts the minimum and defaults the action to APPROVE', () => {
    const parsed = createApprovalRequestSchema.parse(valid);
    // Deciding a request is what APPROVE means, so it is the sensible default and
    // a caller never has to name it.
    expect(parsed.action).toBe('APPROVE');
  });

  it('refuses a blank entity type, as the CHECK does', () => {
    expect(createApprovalRequestSchema.safeParse({ ...valid, entityType: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses an entity id that is not an identifier', () => {
    expect(createApprovalRequestSchema.safeParse({ ...valid, entityId: 'nope' }).success).toBe(
      false,
    );
  });

  it('accepts a payload object but not a bare value', () => {
    expect(
      createApprovalRequestSchema.safeParse({ ...valid, payload: { days: 2 } }).success,
    ).toBe(true);
    /*
      A record rather than `z.any()`: a string or an array arriving where the
      reader expects fields is a defect that surfaces in the UI as a blank panel
      rather than as an error.
    */
    expect(createApprovalRequestSchema.safeParse({ ...valid, payload: 'two days' }).success).toBe(
      false,
    );
    expect(createApprovalRequestSchema.safeParse({ ...valid, payload: [1, 2] }).success).toBe(
      false,
    );
  });

  it('does not accept a status, a requester or a decision', () => {
    const parsed = createApprovalRequestSchema.parse({
      ...valid,
      status: 'APPROVED',
      requestedById: CUID,
      decidedById: CUID,
    } as Record<string, unknown>);

    /*
      The point of the whole table: a request that could be born APPROVED, or that
      could name somebody else as its requester, is not an approval. Zod strips
      unknown keys rather than failing, so the assertion is that they did not
      survive — the service supplies all three from the session and the status
      machine.
    */
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('requestedById');
    expect(parsed).not.toHaveProperty('decidedById');
  });
});

describe('deciding an approval request', () => {
  it('accepts an approval with no note', () => {
    expect(decideApprovalRequestSchema.parse({ decision: 'APPROVED' }).decision).toBe('APPROVED');
  });

  it('requires a note when rejecting', () => {
    /*
      Somebody whose request was turned down needs to know why, and "no" with no
      reason is the commonest complaint about every approval system. Approving
      needs no justification — the decision speaks for itself.
    */
    expect(decideApprovalRequestSchema.safeParse({ decision: 'REJECTED' }).success).toBe(false);
    expect(
      decideApprovalRequestSchema.safeParse({ decision: 'REJECTED', note: 'Team is short' })
        .success,
    ).toBe(true);
  });

  it('refuses a blank note as a rejection reason', () => {
    expect(
      decideApprovalRequestSchema.safeParse({ decision: 'REJECTED', note: '   ' }).success,
    ).toBe(false);
  });

  it('does not let an approver cancel', () => {
    /*
      CANCELLED is absent from this schema deliberately. Withdrawing is the
      requester's act and has its own endpoint; if both lived here an approver
      could cancel somebody else's request and the trail would read as though that
      person withdrew it themselves.
    */
    expect(decideApprovalRequestSchema.safeParse({ decision: 'CANCELLED' }).success).toBe(false);
    expect(decideApprovalRequestSchema.safeParse({ decision: 'PENDING' }).success).toBe(false);
    // And the cancel schema takes no decision at all — only an optional note.
    expect(cancelApprovalRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('HR setting keys', () => {
  it('accepts dotted lowercase keys', () => {
    for (const key of ['working_hours.start', 'leave.annual_quota', 'payroll.cycle_day', 'shift']) {
      expect(hrSettingKeySchema.safeParse(key).success, key).toBe(true);
    }
  });

  it('refuses spacing and capitals, which would split one setting in two', () => {
    /*
      The failure this prevents: "Working Hours" and "working_hours" are two rows
      that read as the same setting, and the unique index cannot help — it sees two
      different keys. A key is an identifier code matches on, so the shape is
      enforced rather than suggested.
    */
    for (const key of ['Working Hours', 'workingHours', 'WORKING_HOURS', 'working hours']) {
      expect(hrSettingKeySchema.safeParse(key).success, key).toBe(false);
    }
  });

  it('refuses a blank key, as the CHECK does', () => {
    expect(hrSettingKeySchema.safeParse('   ').success).toBe(false);
    expect(hrSettingKeySchema.safeParse('').success).toBe(false);
  });

  it('refuses leading, trailing and doubled separators', () => {
    for (const key of ['.leading', 'trailing.', 'double..dot', '_leading', 'trailing_']) {
      expect(hrSettingKeySchema.safeParse(key).success, key).toBe(false);
    }
  });
});

describe('HR setting values', () => {
  const base = { module: 'HR_LEAVE' as const, key: 'annual_quota' };

  it('accepts the four shapes a setting can take', () => {
    for (const value of [21, 'monthly', true, ['SATURDAY', 'SUNDAY'], { start: '09:30' }]) {
      expect(upsertSettingSchema.safeParse({ ...base, value }).success, String(value)).toBe(true);
    }
  });

  it('refuses null', () => {
    /*
      Clearing a setting is deleting its row, not storing an absence. Allowing null
      would give every reader two "not configured" states to handle and guarantee
      that some reader handles only one.
    */
    expect(upsertHRSettingSchema.safeParse({ ...base, value: null }).success).toBe(false);
  });

  it('refuses a module outside HR', () => {
    /*
      The column is an AppModule because that is the enum Postgres has, but the
      contract is narrower on purpose: nothing should file a setting under SALES
      while Sales keeps its constants in code, where the database enforces them as
      CHECK constraints. Widening this later is additive; narrowing it after rows
      exist is not.
    */
    expect(
      upsertHRSettingSchema.safeParse({ module: 'SALES', key: 'cap', value: 1 }).success,
    ).toBe(false);
  });
});

describe('registering a secure document', () => {
  const valid = {
    publicId: 'royalstuffs-crm/secure/abc123',
    kind: 'PAYSLIP' as const,
    module: 'HR_PAYROLL' as const,
    ownerType: 'User' as const,
    ownerId: CUID,
  };

  it('accepts the minimum', () => {
    expect(createSecureDocumentSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts no URL of any kind', () => {
    /*
      The central decision of the whole feature, asserted at the contract edge. A
      stored URL outlives every access check, cannot be revoked, and is precisely
      how MediaAsset's files became world-readable. `publicId` is useless on its
      own — an authenticated object needs a signature — so a leaked row leaks
      nothing.
    */
    const parsed = createSecureDocumentSchema.parse({
      ...valid,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/payslip.pdf',
      url: 'https://example.invalid/payslip.pdf',
    } as Record<string, unknown>);

    expect(parsed).not.toHaveProperty('secureUrl');
    expect(parsed).not.toHaveProperty('url');
  });

  it('does not accept a delivery type', () => {
    /*
      Set by the upload service to 'authenticated' and nothing else. A caller able
      to choose it could choose Cloudinary's public default, and the row would claim
      confidentiality while being fetchable by anybody.
    */
    const parsed = createSecureDocumentSchema.parse({
      ...valid,
      deliveryType: 'upload',
    } as Record<string, unknown>);

    expect(parsed).not.toHaveProperty('deliveryType');
  });

  it('does not accept an uploader', () => {
    const parsed = createSecureDocumentSchema.parse({
      ...valid,
      uploadedById: CUID,
    } as Record<string, unknown>);

    expect(parsed).not.toHaveProperty('uploadedById');
  });

  it('accepts Employee now that the model exists, and nothing invented', () => {
    /*
      'Employee' joined the owner-type enum in Phase 1 along with the model — the
      extension this schema was written to accommodate. The enum is still closed:
      a free string would let a typo file a payslip under an owner type nothing
      will ever query, so the document would be invisible rather than obviously
      misfiled.
    */
    expect(createSecureDocumentSchema.safeParse({ ...valid, ownerType: 'Employee' }).success).toBe(
      true,
    );
    expect(createSecureDocumentSchema.safeParse({ ...valid, ownerType: 'Person' }).success).toBe(
      false,
    );
    expect(createSecureDocumentSchema.safeParse({ ...valid, ownerType: 'employee' }).success).toBe(
      false,
    );
  });

  it('refuses a zero or negative size, as the CHECK does', () => {
    expect(createSecureDocumentSchema.safeParse({ ...valid, bytes: 0 }).success).toBe(false);
    expect(createSecureDocumentSchema.safeParse({ ...valid, bytes: -1 }).success).toBe(false);
    expect(createSecureDocumentSchema.safeParse({ ...valid, bytes: 48_000 }).success).toBe(true);
  });

  it('refuses a blank storage identifier, as the CHECK does', () => {
    expect(createSecureDocumentSchema.safeParse({ ...valid, publicId: '  ' }).success).toBe(false);
  });
});
