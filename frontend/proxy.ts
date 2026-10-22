/**
 * §27 — route protection at the edge.
 *
 * This is a convenience redirect, not a security boundary: it keeps signed-out
 * people off application pages and signed-in people off the login page. Every
 * actual authorization decision happens in Express (§23).
 */

import { auth } from '@/auth';

/**
 * The marker an application page sets when the API refused its session.
 *
 * This exists because the two layers answer "is this person signed in?" from
 * different sources. Here it is the cookie's signature; in a page it is
 * `/api/auth/me`, which asks the database. A signature stays valid after the
 * user row it names is deleted or deactivated, so the two can disagree — and
 * when they did, each sent the browser to the other: /dashboard bounced to
 * /login because the API said no, /login bounced straight back because the
 * signature said yes. That is ERR_TOO_MANY_REDIRECTS.
 *
 * A page that has just been refused says so with this parameter, and the
 * redirect below stands down. The signature is not treated as proof of a live
 * account, because it is not.
 */
const SESSION_REJECTED = 'from';

export default auth((req) => {
  const signedIn = Boolean(req.auth?.user);
  const { pathname, searchParams } = req.nextUrl;

  if (!signedIn && pathname.startsWith('/dashboard')) {
    const url = new URL('/login', req.nextUrl);
    url.searchParams.set(SESSION_REJECTED, pathname);
    return Response.redirect(url);
  }

  /*
    Sending a signed-in visitor on to the application is a convenience, so it
    yields the moment it would contradict a page that has already rejected this
    session. Without the guard this branch is the return half of the loop.
  */
  if (signedIn && pathname === '/login' && !searchParams.has(SESSION_REJECTED)) {
    return Response.redirect(new URL('/dashboard', req.nextUrl));
  }

  return undefined;
});

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
};
