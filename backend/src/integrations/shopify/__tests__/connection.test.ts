/**
 * Shopify store connection — the diagnostic the CRM exposes.
 *
 * All Shopify HTTP is mocked; no real credential is used or needed.
 *
 * The point of these is the shape of what comes *back*. checkConnection feeds
 * an API response, so anything it returns is one `sendSuccess` away from a
 * browser. The last block asserts that neither the secret nor the token can
 * appear there, under success or any failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE = {
  store: 'test-store.myshopify.com',
  clientId: 'fake-client-id-for-tests',
  clientSecret: 'fake-client-secret-for-tests',
  apiVersion: '2026-07',
  token: 'fake-access-token-bbbbbbbbbbbb',
};

const testEnv: Record<string, string | undefined> = {};

vi.mock('../../../config/env.js', () => ({
  get env() {
    return {
      SHOPIFY_STORE_DOMAIN: testEnv.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_CLIENT_ID: testEnv.SHOPIFY_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET: testEnv.SHOPIFY_CLIENT_SECRET,
      SHOPIFY_API_VERSION: testEnv.SHOPIFY_API_VERSION ?? '2026-07',
    };
  },
  shopifyConfigured: () =>
    Boolean(
      testEnv.SHOPIFY_STORE_DOMAIN && testEnv.SHOPIFY_CLIENT_ID && testEnv.SHOPIFY_CLIENT_SECRET,
    ),
  isProduction: false,
  isDevelopment: false,
  isTest: true,
}));

const logs: unknown[] = [];
vi.mock('../../../config/logger.js', () => {
  const record = (...args: unknown[]) => {
    logs.push(args);
  };
  return { logger: { info: record, warn: record, error: record, debug: record, fatal: record } };
});

const { checkConnection, shopifyAdminGet } = await import('../connection.js');
const { clearCachedToken } = await import('../token.js');

const tokenOk = (): Response =>
  new Response(
    JSON.stringify({
      access_token: FAKE.token,
      scope: 'read_products,read_inventory',
      expires_in: 86399,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const shopOk = (): Response =>
  new Response(
    JSON.stringify({ shop: { name: 'RoyalStuffs', myshopify_domain: FAKE.store } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** Routes the mock by URL: token endpoint vs Admin API. */
function mockShopify(shopResponse: () => Response, tokenResponse = tokenOk): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(url.includes('/admin/oauth/access_token') ? tokenResponse() : shopResponse());
  });
}

beforeEach(() => {
  clearCachedToken();
  logs.length = 0;
  for (const key of Object.keys(testEnv)) delete testEnv[key];
  testEnv.SHOPIFY_STORE_DOMAIN = FAKE.store;
  testEnv.SHOPIFY_CLIENT_ID = FAKE.clientId;
  testEnv.SHOPIFY_CLIENT_SECRET = FAKE.clientSecret;
  testEnv.SHOPIFY_API_VERSION = FAKE.apiVersion;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCachedToken();
});

describe('a working connection', () => {
  it('reports connected, with safe metadata only', async () => {
    mockShopify(shopOk);

    const status = await checkConnection();

    expect(status.connected).toBe(true);
    expect(status.storeDomain).toBe(FAKE.store);
    expect(status.apiVersion).toBe(FAKE.apiVersion);
    expect(status.scope).toBe('read_products,read_inventory');
    expect(status.shopName).toBe('RoyalStuffs');
    expect(status.reason).toBeNull();
  });

  it('asks the pinned API version, and authenticates with a header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(url.includes('/admin/oauth/access_token') ? tokenOk() : shopOk());
    });

    await checkConnection();

    const adminCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/admin/api/'));
    expect(adminCall).toBeDefined();
    const [url, init] = adminCall as [string, RequestInit];
    expect(url).toBe(`https://${FAKE.store}/admin/api/${FAKE.apiVersion}/shop.json`);

    // The token travels in Shopify's header, never in the query string.
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Shopify-Access-Token']).toBe(FAKE.token);
    expect(url).not.toContain(FAKE.token);
  });

  it('reuses the token across calls rather than re-authenticating', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(url.includes('/admin/oauth/access_token') ? tokenOk() : shopOk());
    });

    await checkConnection();
    await checkConnection();

    const tokenCalls = fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes('/admin/oauth/access_token'),
    );
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('a connection that cannot work', () => {
  it('says NOT_CONFIGURED rather than attempting a call', async () => {
    delete testEnv.SHOPIFY_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const status = await checkConnection();

    expect(status.connected).toBe(false);
    expect(status.reason).toBe('NOT_CONFIGURED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports rejected credentials without throwing', async () => {
    // A diagnostic screen learns more from a reason code than from a 500.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const status = await checkConnection();
    expect(status.connected).toBe(false);
    expect(status.reason).toBe('SHOPIFY_AUTH_FAILED');
  });

  it('reports an Admin API failure after a successful token', async () => {
    mockShopify(() => new Response('', { status: 500 }));

    const status = await checkConnection();
    expect(status.connected).toBe(false);
    expect(status.reason).toBe('SHOPIFY_API_ERROR');
  });

  it('reports an unreachable Shopify', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const status = await checkConnection();
    expect(status.connected).toBe(false);
    expect(status.reason).toBe('SHOPIFY_UNREACHABLE');
  });

  it('still reports the configured domain and version when disconnected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const status = await checkConnection();
    expect(status.storeDomain).toBe(FAKE.store);
    expect(status.apiVersion).toBe(FAKE.apiVersion);
    expect(status.shopName).toBeNull();
  });
});

describe('a token that dies before its stated expiry', () => {
  it('retries once with a fresh token when the API answers 401', async () => {
    // Credentials rotated, or the app reinstalled. One retry distinguishes that
    // from a genuinely bad configuration.
    let adminCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/admin/oauth/access_token')) return Promise.resolve(tokenOk());
      adminCalls += 1;
      return Promise.resolve(adminCalls === 1 ? new Response('', { status: 401 }) : shopOk());
    });

    const status = await checkConnection();

    expect(status.connected).toBe(true);
    expect(adminCalls).toBe(2);
  });

  it('gives up after the retry also fails', async () => {
    mockShopify(() => new Response('', { status: 401 }));

    const status = await checkConnection();
    expect(status.connected).toBe(false);
    expect(status.reason).toBe('SHOPIFY_AUTH_FAILED');
  });
});

describe('shopifyAdminGet', () => {
  it('returns the parsed body for a caller in a later phase', async () => {
    mockShopify(shopOk);

    const body = await shopifyAdminGet<{ shop: { name: string } }>('/shop.json');
    expect(body.shop.name).toBe('RoyalStuffs');
  });

  it('throws an AppError rather than a raw fetch error', async () => {
    mockShopify(() => new Response('', { status: 500 }));

    await expect(shopifyAdminGet('/shop.json')).rejects.toMatchObject({
      code: 'SHOPIFY_API_ERROR',
      statusCode: 502,
    });
  });
});

describe('nothing secret can reach a response', () => {
  it('excludes the secret and token from a successful status', async () => {
    mockShopify(shopOk);

    const serialized = JSON.stringify(await checkConnection());
    expect(serialized).not.toContain(FAKE.clientSecret);
    expect(serialized).not.toContain(FAKE.token);
  });

  it('excludes them from every failure mode too', async () => {
    const failures: Array<() => void> = [
      () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 })),
      () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(FAKE.clientSecret)),
      () => mockShopify(() => new Response(FAKE.token, { status: 500 })),
    ];

    for (const arrange of failures) {
      vi.restoreAllMocks();
      clearCachedToken();
      arrange();

      const serialized = JSON.stringify(await checkConnection());
      expect(serialized).not.toContain(FAKE.clientSecret);
      expect(serialized).not.toContain(FAKE.token);
    }
  });

  it('returns only the documented fields, so nothing can be added by accident', async () => {
    mockShopify(shopOk);

    // A future edit that attached the token to this object would fail here.
    expect(Object.keys(await checkConnection()).sort()).toEqual([
      'apiVersion',
      'connected',
      'reason',
      'scope',
      'shopName',
      'storeDomain',
    ]);
  });

  it('keeps credentials out of the logs', async () => {
    mockShopify(shopOk);
    await checkConnection();

    vi.restoreAllMocks();
    clearCachedToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await checkConnection();

    const written = JSON.stringify(logs);
    expect(written).not.toContain(FAKE.clientSecret);
    expect(written).not.toContain(FAKE.token);
  });
});
