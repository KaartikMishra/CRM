/**
 * The approval foundation against the real database.
 *
 * Real persistence rather than a mocked repository, because half of what is being
 * tested lives in Postgres: the decision-consistency CHECK, the uniqueness of a
 * pending request, and the conditional update that makes two simultaneous
 * approvers safe. A mock would assert that the code calls Prisma, which is not
 * the thing that could be wrong.
 *
 * `entityType`/`entityId` here are a module name and a cuid that need not resolve
 * to anything — deliberately. The table is polymorphic and knows nothing about
 * what it governs, so these tests exercise it exactly as a future HR module will:
 * by naming a record it owns.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../config/database.js';
import {
  approvalHistoryFor,
  cancelApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
  hasPendingApproval,
  listApprovalRequests,
  readApprovalRequest,
} from '../approval.service.js';
import { cleanup, makeUser, type TestUser } from '../../__tests__/helpers/fixtures.js';
import { AppError } from '../../utils/AppError.js';

let manager: TestUser;
let employee: TestUser;
let bystander: TestUser;

/** A fresh synthetic entity per test, so no two tests share a pending request. */
let counter = 0;
const entity = (): { entityType: string; entityId: string } => {
  counter += 1;
  return { entityType: 'ZzTestLeaveRequest', entityId: `clzz${String(counter).padStart(20, '0')}` };
};

const actorOf = (user: TestUser) => ({ id: user.id, role: user.role });

beforeAll(async () => {
  // The manager approves leave without being an administrator — the case the
  // whole design exists for — so the capability comes from an override row.
  manager = await makeUser('USER');
  employee = await makeUser('USER');
  bystander = await makeUser('USER');

  await prisma.userModulePermission.create({
    data: { userId: manager.id, module: 'HR_LEAVE', action: 'APPROVE', allowed: true },
  });
});

afterAll(async () => {
  await prisma.approvalRequest.deleteMany({
    where: { requestedById: { in: [manager.id, employee.id, bystander.id] } },
  });
  await cleanup();
});

describe('raising a request', () => {
  it('stores it as PENDING with no decision recorded', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
      reason: 'Two days, family wedding',
    });

    expect(request.status).toBe('PENDING');
    expect(request.requestedById).toBe(employee.id);
    expect(request.decidedById).toBeNull();
    expect(request.decidedAt).toBeNull();
    // APPROVE by default: deciding a request is what the action means.
    expect(request.action).toBe('APPROVE');
  });

  it('keeps the proposed values as evidence', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
      payload: { from: '2026-11-02', to: '2026-11-03', days: 2 },
    });

    expect(request.payload).toEqual({ from: '2026-11-02', to: '2026-11-03', days: 2 });
  });

  it('refuses a second pending request for the same thing', async () => {
    const target = entity();
    await createApprovalRequest(actorOf(employee), { ...target, module: 'HR_LEAVE' });

    /*
      The failure this prevents: a double-submitted form produces two requests,
      two approvers decide them independently, and the second decision silently
      contradicts the first with nothing in the trail explaining which is current.
    */
    await expect(
      createApprovalRequest(actorOf(employee), { ...target, module: 'HR_LEAVE' }),
    ).rejects.toThrow(AppError);
  });

  it('allows a new request once the first is decided', async () => {
    const target = entity();
    const first = await createApprovalRequest(actorOf(employee), {
      ...target,
      module: 'HR_LEAVE',
    });
    await decideApprovalRequest(actorOf(manager), first.id, {
      decision: 'REJECTED',
      note: 'Team is short that week',
    });

    // A rejected request is a closed matter, not a permanent bar on asking again.
    const second = await createApprovalRequest(actorOf(employee), {
      ...target,
      module: 'HR_LEAVE',
    });
    expect(second.status).toBe('PENDING');
  });
});

describe('deciding a request', () => {
  it('records who decided, when, and what they said', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    const decided = await decideApprovalRequest(actorOf(manager), request.id, {
      decision: 'APPROVED',
      note: 'Cover arranged',
    });

    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedById).toBe(manager.id);
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.decisionNote).toBe('Cover arranged');
    // The requester is unchanged — a decision does not rewrite who asked.
    expect(decided.requestedById).toBe(employee.id);
  });

  it('refuses somebody with no APPROVE on that module', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    await expect(
      decideApprovalRequest(actorOf(bystander), request.id, { decision: 'APPROVED' }),
    ).rejects.toThrow(AppError);

    // And nothing moved.
    expect((await readApprovalRequest(request.id)).status).toBe('PENDING');
  });

  it('refuses the requester their own request', async () => {
    const request = await createApprovalRequest(actorOf(manager), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    // The manager holds APPROVE on HR_LEAVE and still cannot approve this one,
    // because they raised it.
    await expect(
      decideApprovalRequest(actorOf(manager), request.id, { decision: 'APPROVED' }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a request that has already been decided', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });
    await decideApprovalRequest(actorOf(manager), request.id, { decision: 'APPROVED' });

    await expect(
      decideApprovalRequest(actorOf(manager), request.id, { decision: 'REJECTED' }),
    ).rejects.toThrow(AppError);

    // The first decision stands rather than being overwritten.
    expect((await readApprovalRequest(request.id)).status).toBe('APPROVED');
  });

  it('lets only one of two simultaneous approvers win', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    const admin = await makeUser('ADMIN');

    /*
      Both hold APPROVE and both decide at once. The conditional update —
      updateMany with `status: 'PENDING'` rather than update by id — is what makes
      exactly one succeed. A read-then-write would let both through and the second
      would silently overwrite the first.
    */
    const results = await Promise.allSettled([
      decideApprovalRequest(actorOf(manager), request.id, { decision: 'APPROVED' }),
      decideApprovalRequest(actorOf(admin), request.id, {
        decision: 'REJECTED',
        note: 'Declined',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // And the stored row agrees with whichever won — one decider, not two.
    const stored = await readApprovalRequest(request.id);
    expect(['APPROVED', 'REJECTED']).toContain(stored.status);
    expect([manager.id, admin.id]).toContain(stored.decidedById);
  });
});

describe('withdrawing a request', () => {
  it('lets the requester withdraw, recording no decider', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    const cancelled = await cancelApprovalRequest(actorOf(employee), request.id, 'Changed plans');

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.decisionNote).toBe('Changed plans');
    /*
      No decider, and that is the database's rule as well as the service's:
      approval_decision_consistency groups CANCELLED with PENDING precisely
      because withdrawing is not deciding. A withdrawn request with a decider on it
      would read as though somebody had ruled on it.
    */
    expect(cancelled.decidedById).toBeNull();
    expect(cancelled.decidedAt).toBeNull();
  });

  it('refuses anybody but the requester', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    await expect(cancelApprovalRequest(actorOf(manager), request.id)).rejects.toThrow(AppError);
  });

  it('keeps the row rather than deleting it', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });
    await cancelApprovalRequest(actorOf(employee), request.id);

    // The evidence that it was asked at all survives the withdrawal.
    const stored = await prisma.approvalRequest.findUnique({ where: { id: request.id } });
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('CANCELLED');
  });
});

describe('the database refuses an inconsistent decision', () => {
  it('rejects a PENDING row that names a decider', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    /*
      Written straight through Prisma, bypassing the service, which is the point:
      the CHECK must hold against a script or a console as well as against the
      application. A PENDING request that already names a decider makes the trail
      worthless exactly when somebody needs to audit it.
    */
    await expect(
      prisma.approvalRequest.update({
        where: { id: request.id },
        data: { decidedById: manager.id, decidedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('rejects an APPROVED row with no decider', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    await expect(
      prisma.approvalRequest.update({
        where: { id: request.id },
        data: { status: 'APPROVED' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a decision that predates its request', async () => {
    const request = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    await expect(
      prisma.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          decidedById: manager.id,
          decidedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an empty entity reference', async () => {
    await expect(
      prisma.approvalRequest.create({
        data: {
          entityType: '   ',
          entityId: 'something',
          module: 'HR_LEAVE',
          requestedById: employee.id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('reading requests back', () => {
  it('answers whether one thing is waiting on a decision', async () => {
    const target = entity();
    expect(await hasPendingApproval(target.entityType, target.entityId)).toBe(false);

    const request = await createApprovalRequest(actorOf(employee), {
      ...target,
      module: 'HR_LEAVE',
    });
    expect(await hasPendingApproval(target.entityType, target.entityId)).toBe(true);

    await decideApprovalRequest(actorOf(manager), request.id, { decision: 'APPROVED' });
    // Decided is not pending — which a `!== APPROVED && !== REJECTED` check would
    // also get right, but a `status !== 'PENDING'` inversion would not.
    expect(await hasPendingApproval(target.entityType, target.entityId)).toBe(false);
  });

  it('returns one entity’s full history, newest first', async () => {
    const target = entity();
    const first = await createApprovalRequest(actorOf(employee), {
      ...target,
      module: 'HR_LEAVE',
    });
    await decideApprovalRequest(actorOf(manager), first.id, { decision: 'REJECTED', note: 'No' });
    const second = await createApprovalRequest(actorOf(employee), {
      ...target,
      module: 'HR_LEAVE',
    });

    const history = await approvalHistoryFor(target.entityType, target.entityId);
    expect(history.map((h) => h.id)).toEqual([second.id, first.id]);
  });

  it('excludes a person’s own requests from their approver queue', async () => {
    const own = await createApprovalRequest(actorOf(manager), {
      ...entity(),
      module: 'HR_LEAVE',
    });
    const other = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });

    const { requests } = await listApprovalRequests(actorOf(manager), {
      limit: 50,
      status: 'PENDING',
      entityType: 'ZzTestLeaveRequest',
      mine: true,
    });

    const ids = requests.map((r) => r.id);
    expect(ids).toContain(other.id);
    // Nobody decides their own, so showing it in the queue would be showing work
    // they cannot do.
    expect(ids).not.toContain(own.id);
  });

  it('excludes modules the person holds no APPROVE on', async () => {
    const leave = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_LEAVE',
    });
    const payroll = await createApprovalRequest(actorOf(employee), {
      ...entity(),
      module: 'HR_PAYROLL',
    });

    const { requests } = await listApprovalRequests(actorOf(manager), {
      limit: 50,
      status: 'PENDING',
      entityType: 'ZzTestLeaveRequest',
      mine: true,
    });

    const ids = requests.map((r) => r.id);
    // The manager approves leave and not payroll — the separation the seven
    // namespaces exist to express.
    expect(ids).toContain(leave.id);
    expect(ids).not.toContain(payroll.id);
  });
});
