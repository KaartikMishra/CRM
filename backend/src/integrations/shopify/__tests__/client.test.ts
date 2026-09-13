/**
 * The Shopify Admin GraphQL client.
 *
 * Every HTTP call is mocked; no real credential is used or needed, and the
 * fakes below are obvious nonsense so they can never be mistaken for live
 * values.
 *
 * Two behaviours get the most attention because they are the ones that lose
 * data quietly: a GraphQL `errors` array arriving with HTTP 200, and throttling
 * arriving the same way. Both must be failures, not empty successes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE = {
  store: 'test-store.myshopify.com',
  clientId: 'fake-client-id-for-tests',
  clientSecret: 'fake-client-secret-for-tests',
  apiVersion: '2026-07',
  token: 'fake-access-token-cccccccccccc',
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

const { shopifyAdminGraphQL, adminGraphQLEndpoint } = await import('../client.js');
const { clearCachedToken, hasCachedToken } = await import('../token.js');

const TOKEN_PATH = '/admin/oauth/access_token';

const tokenOk = (): Response =>
  new Response(
    JSON.stringify({ access_token: FAKE.token, scope: 'read_products,read_inventory', expires_in: 86399 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const gqlOk = (data: unknown, cost?: unknown): Response =>
  new Response(
    JSON.stringify({ data, ...(cost ? { extensions: { cost } } : {}) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const defaultCost = {
  requestedQueryCost: 12,
  actualQueryCost: 10,
  throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 },
};

/** Routes token requests vs GraphQL requests; `graphql` may vary per call. */
function mockShopify(graphql: () => Response): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : String(input);
    return Promise.resolve(url.includes(TOKEN_PATH) ? tokenOk() : graphql());
  });
}

const QUERY = 'query Shop { shop { name } }';

beforeEach(() => {
  clearCachedToken();
  logs.length = 0;
  for (const key of Object.keys(testEnv)) delete testEnv[key];
  testEnv.SHOPIFY_STORE_DOMAIN = FAKE.store;
  testEnv.SHOPIFY_CLIENT_ID = FAKE.clientId;
  testEnv.SHOPIFY_CLIENT_SECRET = FAKE.clientSecret;
  testEnv.SHOPIFY_API_VERSION = FAKE.apiVersion;
  // Retries sleep; make them instant without faking the token clock.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCachedToken();
});

describe('a successful query', () => {
  it('returns the data Shopify sent', async () => {
    mockShopify(() => gqlOk({ shop: { name: 'RoyalStuffs' } }, defaultCost));

    const result = await shopifyAdminGraphQL<{ shop: { name: string } }>(QUERY);
    expect(result.data.shop.name).toBe('RoyalStuffs');
  });

  it('posts the query and variables as JSON', async () => {
    const spy = mockShopify(() => gqlOk({ shop: { name: 'RoyalStuffs' } }));

    await shopifyAdminGraphQL(QUERY, { first: 50 });

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    const [, init] = call as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { query: string; variables: unknown };
    expect(body.query).toBe(QUERY);
    expect(body.variables).toEqual({ first: 50 });
  });
});

describe('the endpoint and API version', () => {
  it('builds the endpoint from the configured store and version', () => {
    expect(adminGraphQLEndpoint()).toBe(
      `https://${FAKE.store}/admin/api/${FAKE.apiVersion}/graphql.json`,
    );
  });

  it('uses the configured version, never "latest"', async () => {
    testEnv.SHOPIFY_API_VERSION = '2025-01';
    const spy = mockShopify(() => gqlOk({ ok: true }));

    await shopifyAdminGraphQL(QUERY);

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    expect(String(call?.[0])).toContain('/admin/api/2025-01/graphql.json');
    expect(String(call?.[0])).not.toContain('latest');
  });

  it('reports a 404 as an endpoint/version problem', async () => {
    mockShopify(() => new Response('', { status: 404 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_ENDPOINT_NOT_FOUND',
    });
  });
});

describe('authentication', () => {
  it('sends the token in the Shopify header, never in the URL', async () => {
    const spy = mockShopify(() => gqlOk({ ok: true }));

    await shopifyAdminGraphQL(QUERY);

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    const [url, init] = call as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers['X-Shopify-Access-Token']).toBe(FAKE.token);
    expect(url).not.toContain(FAKE.token);
    expect(url).not.toContain(FAKE.clientSecret);
    // Not an OAuth bearer flow — no Authorization header is involved.
    expect(headers.Authorization).toBeUndefined();
  });

  it('obtains the token through the Phase 3 service, not its own request', async () => {
    const spy = mockShopify(() => gqlOk({ ok: true }));

    await shopifyAdminGraphQL(QUERY);

    const tokenCalls = spy.mock.calls.filter(([u]: unknown[]) => String(u).includes(TOKEN_PATH));
    expect(tokenCalls).toHaveLength(1);
    expect(hasCachedToken()).toBe(true);
  });

  it('reuses the cached token across queries', async () => {
    const spy = mockShopify(() => gqlOk({ ok: true }));

    await shopifyAdminGraphQL(QUERY);
    await shopifyAdminGraphQL(QUERY);
    await shopifyAdminGraphQL(QUERY);

    const tokenCalls = spy.mock.calls.filter(([u]: unknown[]) => String(u).includes(TOKEN_PATH));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-authenticates once when a 401 says the token died early', async () => {
    let graphqlCalls = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(TOKEN_PATH)) return Promise.resolve(tokenOk());
      graphqlCalls += 1;
      return Promise.resolve(
        graphqlCalls === 1 ? new Response('', { status: 401 }) : gqlOk({ ok: true }),
      );
    });

    const result = await shopifyAdminGraphQL<{ ok: boolean }>(QUERY);

    expect(result.data.ok).toBe(true);
    expect(spy.mock.calls.filter(([u]: unknown[]) => String(u).includes(TOKEN_PATH))).toHaveLength(2);
  });

  it('gives up when a second 401 follows the retry', async () => {
    mockShopify(() => new Response('', { status: 401 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_AUTH_FAILED',
    });
  });

  it('refuses to run at all when Shopify is not configured', async () => {
    delete testEnv.SHOPIFY_CLIENT_ID;
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_NOT_CONFIGURED',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('HTTP failures', () => {
  it('treats 403 as a scope problem and does not retry it', async () => {
    const spy = mockShopify(() => new Response('', { status: 403 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({ code: 'SHOPIFY_FORBIDDEN' });

    const graphqlCalls = spy.mock.calls.filter(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    expect(graphqlCalls).toHaveLength(1);
  });

  it('retries a 5xx and succeeds when Shopify recovers', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(TOKEN_PATH)) return Promise.resolve(tokenOk());
      calls += 1;
      return Promise.resolve(calls < 3 ? new Response('', { status: 503 }) : gqlOk({ ok: true }));
    });

    const result = await shopifyAdminGraphQL<{ ok: boolean }>(QUERY);
    expect(result.data.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up on a persistent 5xx', async () => {
    mockShopify(() => new Response('', { status: 500 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({ code: 'SHOPIFY_API_ERROR' });
  });

  it('reports a network failure as unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(TOKEN_PATH)) return Promise.resolve(tokenOk());
      return Promise.reject(new Error('socket hang up'));
    });

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_UNREACHABLE',
    });
  });

  it('rejects an unreadable body', async () => {
    mockShopify(() => new Response('<html>not json</html>', { status: 200 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_INVALID_RESPONSE',
    });
  });
});

describe('rate limiting', () => {
  it('retries a 429 and honours Retry-After', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(TOKEN_PATH)) return Promise.resolve(tokenOk());
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : gqlOk({ ok: true }),
      );
    });

    const result = await shopifyAdminGraphQL<{ ok: boolean }>(QUERY);
    expect(result.data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('gives up on persistent 429 with a rate-limit code', async () => {
    mockShopify(() => new Response('', { status: 429 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_RATE_LIMITED',
    });
  });

  it('treats a THROTTLED GraphQL error as throttling, not success', async () => {
    // Shopify reports throttling inside a 200 body. Returning that as an empty
    // success is how a sync silently loses a page.
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(TOKEN_PATH)) return Promise.resolve(tokenOk());
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(
              JSON.stringify({
                errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
                extensions: { cost: defaultCost },
              }),
              { status: 200 },
            )
          : gqlOk({ ok: true }),
      );
    });

    const result = await shopifyAdminGraphQL<{ ok: boolean }>(QUERY);
    expect(result.data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('surfaces a rate-limit error when throttling never clears', async () => {
    mockShopify(() =>
      new Response(
        JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
        { status: 200 },
      ),
    );

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_RATE_LIMITED',
    });
  });

  it('exposes throttle metadata so a caller can pace itself', async () => {
    mockShopify(() => gqlOk({ ok: true }, defaultCost));

    const result = await shopifyAdminGraphQL(QUERY);

    expect(result.cost?.requestedQueryCost).toBe(12);
    expect(result.cost?.actualQueryCost).toBe(10);
    expect(result.cost?.throttleStatus).toEqual({
      maximumAvailable: 2000,
      currentlyAvailable: 1990,
      restoreRate: 100,
    });
  });

  it('tolerates a response with no cost extension', async () => {
    mockShopify(() => gqlOk({ ok: true }));

    const result = await shopifyAdminGraphQL(QUERY);
    expect(result.cost).toBeNull();
  });
});

describe('GraphQL-level failures', () => {
  it('fails on an errors array even though HTTP said 200', async () => {
    mockShopify(() =>
      new Response(
        JSON.stringify({ errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }] }),
        { status: 200 },
      ),
    );

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_GRAPHQL_ERROR',
      statusCode: 502,
    });
  });

  it('does not retry a query error — the next attempt would fail identically', async () => {
    const spy = mockShopify(() =>
      new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 }),
    );

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toThrow();

    const graphqlCalls = spy.mock.calls.filter(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    expect(graphqlCalls).toHaveLength(1);
  });

  it('fails when there are neither errors nor data', async () => {
    mockShopify(() => new Response(JSON.stringify({ data: null }), { status: 200 }));

    await expect(shopifyAdminGraphQL(QUERY)).rejects.toMatchObject({
      code: 'SHOPIFY_EMPTY_RESPONSE',
    });
  });
});

describe('pagination is the caller\'s, and the client carries it faithfully', () => {
  it('forwards first/after cursors unchanged', async () => {
    const spy = mockShopify(() =>
      gqlOk({
        products: {
          edges: [{ cursor: 'c1', node: { id: 'gid://shopify/Product/1' } }],
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
        },
      }),
    );

    const result = await shopifyAdminGraphQL<{
      products: { pageInfo: { hasNextPage: boolean; endCursor: string } };
    }>('query Products($first: Int!, $after: String) { products(first: $first, after: $after) { pageInfo { hasNextPage endCursor } } }', {
      first: 250,
      after: 'previous-cursor',
    });

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    const body = JSON.parse((call as unknown as [string, RequestInit])[1].body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({ first: 250, after: 'previous-cursor' });

    // And the caller reads pageInfo off its own typed result.
    expect(result.data.products.pageInfo.hasNextPage).toBe(true);
    expect(result.data.products.pageInfo.endCursor).toBe('c1');
  });

  it('passes a null cursor through for the first page', async () => {
    const spy = mockShopify(() => gqlOk({ products: { edges: [] } }));

    await shopifyAdminGraphQL(QUERY, { first: 10, after: null });

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    const body = JSON.parse((call as unknown as [string, RequestInit])[1].body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({ first: 10, after: null });
  });
});

describe('credentials never escape', () => {
  it('keeps the token and secret out of every returned result', async () => {
    mockShopify(() => gqlOk({ shop: { name: 'RoyalStuffs' } }, defaultCost));

    const serialized = JSON.stringify(await shopifyAdminGraphQL(QUERY));
    expect(serialized).not.toContain(FAKE.token);
    expect(serialized).not.toContain(FAKE.clientSecret);
  });

  it('keeps them out of every thrown error', async () => {
    const responses: Array<() => Response> = [
      () => new Response('', { status: 403 }),
      () => new Response('', { status: 404 }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ errors: [{ message: FAKE.clientSecret }] }), { status: 200 }),
      () => new Response(JSON.stringify({ data: null }), { status: 200 }),
    ];

    for (const make of responses) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);
      clearCachedToken();
      mockShopify(make);

      const error = await shopifyAdminGraphQL(QUERY).catch((e: unknown) => e);
      const text = `${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;

      expect(text).not.toContain(FAKE.token);
      expect(text).not.toContain(FAKE.clientSecret);
    }
  });

  it('keeps them out of the logs', async () => {
    mockShopify(() => gqlOk({ ok: true }, defaultCost));
    await shopifyAdminGraphQL(QUERY);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    clearCachedToken();
    mockShopify(() => new Response('', { status: 403 }));
    await shopifyAdminGraphQL(QUERY).catch(() => undefined);

    const written = JSON.stringify(logs);
    expect(written).not.toContain(FAKE.token);
    expect(written).not.toContain(FAKE.clientSecret);
  });

  it('never sends the client secret to the GraphQL endpoint', async () => {
    const spy = mockShopify(() => gqlOk({ ok: true }));

    await shopifyAdminGraphQL(QUERY, { note: 'anything' });

    const call = spy.mock.calls.find(([u]: unknown[]) => !String(u).includes(TOKEN_PATH));
    const [url, init] = call as unknown as [string, RequestInit];
    const everything = `${url} ${JSON.stringify(init.headers)} ${String(init.body)}`;
    expect(everything).not.toContain(FAKE.clientSecret);
  });
});
