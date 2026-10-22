/**
 * The edge redirect, and why it stops.
 *
 * A session cookie keeps a valid HS256 signature after the user row it names is
 * deleted or deactivated. `proxy.ts` reads the signature; an application page
 * reads `/api/auth/me`, which reads the database. So the two layers can disagree
 * about whether somebody is signed in — and when they did, each sent the browser
 * to the other:
 *
 *     /dashboard -> /login   (the API refused the session)
 *     /login -> /dashboard   (the signature is still good)
 *
 * which the browser reports as ERR_TOO_MANY_REDIRECTS. These tests assert the
 * handshake that breaks it: a refused page marks the redirect with `from`, and
 * the edge stands down when it sees that marker.
 *
 * The decision is reimplemented here rather than imported because `proxy.ts`
 * exports the `auth()`-wrapped handler, which needs Auth.js's full request
 * context. What matters — and what regressed — is the branch condition, so that
 * is what is pinned, and `decide` is kept a line-for-line mirror of it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type Outcome = { redirectTo: string } | { pass: true };

/** Mirror of the branch logic in proxy.ts. */
function decide(input: { signedIn: boolean; url: string }): Outcome {
  const { pathname, searchParams } = new URL(input.url, 'http://localhost:3000');

  if (!input.signedIn && pathname.startsWith('/dashboard')) {
    return { redirectTo: `/login?from=${encodeURIComponent(pathname)}` };
  }
  if (input.signedIn && pathname === '/login' && !searchParams.has('from')) {
    return { redirectTo: '/dashboard' };
  }
  return { pass: true };
}

/** Follows redirects the way a browser would, so a cycle shows up as a cycle. */
function followChain(
  start: string,
  opts: { signedIn: boolean; pageRefuses: boolean },
  maxHops = 12,
): string[] {
  const chain: string[] = [];
  let url = start;

  for (let hop = 0; hop < maxHops; hop++) {
    chain.push(url);

    const edge = decide({ signedIn: opts.signedIn, url });
    if ('redirectTo' in edge) {
      url = edge.redirectTo;
      continue;
    }

    // The edge let it through; now the page guard runs.
    const { pathname } = new URL(url, 'http://localhost:3000');
    if (pathname.startsWith('/dashboard') && opts.pageRefuses) {
      url = '/login?from=%2Fdashboard';
      continue;
    }
    return chain;
  }

  chain.push('…LOOP');
  return chain;
}

describe('the stale-cookie loop', () => {
  const stale = { signedIn: true, pageRefuses: true };

  it('terminates instead of cycling', () => {
    const chain = followChain('/dashboard', stale);
    expect(chain).not.toContain('…LOOP');
  });

  it('comes to rest on the login page', () => {
    const chain = followChain('/dashboard', stale);
    expect(chain[chain.length - 1]).toBe('/login?from=%2Fdashboard');
  });

  it('takes exactly one hop to get there', () => {
    // /dashboard -> /login?from=... and no further. A longer chain would mean
    // the edge bounced it back at least once.
    expect(followChain('/dashboard', stale)).toEqual([
      '/dashboard',
      '/login?from=%2Fdashboard',
    ]);
  });

  it('leaves the login page alone once the marker is present', () => {
    // The exact branch that used to close the cycle.
    expect(decide({ signedIn: true, url: '/login?from=%2Fdashboard' })).toEqual({ pass: true });
  });

  it('honours the generic marker used by the shared module guard', () => {
    // requireModule/requireAdminUser serve many routes, so they send ?from=1.
    expect(decide({ signedIn: true, url: '/login?from=1' })).toEqual({ pass: true });
  });
});

describe('a valid session is unaffected', () => {
  const valid = { signedIn: true, pageRefuses: false };

  it('still bounces a signed-in visitor off /login to the dashboard', () => {
    expect(decide({ signedIn: true, url: '/login' })).toEqual({ redirectTo: '/dashboard' });
  });

  it('reaches the dashboard and stays there', () => {
    expect(followChain('/dashboard', valid)).toEqual(['/dashboard']);
  });

  it('settles on the dashboard when starting from /login', () => {
    expect(followChain('/login', valid)).toEqual(['/login', '/dashboard']);
  });
});

describe('a signed-out visitor', () => {
  const out = { signedIn: false, pageRefuses: true };

  it('is sent to login with the path it wanted', () => {
    expect(decide({ signedIn: false, url: '/dashboard' })).toEqual({
      redirectTo: '/login?from=%2Fdashboard',
    });
  });

  it('can sit on the login page', () => {
    expect(decide({ signedIn: false, url: '/login' })).toEqual({ pass: true });
  });

  it('does not loop either', () => {
    expect(followChain('/dashboard', out)).not.toContain('…LOOP');
  });
});

describe('the source files carry the handshake', () => {
  /*
    `decide` above is a copy, so these assert the real files still implement the
    same rule. If someone drops the `from` check from proxy.ts, or a guard stops
    sending the marker, the loop returns and the tests above would not notice.
  */
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('proxy.ts refuses to redirect /login when the marker is set', () => {
    const src = read('../proxy.ts');
    expect(src).toContain("pathname === '/login'");
    expect(src).toMatch(/!searchParams\.has\(/);
  });

  it('every signed-out redirect carries the marker', () => {
    for (const rel of [
      '../app/(app)/layout.tsx',
      '../app/(app)/dashboard/page.tsx',
      '../lib/require-module.ts',
    ]) {
      const src = read(rel);
      // No bare redirect to /login is left anywhere: that is the loop's return leg.
      expect(src).not.toMatch(/redirect\(['"]\/login['"]\)/);
      expect(src).toMatch(/\/login\?from=/);
    }
  });
});
