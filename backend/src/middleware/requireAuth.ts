/**
 * §18–19 — bearer verification, then a live user lookup.
 *
 * The signature proves the token came from the trusted session tier. It does
 * not prove the person is still employed here. A token issued eight hours ago
 * still verifies perfectly after an account is deactivated or demoted, so the
 * current row is read on every request and `isActive` and `role` are taken from
 * the database rather than from the token. This is deliberate: do not remove
 * the lookup to make authentication "stateless".
 */

import type { NextFunction, Request, Response } from 'express';
import { jwtVerify } from 'jose';
import {
  SESSION_JWT_ALG,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_ISSUER,
  type Role,
} from '@rs/shared';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: Role;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const secretKey = () => new TextEncoder().encode(env.AUTH_SECRET);

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;

  const [scheme, token, ...rest] = header.split(' ');
  // Exactly two parts, and the scheme spelled correctly.
  if (rest.length > 0 || scheme?.toLowerCase() !== 'bearer' || !token) return null;

  return token;
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw AppError.unauthorized('Sign in to continue.');
    }

    let subject: string;
    try {
      const { payload } = await jwtVerify(token, secretKey(), {
        algorithms: [SESSION_JWT_ALG],
        issuer: SESSION_JWT_ISSUER,
        audience: SESSION_JWT_AUDIENCE,
      });
      if (!payload.sub) throw new Error('Token carries no subject');
      subject = payload.sub;
    } catch {
      // Bad signature, wrong algorithm, wrong issuer and expiry are one answer:
      // the session is not usable. Saying which would help an attacker tune.
      throw AppError.unauthorized('Your session has expired. Sign in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: subject },
      select: { id: true, name: true, email: true, employeeId: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw AppError.unauthorized('Your session is no longer valid. Sign in again.');
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      employeeId: user.employeeId,
      role: user.role,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** Reads the authenticated user, or fails loudly if requireAuth did not run. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new Error('currentUser() called on a route without requireAuth');
  }
  return req.user;
}
