/**
 * Authentication and authorization (formerly scratchpad scripts).
 *
 * Covers the login API, requireAuth's verification and live user lookup, and
 * permission resolution through role defaults and per-user overrides.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { prisma } from '../config/database.js';
import { api, mintToken, startTestServer, stopTestServer } from './helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from './helpers/fixtures.js';

let admin: TestUser;
let user: TestUser;
let adminToken: string;
let userToken: string;

/** A password known to this suite, set directly so no seed value is needed. */
const PASSWORD = `Test-${randomUUID()}`;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  user = await makeUser('USER');

  await prisma.user.update({
    where: { id: admin.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  userToken = await mintToken(user.id, { role: 'USER' });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

const login = (body: unknown) => api('POST', '/api/auth/login', { body });

describe('login', () => {
  it('accepts valid credentials and returns the safe identity only', async () => {
    const res = await login({ email: admin.email, password: PASSWORD });

    expect(res.status).toBe(200);
    const returned = res.body.data as { user: Record<string, unknown> };
    expect(Object.keys(returned.user).sort()).toEqual(
      ['email', 'employeeId', 'id', 'name', 'role'].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });

  it('gives an identical answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login({ email: admin.email, password: 'definitely-wrong' });
    const unknownEmail = await login({
      email: `nobody-${randomUUID()}@test.invalid`,
      password: 'definitely-wrong',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.code).toBe(wrongPassword.body.code);
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
  });

  it('refuses a deactivated account with the same generic message', async () => {
    const inactive = await makeUser('USER', false);
    await prisma.user.update({
      where: { id: inactive.id },
      data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });

    const res = await login({ email: inactive.email, password: PASSWORD });
    const wrong = await login({ email: admin.email, password: 'definitely-wrong' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe(wrong.body.message);
  });

  it('validates the request body', async () => {
    expect((await login({ password: 'x' })).status).toBe(422);
    expect((await login({ email: admin.email })).status).toBe(422);
    expect((await login({ email: 'not-an-email', password: 'x' })).status).toBe(422);
  });

  it('records the outcome in the audit trail without the password', async () => {
    await login({ email: admin.email, password: PASSWORD });

    const audits = await prisma.auditLog.findMany({
      where: { entityId: admin.id, action: { startsWith: 'auth.login' } },
      take: 10,
    });

    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
    expect(JSON.stringify(audits)).not.toContain('$2b$');
  });
});

describe('requireAuth', () => {
  const me = (token?: string) => api('GET', '/api/auth/me', token ? { token } : {});

  it.each([
    ['no header', undefined],
    ['bare scheme', 'Bearer'],
    ['wrong scheme', 'Basic abcdef'],
    ['extra parts', 'Bearer a b'],
    ['garbage token', 'Bearer not.a.jwt'],
  ])('refuses %s', async (_label, header) => {
    const res = await api('GET', '/api/auth/me', header ? { headers: { Authorization: header } } : {});
    expect(res.status).toBe(401);
  });

  it('refuses tokens with the wrong secret, issuer, audience or expiry', async () => {
    const variants = await Promise.all([
      mintToken(admin.id, { secret: 'x'.repeat(48) }),
      mintToken(admin.id, { issuer: 'evil' }),
      mintToken(admin.id, { audience: 'other-api' }),
      mintToken(admin.id, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
    ]);

    for (const token of variants) {
      expect((await me(token)).status).toBe(401);
    }
  });

  it('accepts a valid token and returns identity plus permissions', async () => {
    const res = await me(adminToken);
    const data = res.body.data as { employeeId: string; permissions: unknown[] };

    expect(res.status).toBe(200);
    expect(data.employeeId).toBe(admin.employeeId);
    expect(Array.isArray(data.permissions)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('takes the role from the database, not from the token', async () => {
    // A token that *claims* ADMIN for an ordinary employee.
    const forged = await mintToken(user.id, { role: 'ADMIN' });
    const res = await me(forged);

    expect((res.body.data as { role: string }).role).toBe('USER');
  });

  it('invalidates a still-valid token when the account is deactivated', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await me(userToken)).status).toBe(401);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
    expect((await me(userToken)).status).toBe(200);
  });
});

describe('permission resolution', () => {
  const permissions = async (token: string) => {
    const res = await api('GET', '/api/auth/me', { token });
    return (res.body.data as { permissions: { module: string; action: string; allowed: boolean }[] })
      .permissions;
  };
  const has = (
    list: { module: string; action: string; allowed: boolean }[],
    module: string,
    action: string,
  ) => list.find((p) => p.module === module && p.action === action)?.allowed;

  it('applies the approved role defaults', async () => {
    const forAdmin = await permissions(adminToken);
    const forUser = await permissions(userToken);

    expect(has(forAdmin, 'PRODUCT_ENQUIRY', 'ASSIGN')).toBe(true);
    expect(has(forAdmin, 'SALES', 'VIEW')).toBe(true);

    expect(has(forUser, 'PRODUCT_ENQUIRY', 'VIEW')).toBe(true);
    expect(has(forUser, 'PRODUCT_ENQUIRY', 'CREATE')).toBe(true);
    expect(has(forUser, 'PRODUCT_ENQUIRY', 'ASSIGN')).toBe(false);
    expect(has(forUser, 'SALES', 'VIEW')).toBe(false);
  });

  it('lets an override revoke and grant, and falls back when removed', async () => {
    await prisma.userModulePermission.create({
      data: { userId: user.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: false },
    });
    await prisma.userModulePermission.create({
      data: { userId: user.id, module: 'SALES', action: 'VIEW', allowed: true },
    });

    const overridden = await permissions(userToken);
    expect(has(overridden, 'PRODUCT_ENQUIRY', 'CREATE')).toBe(false);
    expect(has(overridden, 'SALES', 'VIEW')).toBe(true);

    await prisma.userModulePermission.deleteMany({ where: { userId: user.id } });

    const restored = await permissions(userToken);
    expect(has(restored, 'PRODUCT_ENQUIRY', 'CREATE')).toBe(true);
    expect(has(restored, 'SALES', 'VIEW')).toBe(false);
  });
});
