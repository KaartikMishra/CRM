/**
 * §27 — route protection at the edge.
 *
 * This is a convenience redirect, not a security boundary: it keeps signed-out
 * people off application pages and signed-in people off the login page. Every
 * actual authorization decision happens in Express (§23).
 */

import { auth } from '@/auth';

export default auth((req) => {
  const signedIn = Boolean(req.auth?.user);
  const { pathname } = req.nextUrl;

  if (!signedIn && pathname.startsWith('/dashboard')) {
    const url = new URL('/login', req.nextUrl);
    url.searchParams.set('from', pathname);
    return Response.redirect(url);
  }

  if (signedIn && pathname === '/login') {
    return Response.redirect(new URL('/dashboard', req.nextUrl));
  }

  return undefined;
});

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
};
