/**
 * Auth.js configuration — Next.js owns the session, Express owns the truth.
 *
 * Two things here are deliberate and worth reading before changing:
 *
 * 1. `authorize()` is a thin HTTP client. It does not touch Prisma, does not
 *    compare bcrypt hashes and holds no authentication rules. Express decides;
 *    this function only relays the answer (§7).
 *
 * 2. `jwt.encode`/`jwt.decode` are overridden. Auth.js encrypts its session
 *    token as a JWE by default, which Express cannot verify with an HS256
 *    signature check. The approved architecture (§12, §18) specifies HS256
 *    signed with AUTH_SECRET, so the token is produced as a plain JWS here and
 *    verified with the same secret on the Express side.
 */

import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { SignJWT, jwtVerify } from 'jose';
import {
  SESSION_JWT_ALG,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_ISSUER,
  loginSchema,
} from '@rs/shared';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
} from './auth.config';

type Role = 'ADMIN' | 'USER';

declare module 'next-auth' {
  interface Session {
    user: { id: string; role: Role; employeeId: string } & DefaultSession['user'];
  }
  interface User {
    role: Role;
    employeeId: string;
  }
}

/** The extra claims this app puts on the session token. */
type AppClaims = {
  sub?: string;
  name?: string | null;
  email?: string | null;
  role?: Role;
  employeeId?: string;
};

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is not set');
  }
  return new TextEncoder().encode(secret);
}

const backendUrl = () => process.env.BACKEND_URL ?? 'http://localhost:4000';

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: '/login' },
  trustHost: true,
  cookies: {
    sessionToken: { name: SESSION_COOKIE_NAME, options: sessionCookieOptions },
  },

  providers: [
    Credentials({
      credentials: { email: {}, password: {} },

      async authorize(raw) {
        // Shape-check before spending a network call; Express validates again.
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;

        const response = await fetch(`${backendUrl()}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.data),
        });

        // Any failure is null: Auth.js turns that into a generic sign-in error,
        // which keeps §9's no-enumeration guarantee intact on this side too.
        if (!response.ok) return null;

        const payload = (await response.json()) as {
          success: boolean;
          data?: { user?: { id: string; name: string; email: string; employeeId: string; role: Role } };
        };

        const user = payload.data?.user;
        if (!payload.success || !user) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          employeeId: user.employeeId,
        };
      },
    }),
  ],

  callbacks: {
    // §28 — identity only. No permission matrix, no secrets; the backend
    // resolves permissions against the live database on every request.
    jwt({ token, user }) {
      if (user) {
        const claims = token as AppClaims;
        claims.sub = user.id;
        claims.role = user.role;
        claims.employeeId = user.employeeId;
      }
      return token;
    },
    session({ session, token }) {
      const claims = token as AppClaims;
      session.user.id = claims.sub ?? '';
      session.user.role = claims.role ?? 'USER';
      session.user.employeeId = claims.employeeId ?? '';
      return session;
    },
  },

  jwt: {
    async encode({ token }) {
      if (!token) throw new Error('No token to encode');
      const claims = token as AppClaims;
      return await new SignJWT({
        name: claims.name,
        email: claims.email,
        role: claims.role,
        employeeId: claims.employeeId,
      })
        .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: 'JWT' })
        .setSubject(claims.sub ?? '')
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience(SESSION_JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
        .sign(secretKey());
    },

    async decode({ token }) {
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, secretKey(), {
          algorithms: [SESSION_JWT_ALG],
          issuer: SESSION_JWT_ISSUER,
          audience: SESSION_JWT_AUDIENCE,
        });
        return payload as never;
      } catch {
        // An unverifiable cookie is treated as no session at all.
        return null;
      }
    },
  },
});
