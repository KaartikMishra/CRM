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

  /**
   * A plain USER holds SALES:CREATE by role default, and the catalogue list
   * admits that capability so the Sales order picker can search — so the
   * employee fixture reaches the list without any RS_PRODUCTS grant.
   *
   * Denial is therefore asserted against somebody holding none of the admitted
   * capabilities, which is what the rule actually says. The tests below pin
   * each half of it.
   *
   * The two Procurement pairs joined the list when it became clear that
   * Procurement depends on this same search: a purchase line must name an
   * RsProduct before its stock can be allocated, and the one shared picker is
   * how it is named. It worked only because a USER holds SALES:CREATE by
   * default, so revoking Sales from a warehouse-only employee silently took
   * their mapping dialog with it.
   */
  it('denies a caller holding none of the admitted capabilities', async () => {
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'EDIT', allowed: false },
      ],
    });

    const res = await api('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits a USER on RS_PRODUCTS:VIEW alone, with Sales revoked', async () => {
    // The Vendor Invoices path: somebody granted the catalogue but not Sales.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
      ],
    });

    const granted = await api<Listed>('GET', '/api/rs-products', { token: employeeToken });
    expect(granted.status).toBe(200);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits a USER on SALES:CREATE alone, with RS Products revoked', async () => {
    // The Sales picker path, and the reason this route was widened: a
    // salesperson can search the catalogue without holding the module.
    await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
    });

    const res = await api<Listed>('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(200);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits a USER on PROCUREMENT:EDIT alone, with RS Products and Sales revoked', async () => {
    // The mapping dialog: a buyer naming the RS Product a bill line is for.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'EDIT', allowed: true },
      ],
    });

    const res = await api<Listed>('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(200);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits a USER on PROCUREMENT:CREATE alone, with RS Products and Sales revoked', async () => {
    // Typing up a purchase bill, whose lines name products as they are entered
    // — so CREATE is named as well as EDIT, or a recorder who may not edit
    // would be left with an empty picker.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'CREATE', allowed: true },
      ],
    });

    const res = await api<Listed>('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(200);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('does not admit PROCUREMENT:VIEW on its own', async () => {
    // Named capabilities, not "anyone who can see the module". Somebody who may
    // only read Procurement gains no catalogue search from it.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'VIEW', allowed: true },
      ],
    });

    const res = await api('GET', '/api/rs-products', { token: employeeToken });
    expect(res.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('still refuses every write to somebody holding only PROCUREMENT', async () => {
    // The widening is read-only on this side too: a buyer may find a product
    // and still may not create, edit or archive one.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
        { userId: employee.id, module: 'SALES', action: 'CREATE', allowed: false },
        { userId: employee.id, module: 'PROCUREMENT', action: 'EDIT', allowed: true },
      ],
    });

    const created = await api('POST', '/api/rs-products', {
      token: employeeToken,
      body: { title: 'zz-test-should-never-exist', price: '1.00' },
    });
    expect(created.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('still refuses every write to somebody holding only SALES:CREATE', async () => {
    // The widening is read-only. A salesperson may find a product and still may
    // not create, edit or archive one.
    await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: false },
    });

    const created = await api('POST', '/api/rs-products', {
      token: employeeToken,
      body: { title: 'zz-test-should-never-exist', price: '1.00' },
    });
    expect(created.status).toBe(403);

    const edited = await api('PATCH', '/api/rs-products/clx0000000000000000000000', {
      token: employeeToken,
      body: { title: 'zz-test-nope' },
    });
    expect(edited.status).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
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
