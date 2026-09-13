/**
 * RS Products — the permission gate.
 *
 * Phase 1 ships one endpoint that returns nothing, which makes this suite the
 * point of the phase: the module has to be denied, granted and revoked through
 * the existing mechanism, with no second permission path invented for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_MODULES } from '@rs/shared';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type Listed = { products: { id: string; title: string }[] };

let admin: TestUser;
let employee: TestUser;
let adminToken: string;
let employeeToken: string;

beforeAll(async () => {
  await startTestServer();
  admin = await makeUser('ADMIN');
  employee = await makeUser('USER');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

describe('the module value', () => {
  it('is part of the shared vocabulary', () => {
    expect(APP_MODULES).toContain('RS_PRODUCTS');
  });

  it('is a value the database accepts', async () => {
    // The enum lives in Postgres, so a permission row is the only proof that
    // ALTER TYPE actually ran — a passing typecheck would not show it.
    const row = await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
      select: { module: true },
    });
    expect(row.module).toBe('RS_PRODUCTS');

    await prisma.userModulePermission.deleteMany({
      where: { userId: employee.id, module: 'RS_PRODUCTS' },
    });
  });
});

describe('authentication', () => {
  it('refuses the list without a token', async () => {
    const res = await api('GET', '/api/rs-products');
    expect(res.status).toBe(401);
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = await mintToken(admin.id, {
      role: 'ADMIN',
      secret: 'not-the-real-secret-at-all',
    });
    const res = await api('GET', '/api/rs-products', { token: forged });
    expect(res.status).toBe(401);
  });
});

describe('permission resolution', () => {
  it('admits an administrator by role default', async () => {
    const res = await api<Listed>('GET', '/api/rs-products', { token: adminToken });
    expect(res.status).toBe(200);
  });

  it('denies a plain USER by default', async () => {
    const res = await api('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(403);
  });

  it('admits that USER once an override grants VIEW', async () => {
    await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
    });

    const granted = await api<Listed>('GET', '/api/rs-products', { token: employeeToken });
    expect(granted.status).toBe(200);

    await prisma.userModulePermission.deleteMany({
      where: { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW' },
    });

    const revoked = await api('GET', '/api/rs-products', { token: employeeToken });
    expect(revoked.status).toBe(403);
  });

  it('reports the module in the permission matrix, including for an admin', async () => {
    // effectivePermissions derives its module list from ROLE_DEFAULTS.ADMIN, so
    // a module missing there is invisible to the whole frontend. This is the
    // assertion that catches that omission.
    const res = await api<{
      permissions: { module: string; action: string; allowed: boolean }[];
    }>('GET', '/api/auth/me', { token: adminToken });

    expect(res.status).toBe(200);
    const view = res.body.data!.permissions.find(
      (p) => p.module === 'RS_PRODUCTS' && p.action === 'VIEW',
    );
    expect(view).toBeDefined();
    expect(view!.allowed).toBe(true);
  });
});

describe('the list endpoint', () => {
  it('returns a page of the catalogue with a cursor', async () => {
    // Written in Phase 1, when the repository was a stub and an empty array was
    // the honest answer. The catalogue is populated now, so the assertion is
    // what a page should look like — the listing suite covers the contents.
    const res = await api<Listed>('GET', '/api/rs-products', { token: adminToken });

    expect(res.status).toBe(200);
    expect(res.body.data!.products.length).toBeGreaterThan(0);
    expect(res.body.meta).toHaveProperty('nextCursor');
  });

  it('returns an empty page and a null cursor when nothing matches', async () => {
    const res = await api<Listed>('GET', '/api/rs-products?q=zzzz-no-such-product', {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data!.products).toEqual([]);
    expect(res.body.meta!.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor before reaching the service', async () => {
    const res = await api('GET', '/api/rs-products?cursor=not-a-cuid', { token: adminToken });
    expect(res.status).toBe(422);
  });

  it('rejects a limit beyond the page maximum', async () => {
    const res = await api('GET', '/api/rs-products?limit=9999', { token: adminToken });
    expect(res.status).toBe(422);
  });
});
