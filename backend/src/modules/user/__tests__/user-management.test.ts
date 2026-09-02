/**
 * §15–17 — administrator user management and module access control.
 *
 * Three things are being proved here, and they are deliberately separate:
 *
 *   1. an ADMIN can do the whole job — list, create, edit, activate, and grant
 *      any number of modules from zero to seven;
 *   2. a USER can do none of it, and cannot escalate themselves by any route
 *      the API exposes;
 *   3. a granted module actually opens the module's API, and a revoked one
 *      actually closes it — enforced by the backend, not by the sidebar.
 *
 * Everything runs against the real Express app and the real database, because
 * the rules being tested live in the middleware chain and the permission
 * resolver. Mocking either would test the mock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_MODULES } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  makeUser,
  residualTestRows,
  TEST_PREFIX,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
let user: TestUser;
let adminToken: string;
let userToken: string;

/** Accounts this suite creates through the API, removed in afterAll. */
const createdIds: string[] = [];

const PASSWORD = `Str0ng-${randomUUID().slice(0, 12)}`;

/** A create-user payload with a unique email, so re-runs never collide. */
function newUserPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  return {
    name: `${TEST_PREFIX}-created`,
    email: `${TEST_PREFIX}-${suffix}@test.invalid`,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    modules: [],
    ...overrides,
  };
}

type UserBody = {
  user: {
    id: string;
    name: string;
    email: string;
    employeeId: string;
    role: string;
    isActive: boolean;
    modules: string[];
  };
};

/** Creates a user through the API and registers it for cleanup. */
async function createViaApi(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await api('POST', '/api/users', { token: adminToken, body: payload });
  const created = (res.body.data as UserBody | undefined)?.user;
  if (created?.id) createdIds.push(created.id);
  return res as { status: number; body: Record<string, unknown> };
}

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  user = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  userToken = await mintToken(user.id, { role: 'USER' });
});

afterAll(async () => {
  // These accounts were created through the API, so the fixture helper never
  // saw them and cleanup() cannot remove them. They also carry audit rows
  // written *about* them by the administrator, which reference the row by
  // entityId rather than actorId, so both directions have to go.
  if (createdIds.length) {
    await prisma.userModulePermission.deleteMany({ where: { userId: { in: createdIds } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: createdIds } }, { entityId: { in: createdIds } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  }
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  §15 — the administrator
// ---------------------------------------------------------------------------

describe('ADMIN capabilities', () => {
  it('lists users without ever exposing a password hash', async () => {
    const res = await api('GET', '/api/users', { token: adminToken });

    expect(res.status).toBe(200);
    const { users } = res.body.data as { users: UserBody['user'][] };
    expect(users.length).toBeGreaterThan(0);

    // §23 — the shape is the contract, so this is checked on the raw payload.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$2b$');
    expect(raw).not.toContain(PASSWORD);
  });

  it('creates a USER', async () => {
    const res = await createViaApi(newUserPayload());

    expect(res.status).toBe(201);
    const created = (res.body.data as UserBody).user;
    expect(created.role).toBe('USER');
    expect(created.isActive).toBe(true);
    expect(created.modules).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  it('stores the password as a bcrypt hash, never as plaintext', async () => {
    const res = await createViaApi(newUserPayload());
    const created = (res.body.data as UserBody).user;

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
      select: { passwordHash: true },
    });

    expect(row.passwordHash).not.toBe(PASSWORD);
    expect(row.passwordHash.startsWith('$2b$')).toBe(true);
  });

  it('refuses a duplicate email', async () => {
    const payload = newUserPayload();
    const first = await createViaApi(payload);
    expect(first.status).toBe(201);

    const second = await createViaApi(payload);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('EMAIL_TAKEN');
  });

  it('refuses mismatched password confirmation', async () => {
    const res = await createViaApi(
      newUserPayload({ confirmPassword: 'something-else-entirely' }),
    );
    expect(res.status).toBe(422);
  });

  it('edits a name', async () => {
    const created = (await createViaApi(newUserPayload())).body.data as UserBody;

    const res = await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { name: `${TEST_PREFIX}-renamed` },
    });

    expect(res.status).toBe(200);
    expect((res.body.data as UserBody).user.name).toBe(`${TEST_PREFIX}-renamed`);
  });

  it('deactivates and reactivates a USER', async () => {
    const created = (await createViaApi(newUserPayload())).body.data as UserBody;

    const off = await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { isActive: false },
    });
    expect(off.status).toBe(200);
    expect((off.body.data as UserBody).user.isActive).toBe(false);

    // §19 of the auth brief — requireAuth re-reads the row, so the session dies
    // immediately rather than at token expiry.
    const theirToken = await mintToken(created.user.id, { role: 'USER' });
    const blocked = await api('GET', '/api/auth/me', { token: theirToken });
    expect(blocked.status).toBe(401);

    const on = await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { isActive: true },
    });
    expect((on.body.data as UserBody).user.isActive).toBe(true);
  });

  it('resets a password without ever returning it', async () => {
    const created = (await createViaApi(newUserPayload())).body.data as UserBody;
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: created.user.id },
      select: { passwordHash: true },
    });

    const fresh = `Rotated-${randomUUID().slice(0, 12)}`;
    const res = await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { password: fresh, confirmPassword: fresh },
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(fresh);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: created.user.id },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordHash).not.toBe(fresh);
  });

  it('assigns one module', async () => {
    const created = (await createViaApi(newUserPayload({ modules: ['PRODUCT_ENQUIRY'] })))
      .body.data as UserBody;
    expect(created.user.modules).toEqual(['PRODUCT_ENQUIRY']);
  });

  it('assigns multiple modules', async () => {
    const created = (await createViaApi(newUserPayload({ modules: ['PRODUCT_ENQUIRY', 'SALES'] })))
      .body.data as UserBody;
    expect(created.user.modules.sort()).toEqual(['PRODUCT_ENQUIRY', 'SALES']);
  });

  it('assigns all seven modules', async () => {
    const created = (await createViaApi(newUserPayload({ modules: [...APP_MODULES] })))
      .body.data as UserBody;
    expect(created.user.modules.sort()).toEqual([...APP_MODULES].sort());
  });

  it('changes module access through the dedicated endpoint', async () => {
    const created = (await createViaApi(newUserPayload({ modules: ['SALES'] })))
      .body.data as UserBody;

    const res = await api('PATCH', `/api/users/${created.user.id}/modules`, {
      token: adminToken,
      body: { modules: ['PRODUCT_ENQUIRY', 'POST_SALES'] },
    });

    expect(res.status).toBe(200);
    expect((res.body.data as UserBody).user.modules.sort()).toEqual([
      'POST_SALES',
      'PRODUCT_ENQUIRY',
    ]);
  });

  it('revokes every module, leaving an account with none', async () => {
    const created = (await createViaApi(newUserPayload({ modules: ['PRODUCT_ENQUIRY', 'SALES'] })))
      .body.data as UserBody;

    const res = await api('PATCH', `/api/users/${created.user.id}/modules`, {
      token: adminToken,
      body: { modules: [] },
    });

    expect(res.status).toBe(200);
    expect((res.body.data as UserBody).user.modules).toEqual([]);
  });

  it('reports every module for an ADMIN without any permission rows', async () => {
    const res = await api('GET', `/api/users/${admin.id}`, { token: adminToken });

    expect(res.status).toBe(200);
    expect((res.body.data as UserBody).user.modules.sort()).toEqual([...APP_MODULES].sort());

    // §13 — that access comes from the role, not from stored rows.
    const rows = await prisma.userModulePermission.count({ where: { userId: admin.id } });
    expect(rows).toBe(0);
  });

  it('refuses to edit an administrator’s modules', async () => {
    const res = await api('PATCH', `/api/users/${admin.id}/modules`, {
      token: adminToken,
      body: { modules: ['SALES'] },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ADMIN_MODULES_IMMUTABLE');
  });

  it('refuses to let an administrator deactivate themselves', async () => {
    const res = await api('PATCH', `/api/users/${admin.id}`, {
      token: adminToken,
      body: { isActive: false },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_DEACTIVATE_SELF');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { isActive: true },
    });
    expect(row.isActive).toBe(true);
  });

  it('404s for an unknown user', async () => {
    const ghost = (await makeUser('USER')).id;
    await prisma.user.delete({ where: { id: ghost } });

    const res = await api('GET', `/api/users/${ghost}`, { token: adminToken });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
//  §16/§17 — the ordinary user
// ---------------------------------------------------------------------------

describe('USER is refused every administrative action', () => {
  it('cannot list users', async () => {
    const res = await api('GET', '/api/users', { token: userToken });
    expect(res.status).toBe(403);
  });

  it('cannot read one user', async () => {
    const res = await api('GET', `/api/users/${admin.id}`, { token: userToken });
    expect(res.status).toBe(403);
  });

  it('cannot create a user', async () => {
    const before = await prisma.user.count();

    const res = await api('POST', '/api/users', { token: userToken, body: newUserPayload() });
    expect(res.status).toBe(403);

    expect(await prisma.user.count()).toBe(before);
  });

  it('cannot edit another user', async () => {
    const res = await api('PATCH', `/api/users/${admin.id}`, {
      token: userToken,
      body: { name: 'hijacked' },
    });
    expect(res.status).toBe(403);
  });

  it('cannot edit themselves through the admin API', async () => {
    const res = await api('PATCH', `/api/users/${user.id}`, {
      token: userToken,
      body: { name: 'self-service' },
    });
    expect(res.status).toBe(403);
  });

  it('cannot grant modules to themselves', async () => {
    const res = await api('PATCH', `/api/users/${user.id}/modules`, {
      token: userToken,
      body: { modules: [...APP_MODULES] },
    });
    expect(res.status).toBe(403);

    const rows = await prisma.userModulePermission.count({ where: { userId: user.id } });
    expect(rows).toBe(0);
  });

  it('cannot grant modules to another user', async () => {
    const victim = await makeUser('USER');

    const res = await api('PATCH', `/api/users/${victim.id}/modules`, {
      token: userToken,
      body: { modules: ['SALES'] },
    });
    expect(res.status).toBe(403);

    expect(await prisma.userModulePermission.count({ where: { userId: victim.id } })).toBe(0);
  });

  it('is refused before validation, so a malformed body still 403s', async () => {
    const res = await api('POST', '/api/users', { token: userToken, body: { nonsense: true } });
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await api('GET', '/api/users');
    expect(res.status).toBe(401);
  });

  it('is refused on every verb the router exposes', async () => {
    // The guard sits on the router rather than on each route, so this is really
    // asserting that no route was added without it.
    const calls: [string, string][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', `/api/users/${admin.id}`],
      ['PATCH', `/api/users/${admin.id}`],
      ['PATCH', `/api/users/${admin.id}/modules`],
    ];

    for (const [method, path] of calls) {
      // GET may not carry a body; the write verbs get an empty one so the
      // request is well-formed and the 403 is the guard's doing, not a parse
      // failure.
      const res = await api(method, path, {
        token: userToken,
        ...(method === 'GET' ? {} : { body: {} }),
      });
      expect(res.status).toBe(403);
    }
  });
});

describe('privilege escalation is impossible', () => {
  it('ignores role in a create payload rather than honouring it', async () => {
    // The schema has no role field, so this key is stripped. The account is
    // still created — as a USER, which is the point.
    const res = await createViaApi(newUserPayload({ role: 'ADMIN' }));

    expect(res.status).toBe(201);
    const created = (res.body.data as UserBody).user;
    expect(created.role).toBe('USER');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
      select: { role: true },
    });
    expect(row.role).toBe('USER');
  });

  it('ignores role in an update payload', async () => {
    const created = (await createViaApi(newUserPayload())).body.data as UserBody;

    await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { name: `${TEST_PREFIX}-still-a-user`, role: 'ADMIN' },
    });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: created.user.id },
      select: { role: true },
    });
    expect(row.role).toBe('USER');
  });

  it('does not let a USER promote themselves by any exposed route', async () => {
    for (const body of [{ role: 'ADMIN' }, { isActive: true, role: 'ADMIN' }]) {
      const res = await api('PATCH', `/api/users/${user.id}`, { token: userToken, body });
      expect(res.status).toBe(403);
    }

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { role: true },
    });
    expect(row.role).toBe('USER');
  });
});

// ---------------------------------------------------------------------------
//  §16 — module access is enforced by the API, not by the sidebar
// ---------------------------------------------------------------------------

describe('module access is enforced server-side', () => {
  /** Creates a USER holding exactly `modules`, and a token for them. */
  async function personWith(modules: string[]): Promise<{ id: string; token: string }> {
    const res = await createViaApi(newUserPayload({ modules }));
    const created = (res.body.data as UserBody).user;
    return { id: created.id, token: await mintToken(created.id, { role: 'USER' }) };
  }

  it('lets a person with Product Enquiry access reach it', async () => {
    const person = await personWith(['PRODUCT_ENQUIRY']);
    const res = await api('GET', '/api/product-enquiries', { token: person.token });
    expect(res.status).toBe(200);
  });

  it('refuses Product Enquiry to a person without it', async () => {
    const person = await personWith(['SALES']);

    expect((await api('GET', '/api/product-enquiries', { token: person.token })).status).toBe(403);
    expect((await api('POST', '/api/product-enquiries', { token: person.token, body: {} })).status)
      .toBe(403);
  });

  it('lets a person with Sales access reach it', async () => {
    const person = await personWith(['SALES']);
    const res = await api('GET', '/api/sales', { token: person.token });
    expect(res.status).toBe(200);
  });

  it('refuses Sales to a person without it', async () => {
    const person = await personWith(['PRODUCT_ENQUIRY']);

    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(403);
    expect((await api('POST', '/api/sales', { token: person.token, body: {} })).status).toBe(403);
  });

  it('refuses both modules to a person with none', async () => {
    const person = await personWith([]);

    expect((await api('GET', '/api/product-enquiries', { token: person.token })).status).toBe(403);
    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(403);
  });

  it('opens a module the moment an administrator grants it', async () => {
    const person = await personWith([]);
    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(403);

    await api('PATCH', `/api/users/${person.id}/modules`, {
      token: adminToken,
      body: { modules: ['SALES'] },
    });

    // No new sign-in: permissions are resolved per request, not carried in the
    // token, so the same bearer now works.
    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(200);
  });

  it('closes a module the moment an administrator revokes it', async () => {
    const person = await personWith(['PRODUCT_ENQUIRY', 'SALES']);
    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(200);

    await api('PATCH', `/api/users/${person.id}/modules`, {
      token: adminToken,
      body: { modules: ['PRODUCT_ENQUIRY'] },
    });

    expect((await api('GET', '/api/sales', { token: person.token })).status).toBe(403);
    // The module that was kept is untouched.
    expect((await api('GET', '/api/product-enquiries', { token: person.token })).status).toBe(200);
  });

  it('reports the granted modules through /api/auth/me, which drives the sidebar', async () => {
    const person = await personWith(['PRODUCT_ENQUIRY', 'SALES']);

    const res = await api('GET', '/api/auth/me', { token: person.token });
    expect(res.status).toBe(200);

    const { permissions } = res.body.data as {
      permissions: { module: string; action: string; allowed: boolean }[];
    };
    const canView = (module: string) =>
      permissions.some((p) => p.module === module && p.action === 'VIEW' && p.allowed);

    expect(canView('PRODUCT_ENQUIRY')).toBe(true);
    expect(canView('SALES')).toBe(true);
    expect(canView('PROCUREMENT')).toBe(false);
    expect(canView('CUSTOMER_BILLING')).toBe(false);
  });

  it('grants view, create and edit but never delete or assign', async () => {
    const person = await personWith(['SALES']);

    const res = await api('GET', '/api/auth/me', { token: person.token });
    const { permissions } = res.body.data as {
      permissions: { module: string; action: string; allowed: boolean }[];
    };
    const allowed = (action: string) =>
      permissions.find((p) => p.module === 'SALES' && p.action === action)?.allowed;

    expect(allowed('VIEW')).toBe(true);
    expect(allowed('CREATE')).toBe(true);
    expect(allowed('EDIT')).toBe(true);
    // Deleting and reassigning stay administrative (§22 of the original brief).
    expect(allowed('DELETE')).toBe(false);
    expect(allowed('ASSIGN')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  §17 — passwords
// ---------------------------------------------------------------------------

describe('password handling', () => {
  it('never returns a password or hash from any user-management response', async () => {
    const created = await createViaApi(newUserPayload({ modules: ['SALES'] }));
    const id = (created.body.data as UserBody).user.id;

    const responses = [
      created,
      await api('GET', '/api/users', { token: adminToken }),
      await api('GET', `/api/users/${id}`, { token: adminToken }),
      await api('PATCH', `/api/users/${id}`, {
        token: adminToken,
        body: { name: `${TEST_PREFIX}-renamed-again` },
      }),
      await api('PATCH', `/api/users/${id}/modules`, {
        token: adminToken,
        body: { modules: ['SALES'] },
      }),
    ];

    for (const response of responses) {
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('$2b$');
      expect(raw).not.toContain(PASSWORD);
    }
  });

  it('records the password change in the audit trail without the value', async () => {
    const created = (await createViaApi(newUserPayload())).body.data as UserBody;

    const fresh = `Audited-${randomUUID().slice(0, 12)}`;
    await api('PATCH', `/api/users/${created.user.id}`, {
      token: adminToken,
      body: { password: fresh, confirmPassword: fresh },
    });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'user.updated', entityId: created.user.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.newValue)).not.toContain(fresh);
    expect(JSON.stringify(entry?.newValue)).toContain('passwordChanged');
  });

  it('rejects a password shorter than the minimum', async () => {
    const res = await createViaApi(newUserPayload({ password: 'short', confirmPassword: 'short' }));
    expect(res.status).toBe(422);
  });

  it('lets a created user actually sign in with the password they were given', async () => {
    const payload = newUserPayload();
    const created = (await createViaApi(payload)).body.data as UserBody;

    const res = await api('POST', '/api/auth/login', {
      body: { email: payload.email, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect((res.body.data as { user: { id: string } }).user.id).toBe(created.user.id);
  });
});
