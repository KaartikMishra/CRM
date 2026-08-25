/**
 * §45 — the generic audit trail for anything without an enquiry parent:
 * logins, user management, vendor edits, permission changes.
 *
 * Writes here must never fail a request. An audit write that throws would turn
 * a successful login into a 500, so failures are logged and swallowed.
 */

import type { Request } from 'express';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
};

/** Client fingerprint, used when reviewing authentication events. */
export function requestFingerprint(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
  };
}

export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  const { ip, userAgent } = requestFingerprint(req);

  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        actorId: input.actorId ?? null,
        oldValue: input.oldValue === undefined ? undefined : (input.oldValue as object),
        newValue: input.newValue === undefined ? undefined : (input.newValue as object),
        ip,
        userAgent,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: input.action }, 'Failed to write audit log');
  }
}
