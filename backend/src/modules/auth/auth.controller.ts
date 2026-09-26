import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
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

  /*
    The seller's own registered State travels with the session.

    It is server configuration, so the browser has no other way to know it — and
    without it the new-order form cannot tell an intra-state sale from an
    inter-state one, and showed CGST + SGST for every Indian customer including
    the ones that owe IGST. This is the app-bootstrap payload and already
    carries the permission matrix, so one app-level field belongs here rather
    than behind a second round trip.

    Still only a preview: every figure that matters is computed server-side from
    this same value, and the created order reports the split the API decided.
    Null when unconfigured, which is exactly what taxSplitFor already handles.
  */
  sendSuccess(res, { ...user, permissions, sellerState: env.SELLER_STATE ?? null });
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
