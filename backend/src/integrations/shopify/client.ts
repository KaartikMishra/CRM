/**
 * The Shopify Admin GraphQL client — backend only.
 *
 * One place where a Shopify query becomes an HTTP request: authentication,
 * version pinning, error translation, throttle handling and retries all live
 * here so that a caller in a later phase writes a query and a type, nothing
 * more.
 *
 * Token acquisition is *not* reimplemented. It belongs to token.ts, which owns
 * the client credentials grant and the cache; this module only asks for the
 * current token and hands back a dead one when Shopify says so.
 *
 * Two things never leave this module: the access token and the client secret.
 * They are attached to a request header and forgotten. Errors carry a status
 * and a code, never a credential, and the error type is the CRM's own AppError
 * so callers handle Shopify failures exactly as they handle any other.
 *
 * GraphQL rather than REST because Shopify's REST Admin API is legacy for
 * products, and because one GraphQL query can fetch a product with its
 * variants, images and inventory items — where REST needs a request per
 * concern and burns the rate limit doing it.
 */

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import { clearCachedToken, getAccessToken } from './token.js';

/** How long to wait on one Shopify request. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How many times a request may be retried.
 *
 * Applies only to failures that are safe and sensible to repeat: throttling and
 * Shopify-side 5xx. A rejected credential or a malformed query is never
 * retried — the second attempt would fail identically.
 */
const MAX_RETRIES = 3;

/** Base for exponential backoff when Shopify gives no Retry-After. */
const BACKOFF_BASE_MS = 1000;

/** Ceiling on any single wait, so a bad Retry-After cannot stall a request. */
const MAX_BACKOFF_MS = 10_000;

/**
 * Shopify's GraphQL throttle state, as reported in `extensions.cost`.
 *
 * The Admin API is metered by query cost against a leaky bucket rather than by
 * request count, so this — not a request counter — is what tells a caller
 * whether it can afford the next page.
 */
export type ShopifyThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};

export type ShopifyCost = {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ShopifyThrottleStatus | null;
};

/** A successful GraphQL response: the data, plus what it cost to get it. */
export type ShopifyGraphQLResult<T> = {
  data: T;
  cost: ShopifyCost | null;
};

type GraphQLError = {
  message?: unknown;
  extensions?: { code?: unknown } | null;
};

type GraphQLEnvelope<T> = {
  data?: T | null;
  errors?: GraphQLError[] | null;
  extensions?: { cost?: unknown } | null;
};

/** The Admin GraphQL endpoint for the configured store and pinned version. */
export function adminGraphQLEndpoint(): string {
  return `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
}

/** Reads `extensions.cost`, tolerating its absence or a changed shape. */
function parseCost(extensions: GraphQLEnvelope<unknown>['extensions']): ShopifyCost | null {
  const cost = extensions?.cost as Record<string, unknown> | undefined;
  if (!cost || typeof cost !== 'object') return null;

  const throttle = cost.throttleStatus as Record<string, unknown> | undefined;

  return {
    requestedQueryCost: Number(cost.requestedQueryCost ?? 0),
    actualQueryCost:
      typeof cost.actualQueryCost === 'number' ? cost.actualQueryCost : null,
    throttleStatus:
      throttle && typeof throttle === 'object'
        ? {
            maximumAvailable: Number(throttle.maximumAvailable ?? 0),
            currentlyAvailable: Number(throttle.currentlyAvailable ?? 0),
            restoreRate: Number(throttle.restoreRate ?? 0),
          }
        : null,
  };
}

/** True when the GraphQL errors indicate throttling rather than a bad query. */
function isThrottled(errors: GraphQLError[]): boolean {
  // Shopify reports throttling inside a 200 response, not as a 429.
  return errors.some(
    (error) =>
      (typeof error.extensions?.code === 'string' &&
        error.extensions.code.toUpperCase() === 'THROTTLED') ||
      (typeof error.message === 'string' && /throttl/i.test(error.message)),
  );
}

/** How long to wait before attempt `attempt`, honouring Retry-After. */
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs one Admin GraphQL query.
 *
 * `variables` is where pagination lives: a caller passes `first` and `after`,
 * reads `pageInfo.hasNextPage` and `endCursor` off its own typed result, and
 * calls again. This module deliberately does not own that loop — paging policy
 * differs per resource and belongs with the caller.
 *
 * Throws AppError on every failure. Never returns partial data silently: a
 * GraphQL `errors` array is a failure even when the HTTP status is 200, which
 * is the trap this wrapper exists to close.
 */
export async function shopifyAdminGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<ShopifyGraphQLResult<T>> {
  // Delegated: token.ts owns the grant, the cache and the renewal margin.
  let token = await getAccessToken();

  let lastThrottleError: AppError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(adminGraphQLEndpoint(), {
        method: 'POST',
        headers: {
          // Header only — never a query parameter, which would land in access
          // logs and proxy caches.
          'X-Shopify-Access-Token': token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.error(
        { err: error, store: env.SHOPIFY_STORE_DOMAIN },
        'Shopify GraphQL request could not be sent',
      );
      throw new AppError('SHOPIFY_UNREACHABLE', 502, 'Could not reach Shopify. Try again shortly.');
    }

    // --- transport-level outcomes ------------------------------------------

    if (response.status === 401) {
      // The token died before its stated expiry: rotated credentials, or the
      // app reinstalled. Re-request once; a second 401 is a real failure.
      if (attempt === 0) {
        clearCachedToken();
        token = await getAccessToken();
        continue;
      }
      logger.error({ store: env.SHOPIFY_STORE_DOMAIN }, 'Shopify rejected the access token');
      throw new AppError('SHOPIFY_AUTH_FAILED', 502, 'Shopify rejected the configured credentials.');
    }

    if (response.status === 403) {
      // Authenticated but not permitted — almost always a missing scope, which
      // no retry can fix.
      logger.error({ store: env.SHOPIFY_STORE_DOMAIN }, 'Shopify refused the request (scope?)');
      throw new AppError(
        'SHOPIFY_FORBIDDEN',
        502,
        'Shopify refused the request. The app may be missing a required scope.',
      );
    }

    if (response.status === 404) {
      // For GraphQL this means the endpoint itself is wrong — nearly always an
      // API version that does not exist.
      logger.error(
        { store: env.SHOPIFY_STORE_DOMAIN, apiVersion: env.SHOPIFY_API_VERSION },
        'Shopify GraphQL endpoint not found — check SHOPIFY_API_VERSION',
      );
      throw new AppError(
        'SHOPIFY_ENDPOINT_NOT_FOUND',
        502,
        'The Shopify API endpoint was not found. Check the configured API version.',
      );
    }

    if (response.status === 429 || response.status >= 500) {
      const wait = backoffMs(attempt, response.headers.get('retry-after'));
      const code = response.status === 429 ? 'SHOPIFY_RATE_LIMITED' : 'SHOPIFY_API_ERROR';

      if (attempt < MAX_RETRIES) {
        logger.warn(
          { status: response.status, attempt: attempt + 1, waitMs: wait },
          'Shopify asked us to back off — retrying',
        );
        await sleep(wait);
        continue;
      }

      logger.error(
        { status: response.status, store: env.SHOPIFY_STORE_DOMAIN },
        'Shopify request failed after retries',
      );
      throw new AppError(
        code,
        502,
        response.status === 429
          ? 'Shopify is rate limiting the connection. Try again shortly.'
          : 'Shopify could not complete the request.',
      );
    }

    if (!response.ok) {
      logger.error(
        { status: response.status, store: env.SHOPIFY_STORE_DOMAIN },
        'Shopify returned an unexpected status',
      );
      throw new AppError('SHOPIFY_API_ERROR', 502, 'Shopify could not complete the request.');
    }

    // --- body-level outcomes -----------------------------------------------

    let envelope: GraphQLEnvelope<T>;
    try {
      envelope = (await response.json()) as GraphQLEnvelope<T>;
    } catch {
      throw new AppError('SHOPIFY_INVALID_RESPONSE', 502, 'Shopify returned an unreadable response.');
    }

    const cost = parseCost(envelope.extensions);
    const errors = envelope.errors ?? [];

    if (errors.length > 0) {
      // Throttling arrives as a 200 with an errors array — the single most
      // common way a naive GraphQL client silently loses data.
      if (isThrottled(errors)) {
        lastThrottleError = new AppError(
          'SHOPIFY_RATE_LIMITED',
          502,
          'Shopify is rate limiting the connection. Try again shortly.',
        );

        if (attempt < MAX_RETRIES) {
          const wait = backoffMs(attempt, null);
          logger.warn(
            { attempt: attempt + 1, waitMs: wait, throttle: cost?.throttleStatus },
            'Shopify throttled the query — retrying',
          );
          await sleep(wait);
          continue;
        }
        throw lastThrottleError;
      }

      // A real query error: wrong field, bad argument, missing permission.
      // Messages are Shopify's description of *our* query, never credentials,
      // but they are logged rather than returned so nothing unexpected reaches
      // a browser.
      const messages = errors
        .map((error) => (typeof error.message === 'string' ? error.message : 'unknown'))
        .join('; ');
      logger.error({ store: env.SHOPIFY_STORE_DOMAIN, messages }, 'Shopify GraphQL returned errors');

      throw new AppError('SHOPIFY_GRAPHQL_ERROR', 502, 'Shopify rejected the request.');
    }

    if (envelope.data === null || envelope.data === undefined) {
      // No errors and no data is not success; treating it as success is how a
      // sync ends up writing empty records.
      throw new AppError('SHOPIFY_EMPTY_RESPONSE', 502, 'Shopify returned no data.');
    }

    return { data: envelope.data, cost };
  }

  // Only reachable if every attempt was a retry that ran out.
  throw (
    lastThrottleError ??
    new AppError('SHOPIFY_API_ERROR', 502, 'Shopify could not complete the request.')
  );
}
