import type { Request, Response } from 'express';
import type { LoginInput } from '@rs/shared';
import { sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { effectivePermissions } from '../../services/permission.service.js';
import { recordAudit } from '../../services/audit.service.js';
import { authenticate } from './auth.service.js';

/**
 * §7 — NextAuth's authorize() calls this. It returns the safe identity only;
 * NextAuth turns that into a session. No token is minted here.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const credentials = validatedBody<LoginInput>(req);
  const user = await authenticate(req, credentials);
  sendSuccess(res, { user });
}

/**
 * The identity the frontend renders, plus the resolved permission matrix.
 * Permissions are computed here rather than carried in the JWT (§28), so a
 * revoked capability takes effect on the next request instead of in eight hours.
 */
export async function me(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const permissions = await effectivePermissions(user.id, user.role);
  sendSuccess(res, { ...user, permissions });
}

/**
 * The session itself is destroyed by Auth.js on the frontend; this exists so the
 * event is recorded in the same audit trail as sign-in.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await recordAudit(req, {
    action: 'auth.logout',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
  });
  sendSuccess(res, { signedOut: true });
}
