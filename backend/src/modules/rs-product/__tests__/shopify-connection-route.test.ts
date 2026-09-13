/**
 * The Shopify connection endpoint, through the real middleware chain.
 *
 * These run against the actual Express app and the real database, like the
 * other integration suites: the point is the guard, and mocking it would test
 * the mock. Shopify itself is never called — the store is unconfigured in the
 * test environment, so the service short-circuits with NOT_CONFIGURED before
 * any HTTP request. That is the correct behaviour to assert, and it needs no
 * credential.
 *
 * The last block is a repository-wide audit rather than a unit test: it reads
 * the working tree to prove no Shopify credential reaches client code and that
 * .env is not tracked.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type Wrapped = {
  shopify: {
    connected: boolean;
    storeDomain: string | null;
    apiVersion: string;
    scope: string | null;
    shopName: string | null;
    reason: string | null;
  };
};

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

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

describe('access control', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await api('GET', '/api/rs-products/shopify/connection');
    expect(res.status).toBe(401);
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = await mintToken(admin.id, { role: 'ADMIN', secret: 'not-the-real-secret' });
    const res = await api('GET', '/api/rs-products/shopify/connection', { token: forged });
    expect(res.status).toBe(401);
  });

  it('refuses a plain USER, who has no RS Products access by default', async () => {
    const res = await api('GET', '/api/rs-products/shopify/connection', { token: employeeToken });
    expect(res.status).toBe(403);
  });

  it('refuses a USER holding only VIEW — this is an EDIT-level diagnostic', async () => {
    // Reading the catalogue and configuring where it comes from are different
    // privileges, so VIEW deliberately is not enough.
    await prisma.userModulePermission.createMany({
      data: [
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'VIEW', allowed: true },
        { userId: employee.id, module: 'RS_PRODUCTS', action: 'EDIT', allowed: false },
      ],
    });

    expect((await api('GET', '/api/rs-products', { token: employeeToken })).status).toBe(200);
    expect(
      (await api('GET', '/api/rs-products/shopify/connection', { token: employeeToken })).status,
    ).toBe(403);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('admits an administrator, and admits a USER once EDIT is granted', async () => {
    expect(
      (await api('GET', '/api/rs-products/shopify/connection', { token: adminToken })).status,
    ).toBe(200);

    await prisma.userModulePermission.create({
      data: { userId: employee.id, module: 'RS_PRODUCTS', action: 'EDIT', allowed: true },
    });

    expect(
      (await api('GET', '/api/rs-products/shopify/connection', { token: employeeToken })).status,
    ).toBe(200);

    await prisma.userModulePermission.deleteMany({ where: { userId: employee.id } });
  });

  it('is not parsed as a product id', async () => {
    // A literal path declared alongside '/', so a later '/:id' route cannot
    // swallow it.
    const res = await api<Wrapped>('GET', '/api/rs-products/shopify/connection', {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('shopify');
  });
});

describe('the response body', () => {
  it('reports the connection state without any credential', async () => {
    const res = await api<Wrapped>('GET', '/api/rs-products/shopify/connection', {
      token: adminToken,
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data!.shopify).sort()).toEqual([
      'apiVersion',
      'connected',
      'reason',
      'scope',
      'shopName',
      'storeDomain',
    ]);
  });

  it('never carries an access token or a client secret', async () => {
    const res = await api<Wrapped>('GET', '/api/rs-products/shopify/connection', {
      token: adminToken,
    });

    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain('client_secret');
    expect(body).not.toContain('clientsecret');
    expect(body).not.toContain('access_token');
    expect(body).not.toContain('accesstoken');
    // Shopify's own token prefixes, in case one were ever echoed through.
    expect(body).not.toContain('shpat_');
    expect(body).not.toContain('shpss_');
  });
});

describe('RS Products RBAC is unchanged by this phase', () => {
  it('still denies a plain USER the product list', async () => {
    expect((await api('GET', '/api/rs-products', { token: employeeToken })).status).toBe(403);
  });

  it('still admits an administrator to the product list', async () => {
    expect((await api('GET', '/api/rs-products', { token: adminToken })).status).toBe(200);
  });

  it('still reports RS_PRODUCTS in the permission matrix', async () => {
    const res = await api<{ permissions: { module: string; action: string; allowed: boolean }[] }>(
      'GET',
      '/api/auth/me',
      { token: adminToken },
    );
    expect(res.status).toBe(200);
    expect(
      res.body.data!.permissions.some((p) => p.module === 'RS_PRODUCTS' && p.allowed),
    ).toBe(true);
  });
});

describe('existing CRM authentication is unaffected', () => {
  it('still signs in with the documented endpoint', async () => {
    // Shopify auth is a separate server-side integration; it must not have
    // touched the CRM's own session flow.
    const res = await api('POST', '/api/auth/login', {
      body: { email: 'nobody@test.invalid', password: 'definitely-wrong' },
    });
    // Wrong credentials, so 401 — but the route exists and still validates.
    expect(res.status).toBe(401);
  });

  it('still resolves a session from a valid token', async () => {
    // /api/auth/me spreads the user at the top level alongside `permissions`.
    const res = await api<{ id: string; role: string }>('GET', '/api/auth/me', {
      token: adminToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data!.id).toBe(admin.id);
    expect(res.body.data!.role).toBe('ADMIN');
  });

  it('still refuses /api/auth/me without a token', async () => {
    expect((await api('GET', '/api/auth/me')).status).toBe(401);
  });
});

describe('repository-wide credential audit', () => {
  it('keeps .env untracked and unstaged', () => {
    expect(() => git('ls-files', '--error-unmatch', '.env')).toThrow();
    expect(git('diff', '--cached', '--name-only')).not.toContain('.env\n');
  });

  it('has no Shopify credential in any client-side file', () => {
    // Server-side only: no NEXT_PUBLIC_ variable, and no secret in the bundle.
    const tracked = git('ls-files', 'frontend').split('\n').filter(Boolean);
    const clientFiles = tracked.filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

    for (const file of clientFiles) {
      const contents = readFileSync(resolve(repoRoot, file), 'utf8');
      expect(contents, file).not.toContain('SHOPIFY_CLIENT_SECRET');
      expect(contents, file).not.toContain('NEXT_PUBLIC_SHOPIFY');
      expect(contents, file).not.toContain('shpss_');
      expect(contents, file).not.toContain('shpat_');
    }
  });

  it('declares no NEXT_PUBLIC Shopify variable in .env.example', () => {
    const example = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    expect(example).not.toContain('NEXT_PUBLIC_SHOPIFY');
    // The names are documented; the values are blank.
    expect(example).toContain('SHOPIFY_CLIENT_SECRET=\n');
  });

  it('reads the client secret only through validated env, never process.env', () => {
    const root = resolve(repoRoot, 'backend/src');
    const files = git('ls-files', 'backend/src')
      .split('\n')
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'));

    for (const file of files) {
      const contents = readFileSync(resolve(repoRoot, file), 'utf8');
      if (!contents.includes('SHOPIFY_CLIENT_SECRET')) continue;

      // config/env.ts is the one place allowed to name it against process.env.
      if (file.endsWith('backend/src/config/env.ts')) continue;
      expect(contents, `${file} reads the secret outside validated env`).not.toContain(
        'process.env.SHOPIFY',
      );
    }
    expect(root).toBeTruthy();
  });

  it('has no OAuth callback route, because the grant needs none', () => {
    // Client credentials is server-to-server: no redirect, no callback, no
    // Allowed Redirection URL. A callback appearing here would mean the flow
    // changed without the design changing.
    const backend = git('ls-files', 'backend/src')
      .split('\n')
      .filter((f) => f.endsWith('.ts'));

    for (const file of backend) {
      const contents = readFileSync(resolve(repoRoot, file), 'utf8').toLowerCase();
      expect(contents, file).not.toContain('/shopify/callback');
      expect(contents, file).not.toContain('shopify/oauth/callback');
    }
  });
});
