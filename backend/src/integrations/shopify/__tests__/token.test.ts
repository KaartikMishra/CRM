/**
 * Shopify authentication — the token service.
 *
 * Every Shopify HTTP call is mocked. No real credential is present in this
 * file, none is required to run it, and the fake values used here are
 * deliberately obvious nonsense so they can never be mistaken for live ones.
 *
 * The two properties worth protecting are asserted directly rather than
 * inferred: a valid token is reused instead of re-requested, and neither the
 * client secret nor the access token ever leaves the module in an error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Obviously fake. Never a real credential. */
const FAKE = {
  store: 'test-store.myshopify.com',
  clientId: 'fake-client-id-for-tests',
  clientSecret: 'fake-client-secret-for-tests',
  apiVersion: '2026-07',
  token: 'fake-access-token-aaaaaaaaaaaa',
};

/** Mutable env the mocked config module reads, so each test can shape it. */
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

const { getAccessToken, getGrantedScope, clearCachedToken, hasCachedToken } = await import(
  '../token.js'
);

function configureFully(): void {
  testEnv.SHOPIFY_STORE_DOMAIN = FAKE.store;
  testEnv.SHOPIFY_CLIENT_ID = FAKE.clientId;
  testEnv.SHOPIFY_CLIENT_SECRET = FAKE.clientSecret;
  testEnv.SHOPIFY_API_VERSION = FAKE.apiVersion;
}

/** A successful token response, as Shopify documents it. */
function tokenOk(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: FAKE.token,
      scope: 'read_products,read_inventory',
      expires_in: 86399,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  clearCachedToken();
  logs.length = 0;
  for (const key of Object.keys(testEnv)) delete testEnv[key];
  configureFully();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearCachedToken();
});

describe('configuration is required before any request is attempted', () => {
  it('refuses when the client id is missing, without calling Shopify', async () => {
    delete testEnv.SHOPIFY_CLIENT_ID;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(getAccessToken()).rejects.toMatchObject({
      code: 'SHOPIFY_NOT_CONFIGURED',
      statusCode: 503,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when the client secret is missing, without calling Shopify', async () => {
    delete testEnv.SHOPIFY_CLIENT_SECRET;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(getAccessToken()).rejects.toMatchObject({ code: 'SHOPIFY_NOT_CONFIGURED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when the store domain is missing, without calling Shopify', async () => {
    delete testEnv.SHOPIFY_STORE_DOMAIN;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(getAccessToken()).rejects.toMatchObject({ code: 'SHOPIFY_NOT_CONFIGURED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('token acquisition', () => {
  it('requests a token with the client credentials grant', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());

    expect(await getAccessToken()).toBe(FAKE.token);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${FAKE.store}/admin/oauth/access_token`);
    expect(init.method).toBe('POST');

    // The grant Shopify documents for a store in the app's own organisation.
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain(`client_id=${FAKE.clientId}`);
  });

  it('sends the credentials in the body, never in the URL or a header', async () => {
    // A secret in a query string lands in access logs and proxy caches.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());
    await getAccessToken();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(FAKE.clientSecret);
    expect(JSON.stringify(init.headers ?? {})).not.toContain(FAKE.clientSecret);
  });

  it('reports the scopes Shopify granted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());
    expect(await getGrantedScope()).toBe('read_products,read_inventory');
  });
});

describe('caching', () => {
  it('reuses a valid token instead of requesting another', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());

    await getAccessToken();
    await getAccessToken();
    await getAccessToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hasCachedToken()).toBe(true);
  });

  it('collapses concurrent cold-cache calls into one request', async () => {
    // Otherwise a burst of traffic after a restart hammers the token endpoint.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());

    const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('requests a new token once the old one has expired', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenOk({ access_token: 'fake-token-first' }))
      .mockResolvedValueOnce(tokenOk({ access_token: 'fake-token-second' }));

    expect(await getAccessToken()).toBe('fake-token-first');

    // Past the full 24-hour lifetime.
    vi.advanceTimersByTime(86_400 * 1000);

    expect(await getAccessToken()).toBe('fake-token-second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('renews early, before the stated expiry, rather than at it', async () => {
    // Our clock and Shopify's are not the same clock; a token that dies
    // mid-request is an avoidable 401.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenOk({ access_token: 'fake-token-first', expires_in: 600 }))
      .mockResolvedValueOnce(tokenOk({ access_token: 'fake-token-second', expires_in: 600 }));

    await getAccessToken();

    // 7 minutes in: still valid on paper, inside the 5-minute renewal margin.
    vi.advanceTimersByTime(7 * 60 * 1000);

    expect(await getAccessToken()).toBe('fake-token-second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to a short lifetime when expires_in is absent or nonsense', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk({ expires_in: undefined }));

    await getAccessToken();
    expect(hasCachedToken()).toBe(true);

    // The fallback is an hour, so the token must be gone well before a day.
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(hasCachedToken()).toBe(false);
  });

  it('clears the cache on demand', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());
    await getAccessToken();
    expect(hasCachedToken()).toBe(true);

    clearCachedToken();
    expect(hasCachedToken()).toBe(false);
  });
});

describe('failures', () => {
  it('reports rejected credentials as an auth failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_client"}', { status: 401 }),
    );

    await expect(getAccessToken()).rejects.toMatchObject({
      code: 'SHOPIFY_AUTH_FAILED',
      statusCode: 502,
    });
  });

  it('reports a server-side Shopify failure distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(getAccessToken()).rejects.toMatchObject({ code: 'SHOPIFY_TOKEN_ERROR' });
  });

  it('reports an unreachable Shopify as unreachable, not as bad credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(getAccessToken()).rejects.toMatchObject({
      code: 'SHOPIFY_UNREACHABLE',
      statusCode: 502,
    });
  });

  it('rejects a 200 that carries no access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ scope: 'read_products' }), { status: 200 }),
    );

    await expect(getAccessToken()).rejects.toMatchObject({ code: 'SHOPIFY_TOKEN_ERROR' });
  });

  it('rejects an unreadable response body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json at all', { status: 200 }));

    await expect(getAccessToken()).rejects.toMatchObject({ code: 'SHOPIFY_TOKEN_ERROR' });
  });

  it('does not cache anything when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    await expect(getAccessToken()).rejects.toThrow();
    expect(hasCachedToken()).toBe(false);
  });

  it('recovers on the next call after a failure', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(tokenOk());

    await expect(getAccessToken()).rejects.toThrow();
    expect(await getAccessToken()).toBe(FAKE.token);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('credentials never escape the module', () => {
  it('keeps the secret and the token out of every thrown error', async () => {
    const cases: Response[] = [
      new Response(`{"error":"invalid_client","client_secret":"${FAKE.clientSecret}"}`, {
        status: 401,
      }),
      new Response('', { status: 500 }),
      new Response('not json', { status: 200 }),
    ];

    for (const response of cases) {
      clearCachedToken();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(response.clone());

      const error = await getAccessToken().catch((e: unknown) => e);
      const text = `${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;

      expect(text).not.toContain(FAKE.clientSecret);
      expect(text).not.toContain(FAKE.token);
    }
  });

  it('keeps the secret and the token out of every log line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(tokenOk());
    await getAccessToken();

    // Then a failure, which logs too.
    clearCachedToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await getAccessToken().catch(() => undefined);

    const written = JSON.stringify(logs);
    expect(written).not.toContain(FAKE.clientSecret);
    expect(written).not.toContain(FAKE.token);
    // The scope and store are safe, and worth having.
    expect(written).toContain(FAKE.store);
  });
});
