/**
 * The credential that opens a socket.
 *
 * The session token cannot be used here. It lives in an httpOnly cookie scoped
 * to the frontend's origin, so the browser can neither read it nor send it to
 * this backend — and putting a long-lived token into JavaScript to work around
 * that would be worse than the problem.
 *
 * So the client asks an already-authenticated endpoint for a ticket that is
 * useless for anything else: it lives thirty seconds, works once, and carries
 * an audience the REST API rejects. It is signed with the same secret and
 * algorithm as the session token, so this is one authentication system with
 * two non-interchangeable audiences — not a second system.
 *
 * ## Why an expiry alone is not enough
 *
 * A thirty-second token can be replayed as often as you like within those
 * thirty seconds. Expiry bounds the window; it does not close it. Single-use
 * needs server-side memory of which tickets have been spent, which is what
 * `consumed` below is.
 *
 * The check-and-insert is safe without a lock because Node runs one thread:
 * nothing can interleave between reading the set and writing to it. That
 * argument holds for exactly one process — see `consume`.
 */

import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { SESSION_JWT_ALG, SESSION_JWT_ISSUER } from '@rs/shared';
import { env } from '../config/env.js';

/**
 * Deliberately not the API's audience.
 *
 * This is what stops a socket ticket being replayed against the REST API, and
 * a session token being used to open a socket. Both directions are tested.
 */
export const WS_TICKET_AUDIENCE = 'royalstuffs-crm-ws';

/** Long enough to survive a slow page load, short enough to be worthless. */
export const TICKET_TTL_SECONDS = 30;

const secretKey = (): Uint8Array => new TextEncoder().encode(env.AUTH_SECRET);

/**
 * Tickets already spent, with the moment they stop mattering.
 *
 * Bounded by connection rate rather than uptime: an entry is only useful until
 * the ticket would have expired anyway, and the sweep below drops it then. A
 * few hundred bytes at steady state.
 */
const consumed = new Map<string, number>();

/** Removes entries whose tickets have expired and can no longer be replayed. */
export function sweepConsumed(now = Date.now()): void {
  for (const [jti, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(jti);
  }
}

export async function mintTicket(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: 'JWT' })
    .setJti(randomUUID())
    .setSubject(userId)
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(WS_TICKET_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
    .sign(secretKey());
}

/**
 * Verifies a ticket and spends it, returning the user it belongs to.
 *
 * Null for every failure — bad signature, wrong issuer, wrong audience,
 * expired, malformed, or already used. The caller closes the socket without
 * saying which, so this cannot be used to probe what a token is missing.
 *
 * Single-process assumption: `consumed` lives in this process's memory, so a
 * ticket minted here can only be spent here. That is true today (no cluster,
 * no pm2, no worker threads). A second backend instance would let a ticket be
 * replayed against the instance that did not mint it, and this Map would have
 * to become a shared store — the same trigger that would move the connection
 * registry to Redis.
 */
export async function consumeTicket(ticket: string): Promise<string | null> {
  let jti: string | undefined;
  let subject: string | undefined;

  try {
    const { payload } = await jwtVerify(ticket, secretKey(), {
      algorithms: [SESSION_JWT_ALG],
      issuer: SESSION_JWT_ISSUER,
      audience: WS_TICKET_AUDIENCE,
    });
    jti = payload.jti;
    subject = payload.sub;
  } catch {
    return null;
  }

  if (!jti || !subject) return null;

  // Check and claim in one synchronous step. Node's single thread is what
  // makes this atomic; there is no await between the read and the write.
  if (consumed.has(jti)) return null;
  consumed.set(jti, Date.now() + TICKET_TTL_SECONDS * 1000);

  return subject;
}

/** Test-only: forget every spent ticket. */
export function resetConsumed(): void {
  consumed.clear();
}
