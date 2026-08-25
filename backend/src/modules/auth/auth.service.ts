/**
 * §8 — Express owns the authentication truth.
 *
 * Everything that decides whether a person may sign in happens here: the user
 * lookup, the isActive check, the bcrypt comparison and the audit record.
 * NextAuth calls this and takes the answer; it never reaches the database.
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Request } from 'express';
import type { LoginInput } from '@rs/shared';
import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';

/** The identity NextAuth is allowed to see. Nothing sensitive appears here. */
export type SafeUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: 'ADMIN' | 'USER';
};

/**
 * A bcrypt hash of a value nobody knows, compared against when the email does
 * not exist. Without it a missing user fails in ~1ms while a wrong password
 * takes ~200ms, and that timing gap alone enumerates the staff directory (§9).
 * Generated at boot rather than hardcoded, so it is always a valid hash at the
 * same cost factor as the real ones.
 */
const TIMING_EQUALISER_HASH = bcrypt.hashSync(randomUUID(), 12);

/** §9 — one message for every failure mode, so nothing can be enumerated. */
function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 401, 'Email or password is incorrect.');
}

export async function authenticate(req: Request, input: LoginInput): Promise<SafeUser> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      employeeId: true,
      role: true,
      isActive: true,
      passwordHash: true,
    },
  });

  if (!user) {
    // Burn the same time a real comparison would take before failing.
    await bcrypt.compare(input.password, TIMING_EQUALISER_HASH);
    await recordAudit(req, {
      action: 'auth.login.failed',
      entityType: 'User',
      newValue: { email: input.email, reason: 'NO_SUCH_USER' },
    });
    throw invalidCredentials();
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);

  if (!passwordMatches) {
    await recordAudit(req, {
      action: 'auth.login.failed',
      entityType: 'User',
      entityId: user.id,
      newValue: { email: input.email, reason: 'BAD_PASSWORD' },
    });
    throw invalidCredentials();
  }

  // Checked after the password so a deactivated account cannot be distinguished
  // from a wrong password by response timing. The audit record keeps the real
  // reason available to an administrator.
  if (!user.isActive) {
    await recordAudit(req, {
      action: 'auth.login.denied',
      entityType: 'User',
      entityId: user.id,
      newValue: { email: input.email, reason: 'INACTIVE' },
    });
    throw invalidCredentials();
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  await recordAudit(req, {
    action: 'auth.login.success',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    newValue: { employeeId: user.employeeId },
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    employeeId: user.employeeId,
    role: user.role,
  };
}
