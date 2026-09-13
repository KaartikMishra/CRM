/**
 * Shopify access tokens — obtained server-side, held in memory, never stored.
 *
 * The flow is the client credentials grant: the app exchanges its own client id
 * and secret for a token. It applies because the app and the store belong to
 * the same Shopify organisation, which is the documented condition for it. That
 * means no authorization-code round trip, no consent screen, no redirect URI
 * and no callback route — there is no third-party merchant to ask.
 *
 * Why memory rather than a database row:
 *
 *   - the token lives 24 hours (Shopify returns expires_in 86399) and can be
 *     re-requested at any moment from credentials we already hold, so a
 *     persisted copy buys nothing a restart cannot rebuild in one HTTP call;
 *   - a stored token is a stored credential — a row to encrypt, rotate, leak
 *     through a backup, or return by accident in a careless select. Not keeping
 *     it is strictly safer than keeping it well;
 *   - the deployment is a single backend process, so there is no second
 *     instance that would benefit from sharing one.
 *
 * Consequently Phase 3 adds no model, no column and no migration.
 *
 * Neither the secret nor the token is ever logged or returned. The only things
 * that leave this module are a token handed to another backend module, and
 * errors that name no credential.
 */

import { env, shopifyConfigured } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';

/** Shopify's token endpoint, per the client credentials grant. */
const tokenPath = '/admin/oauth/access_token';

/**
 * Re-request this long before the stated expiry.
 *
 * A token that expires mid-request is an avoidable 401, and the clock here and
 * Shopify's are not the same clock. Five minutes is ample against a 24-hour
 * lifetime and costs one extra request per day.
 */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

/** How long to wait on Shopify before giving up. */
const REQUEST_TIMEOUT_MS = 10_000;

type CachedToken = {
  accessToken: string;
  /** Epoch milliseconds after which the token must not be reused. */
  expiresAt: number;
  scope: string;
};

let cached: CachedToken | null = null;
/**
 * The request currently in flight, if any.
 *
 * Two requests arriving on a cold cache should produce one token request, not
 * two: both await the same promise. Without this a burst of traffic after a
 * restart would hammer Shopify's token endpoint.
 */
let inFlight: Promise<CachedToken> | null = null;

/** Shape of a successful token response. Anything else is rejected. */
type TokenResponse = {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
};

function assertConfigured(): void {
  if (!shopifyConfigured()) {
    throw new AppError(
      'SHOPIFY_NOT_CONFIGURED',
      503,
      'The Shopify connection is not configured.',
    );
  }
}

/** True when a usable token is held, allowing for the renewal margin. */
function isFresh(token: CachedToken | null): token is CachedToken {
  return token !== null && Date.now() + RENEW_MARGIN_MS < token.expiresAt;
}

async function requestToken(): Promise<CachedToken> {
  assertConfigured();

  const url = `https://${env.SHOPIFY_STORE_DOMAIN}${tokenPath}`;

  // Form-encoded, as the grant requires. The secret appears here and nowhere
  // else: not in a log line, not in an error, not in a response.
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SHOPIFY_CLIENT_ID as string,
    client_secret: env.SHOPIFY_CLIENT_SECRET as string,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A network failure, DNS problem or timeout. The cause is logged without
    // the request body, which holds the secret.
    logger.error(
      { err: error, store: env.SHOPIFY_STORE_DOMAIN },
      'Could not reach Shopify to request an access token',
    );
    throw new AppError(
      'SHOPIFY_UNREACHABLE',
      502,
      'Could not reach Shopify. Try again shortly.',
    );
  }

  if (!response.ok) {
    // Status and store only. Shopify's body on a 401 can echo back request
    // parameters, so it is deliberately not logged or forwarded.
    logger.error(
      { status: response.status, store: env.SHOPIFY_STORE_DOMAIN },
      'Shopify refused the access token request',
    );

    if (response.status === 401 || response.status === 403 || response.status === 400) {
      throw new AppError(
        'SHOPIFY_AUTH_FAILED',
        502,
        'Shopify rejected the configured credentials.',
      );
    }

    throw new AppError('SHOPIFY_TOKEN_ERROR', 502, 'Shopify could not issue an access token.');
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    throw new AppError('SHOPIFY_TOKEN_ERROR', 502, 'Shopify returned an unreadable response.');
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new AppError('SHOPIFY_TOKEN_ERROR', 502, 'Shopify returned no access token.');
  }

  // Shopify documents expires_in as 86399. Treated as advisory rather than
  // assumed: a missing or nonsensical value falls back to one hour, which
  // renews more often than needed but never uses a token past its life.
  const expiresInSeconds =
    typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? payload.expires_in
      : 3600;

  const token: CachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
  };

  // Scope and lifetime are safe to record; the token itself is not.
  logger.info(
    { store: env.SHOPIFY_STORE_DOMAIN, scope: token.scope, expiresInSeconds },
    'Shopify access token acquired',
  );

  return token;
}

/**
 * A usable access token, reusing the cached one whenever it is still good.
 *
 * Backend only. The return value must never be placed in an API response.
 */
export async function getAccessToken(): Promise<string> {
  if (isFresh(cached)) {
    return cached.accessToken;
  }

  // Collapse concurrent misses onto one request.
  inFlight ??= requestToken()
    .then((token) => {
      cached = token;
      return token;
    })
    .finally(() => {
      inFlight = null;
    });

  const token = await inFlight;
  return token.accessToken;
}

/** The scopes Shopify granted, once a token has been obtained. */
export async function getGrantedScope(): Promise<string> {
  await getAccessToken();
  return cached?.scope ?? '';
}

/**
 * Discards the cached token.
 *
 * Used when Shopify answers 401 to an API call — the token is dead earlier than
 * its stated expiry — and by tests, which must not inherit each other's cache.
 */
export function clearCachedToken(): void {
  cached = null;
  inFlight = null;
}

/**
 * Whether a live token is currently held. Diagnostics only; never the token.
 */
export function hasCachedToken(): boolean {
  return isFresh(cached);
}
