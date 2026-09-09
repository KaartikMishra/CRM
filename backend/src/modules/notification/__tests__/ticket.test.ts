/**
 * The socket credential.
 *
 * These are the tests that matter most in this feature: the ticket is the only
 * thing standing between the notification stream and anyone who can reach the
 * port. Each case below is a way in that must stay closed.
 *
 * Pure unit tests — no server, no database — so they run in milliseconds and
 * can be exhaustive about the failure modes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { SESSION_JWT_ALG, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from '@rs/shared';
import { env } from '../../../config/env.js';
import {
  consumeTicket,
  mintTicket,
  resetConsumed,
  sweepConsumed,
  TICKET_TTL_SECONDS,
  WS_TICKET_AUDIENCE,
} from '../../../realtime/ticket.js';

const secret = (): Uint8Array => new TextEncoder().encode(env.AUTH_SECRET);

/** Builds a ticket with one property deliberately wrong. */
async function forge(overrides: {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  subject?: string;
  secret?: Uint8Array;
  jti?: string;
}): Promise<string> {
  const builder = new SignJWT({})
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: 'JWT' })
    .setJti(overrides.jti ?? crypto.randomUUID())
    .setSubject(overrides.subject ?? 'user-1')
    .setIssuer(overrides.issuer ?? SESSION_JWT_ISSUER)
    .setAudience(overrides.audience ?? WS_TICKET_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? `${TICKET_TTL_SECONDS}s`);
  return builder.sign(overrides.secret ?? secret());
}

beforeEach(() => resetConsumed());

describe('a valid ticket', () => {
  it('resolves to the user it was minted for', async () => {
    const ticket = await mintTicket('user-42');
    expect(await consumeTicket(ticket)).toBe('user-42');
  });
});

describe('single use', () => {
  it('is spent by the first connection and refused thereafter', async () => {
    const ticket = await mintTicket('user-1');
    expect(await consumeTicket(ticket)).toBe('user-1');
    // The replay a short expiry alone would not stop.
    expect(await consumeTicket(ticket)).toBeNull();
    expect(await consumeTicket(ticket)).toBeNull();
  });

  it('does not let one spent ticket invalidate another', async () => {
    const [a, b] = [await mintTicket('user-1'), await mintTicket('user-2')];
    expect(await consumeTicket(a)).toBe('user-1');
    expect(await consumeTicket(b)).toBe('user-2');
  });

  it('keeps a spent jti for as long as its ticket could still be replayed', async () => {
    /*
      The invariant that makes sweeping safe.

      A jti is remembered until `consumedAt + TTL`; the ticket itself dies at
      `issuedAt + TTL`. A ticket cannot be consumed before it was issued, so
      `consumedAt >= issuedAt` and the memory always outlives the credential.
      The sweep can therefore only drop a jti once its ticket has expired too —
      at which point jwtVerify rejects on `exp` and never reaches the replay
      check at all.

      Only real clock values are used here. Advancing the sweep's clock while
      leaving the JWT's frozen would test a state that cannot occur.
    */
    const ticket = await mintTicket('user-1');
    expect(await consumeTicket(ticket)).toBe('user-1');

    // Sweeping now — the ordinary case, since the timer fires every minute —
    // must not forget a ticket that is still inside its own lifetime.
    sweepConsumed(Date.now());
    expect(await consumeTicket(ticket)).toBeNull();
  });

  it('does not grow without bound — expired entries are dropped', async () => {
    for (let i = 0; i < 5; i += 1) {
      await consumeTicket(await mintTicket(`user-${i}`));
    }
    // Long after every ticket has expired, the entries are collectable.
    sweepConsumed(Date.now() + (TICKET_TTL_SECONDS + 60) * 1000);
    // Nothing to assert on the map directly — it is private — but a fresh
    // ticket must still work, proving the sweep did not corrupt the store.
    const fresh = await mintTicket('user-new');
    expect(await consumeTicket(fresh)).toBe('user-new');
  });
});

describe('rejected credentials', () => {
  it('refuses an expired ticket', async () => {
    expect(await consumeTicket(await forge({ expiresIn: '-1s' }))).toBeNull();
  });

  it('refuses a ticket signed with another secret', async () => {
    const wrong = new TextEncoder().encode('x'.repeat(48));
    expect(await consumeTicket(await forge({ secret: wrong }))).toBeNull();
  });

  it('refuses a ticket from another issuer', async () => {
    expect(await consumeTicket(await forge({ issuer: 'somebody-else' }))).toBeNull();
  });

  it('refuses a session token presented as a socket ticket', async () => {
    // The exact shape requireAuth accepts — right secret, right issuer, wrong
    // audience. This is what stops a stolen session token opening a socket.
    const sessionToken = await forge({ audience: SESSION_JWT_AUDIENCE });
    expect(await consumeTicket(sessionToken)).toBeNull();
  });

  it('refuses garbage and empty strings', async () => {
    for (const bad of ['', 'not-a-jwt', 'a.b.c']) {
      expect(await consumeTicket(bad), bad).toBeNull();
    }
  });
});

describe('audience separation', () => {
  it('mints against the socket audience, never the API one', async () => {
    const ticket = await mintTicket('user-1');
    const [, payload] = ticket.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { aud: string };
    expect(claims.aud).toBe(WS_TICKET_AUDIENCE);
    expect(claims.aud).not.toBe(SESSION_JWT_AUDIENCE);
  });

  it('gives every ticket its own jti', async () => {
    const ids = await Promise.all([1, 2, 3].map(() => mintTicket('user-1')));
    const jtis = ids.map((t) => {
      const [, payload] = t.split('.');
      return (JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { jti: string }).jti;
    });
    expect(new Set(jtis).size).toBe(3);
  });
});
