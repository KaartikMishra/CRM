/**
 * The generic approval rules, as pure logic.
 *
 * A separate file from approval.test.ts deliberately: that one pins the *role*
 * rule, which governs whether a request is created at all, and must keep passing
 * unchanged. This one pins the *permission* rule, which governs who may decide a
 * request that already exists.
 *
 * The two look contradictory and are not, and the relationship between them is
 * the thing most worth testing — an administrator needs no approval for their own
 * change (so no request is created), but may not approve a request they
 * themselves raised (because raising it was asking somebody else). Both are
 * asserted below so neither can be "simplified" into the other later.
 */

import { describe, expect, it } from 'vitest';
import type { Role } from '@rs/shared';
import {
  isApprovalOpen,
  mayCancelApproval,
  mayDecideApproval,
  requiresApproval,
  type ApprovalActor,
} from '../approval.js';

const actor = (role: Role, id: string, mayApprove: boolean): ApprovalActor => ({
  id,
  role,
  mayApprove,
});

const request = (requestedById: string, status = 'PENDING') => ({ requestedById, status });

describe('deciding a request needs APPROVE on its module', () => {
  it('lets somebody with the permission decide', () => {
    expect(mayDecideApproval(actor('USER', 'manager', true), request('employee'))).toBe(true);
  });

  it('refuses somebody without it, whatever their role', () => {
    expect(mayDecideApproval(actor('USER', 'colleague', false), request('employee'))).toBe(false);
    // An administrator too: the capability is resolved per module, and an
    // administrator with the permission revoked by an override holds it no more
    // than anybody else. This is the property that lets a reporting manager
    // approve leave without being an administrator, and it only works if the
    // role is not a back door.
    expect(mayDecideApproval(actor('ADMIN', 'admin', false), request('employee'))).toBe(false);
  });
});

describe('nobody approves their own request', () => {
  it('refuses the requester even when they hold APPROVE', () => {
    expect(mayDecideApproval(actor('USER', 'same', true), request('same'))).toBe(false);
  });

  it('refuses an administrator their own request', () => {
    /*
      The case that looks like a contradiction with requiresApproval, and is not.

      requiresApproval says an administrator's change needs no second pair of
      eyes — so no request is ever created and the change is simply applied. If a
      request *does* exist, somebody deliberately asked for a decision, and
      letting the asker supply it would put one name on both lines of the trail.

      An administrator who wants no review takes the first path. One who creates a
      request has asked somebody else, by that act.
    */
    expect(requiresApproval({ id: 'admin', role: 'ADMIN' })).toBe(false);
    expect(mayDecideApproval(actor('ADMIN', 'admin', true), request('admin'))).toBe(false);
  });

  it('still lets them decide somebody else’s', () => {
    expect(mayDecideApproval(actor('ADMIN', 'admin', true), request('employee'))).toBe(true);
  });
});

describe('only a pending request can be decided', () => {
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
    it(`refuses a ${status} request`, () => {
      expect(
        mayDecideApproval(actor('ADMIN', 'admin', true), request('employee', status)),
      ).toBe(false);
    });
  }

  it('accepts a PENDING one', () => {
    expect(
      mayDecideApproval(actor('ADMIN', 'admin', true), request('employee', 'PENDING')),
    ).toBe(true);
  });
});

describe('withdrawing is the requester’s act alone', () => {
  it('lets the requester withdraw', () => {
    expect(mayCancelApproval({ id: 'employee', role: 'USER' }, request('employee'))).toBe(true);
  });

  it('refuses everybody else, administrators included', () => {
    expect(mayCancelApproval({ id: 'manager', role: 'USER' }, request('employee'))).toBe(false);
    /*
      Deliberate, and the reason is the record rather than the authority: a
      cancellation is stored as the requester's own withdrawal and carries no
      decider, so an administrator cancelling somebody else's request would leave
      a trail saying that person withdrew it themselves. An administrator who
      wants it gone rejects it, which names them and takes a note.
    */
    expect(mayCancelApproval({ id: 'admin', role: 'ADMIN' }, request('employee'))).toBe(false);
  });

  it('refuses once the request has been decided', () => {
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
      expect(
        mayCancelApproval({ id: 'employee', role: 'USER' }, request('employee', status)),
        status,
      ).toBe(false);
    }
  });
});

describe('openness is one question with one answer', () => {
  it('treats only PENDING as open', () => {
    expect(isApprovalOpen({ status: 'PENDING' })).toBe(true);
    for (const status of ['APPROVED', 'REJECTED', 'CANCELLED']) {
      expect(isApprovalOpen({ status }), status).toBe(false);
    }
  });

  it('does not treat CANCELLED as open, which a hand-rolled check would', () => {
    // The bug this guards: `status !== 'APPROVED' && status !== 'REJECTED'` reads
    // as "still open" and silently includes a withdrawn request, so an approver's
    // queue shows work nobody is waiting on.
    const withdrawn = { status: 'CANCELLED' };
    expect(isApprovalOpen(withdrawn)).toBe(false);
    expect(withdrawn.status !== 'APPROVED' && withdrawn.status !== 'REJECTED').toBe(true);
  });
});
