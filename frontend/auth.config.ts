/**
 * Session cookie and JWT settings, kept apart from the provider so the Edge
 * middleware can import them without pulling in anything Node-only.
 */

const isProduction = process.env.NODE_ENV === 'production';

/** §12 — eight hours. Defined in @rs/shared so both tiers use one value. */
export { SESSION_MAX_AGE_SECONDS } from '@rs/shared';

/**
 * §13 — an explicit cookie name so both tiers agree on it, with the __Secure-
 * prefix in production (browsers reject that prefix unless Secure is set, which
 * makes downgrade attacks fail loudly rather than silently).
 */
export const SESSION_COOKIE_NAME = isProduction
  ? '__Secure-royalstuffs.session-token'
  : 'royalstuffs.session-token';

export const sessionCookieOptions = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  path: '/' as const,
  secure: isProduction,
};
