/**
 * "Is the configured Shopify store reachable, and do our credentials work?"
 *
 * One question, answered by actually asking Shopify rather than by inspecting
 * configuration: a client id that is present but wrong looks identical to a
 * correct one until a request is made.
 *
 * The lightest authenticated call is the shop record itself, which every
 * Admin API token can read and which returns in one request. No product data is
 * fetched — that is a later phase.
 *
 * What leaves this module is deliberately narrow: connected, the store domain,
 * the API version, the granted scopes and the shop's own name. The access token
 * and the client secret never appear in the return value, and never will.
 */

import { env, shopifyConfigured } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/AppError.js';
import { clearCachedToken, getAccessToken, getGrantedScope } from './token.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** Everything the CRM is willing to say about the Shopify connection. */
export type ShopifyConnectionStatus = {
  connected: boolean;
  /** Null when the integration is not configured at all. */
  storeDomain: string | null;
  apiVersion: string;
  /** The scopes Shopify granted, e.g. "read_products,read_inventory". */
  scope: string | null;
  /** The shop's display name, once a call has succeeded. */
  shopName: string | null;
  /** A stable code when not connected, for the UI to branch on. */
  reason: string | null;
};

type ShopResponse = { shop?: { name?: unknown; myshopify_domain?: unknown } };

/** The Admin API base for the configured store and pinned version. */
function adminApiBase(): string {
  return `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;
}

/**
 * Performs one authenticated Admin API GET.
 *
 * Exported because later phases need the same token handling and 401 recovery;
 * Phase 3 uses it only for the shop record.
 */
export async function shopifyAdminGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();

  const call = async (accessToken: string): Promise<Response> =>
    fetch(`${adminApiBase()}${path}`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await call(token);

    // A token can die before its stated expiry — credentials rotated, app
    // uninstalled. One retry with a fresh token distinguishes that from a
    // genuinely bad configuration.
    if (response.status === 401) {
      clearCachedToken();
      response = await call(await getAccessToken());
    }
  } catch (error) {
    logger.error(
      { err: error, store: env.SHOPIFY_STORE_DOMAIN, path },
      'Shopify Admin API request failed',
    );
    throw new AppError('SHOPIFY_UNREACHABLE', 502, 'Could not reach Shopify. Try again shortly.');
  }

  if (!response.ok) {
    logger.error(
      { status: response.status, store: env.SHOPIFY_STORE_DOMAIN, path },
      'Shopify Admin API returned an error',
    );

    if (response.status === 401 || response.status === 403) {
      throw new AppError('SHOPIFY_AUTH_FAILED', 502, 'Shopify rejected the configured credentials.');
    }
    throw new AppError('SHOPIFY_API_ERROR', 502, 'Shopify could not complete the request.');
  }

  return (await response.json()) as T;
}

/**
 * The connection status, safe to hand to an administrator.
 *
 * Never throws for an expected outcome: "not configured" and "credentials
 * rejected" are answers, not errors, because the screen asking is a diagnostic
 * screen and a 500 would tell it less than a reason code does.
 */
export async function checkConnection(): Promise<ShopifyConnectionStatus> {
  const base: ShopifyConnectionStatus = {
    connected: false,
    storeDomain: env.SHOPIFY_STORE_DOMAIN ?? null,
    apiVersion: env.SHOPIFY_API_VERSION,
    scope: null,
    shopName: null,
    reason: null,
  };

  if (!shopifyConfigured()) {
    return { ...base, storeDomain: env.SHOPIFY_STORE_DOMAIN ?? null, reason: 'NOT_CONFIGURED' };
  }

  try {
    const payload = await shopifyAdminGet<ShopResponse>('/shop.json');
    const shopName = typeof payload.shop?.name === 'string' ? payload.shop.name : null;

    return {
      ...base,
      connected: true,
      scope: await getGrantedScope(),
      shopName,
      reason: null,
    };
  } catch (error) {
    // An AppError carries a code chosen above; anything else is unexpected and
    // is reported generically rather than leaking its message.
    const reason = error instanceof AppError ? error.code : 'SHOPIFY_UNKNOWN_ERROR';
    if (!(error instanceof AppError)) {
      logger.error({ err: error }, 'Unexpected failure while checking the Shopify connection');
    }
    return { ...base, reason };
  }
}
