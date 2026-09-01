/**
 * §20–21 — authorization as middleware, never as an if-statement in a
 * controller. A route declares the capability it needs and the resolver answers
 * from role defaults plus per-user overrides.
 */

import type { NextFunction, Request, Response } from 'express';
import type { AppModule, PermissionAction } from '@rs/shared';
import { resolvePermission } from '../services/permission.service.js';
import { AppError } from '../utils/AppError.js';
import { currentUser } from './requireAuth.js';

export function requirePermission(module: AppModule, action: PermissionAction) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = currentUser(req);
      const allowed = await resolvePermission(user.id, user.role, module, action);

      if (!allowed) {
        throw AppError.forbidden('You do not have access to this action.');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** One module/action pair, as accepted by requireAnyPermission. */
export type Capability = readonly [AppModule, PermissionAction];

/**
 * Passes when the caller holds *any* of the listed capabilities.
 *
 * For endpoints genuinely shared by more than one module — image upload is the
 * only one today, serving both Product Enquiry and Sales. Duplicating the route
 * per module would mean two Cloudinary paths and two places to fix a bug, and
 * inventing a pseudo-module would change the approved AppModule enum.
 *
 * Each pair resolves through the same per-user override mechanism as
 * requirePermission, so a UserModulePermission row still applies. Checks run in
 * order and stop at the first that passes.
 */
export function requireAnyPermission(...capabilities: Capability[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = currentUser(req);

      for (const [module, action] of capabilities) {
        if (await resolvePermission(user.id, user.role, module, action)) {
          next();
          return;
        }
      }

      throw AppError.forbidden('You do not have access to this action.');
    } catch (error) {
      next(error);
    }
  };
}

/**
 * For capabilities that are not module-scoped — user management and permission
 * administration (§22). AppModule covers the seven CRM modules only, and adding
 * a pseudo-module to it would change the approved enum.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (currentUser(req).role !== 'ADMIN') {
      throw AppError.forbidden('This action is restricted to administrators.');
    }
    next();
  } catch (error) {
    next(error);
  }
}
