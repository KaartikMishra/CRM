/**
 * §22 — user management, administrators only.
 *
 * Every route below carries requireAuth then requireAdmin. requireAdmin rather
 * than requirePermission because AppModule covers the seven CRM modules only,
 * and user management is not one of them — adding a pseudo-module would change
 * the approved enum. The guard sits on the router itself, so a route added here
 * later cannot be left unprotected by omission.
 */

import { Router } from 'express';
import {
  createUserSchema,
  setUserModulesSchema,
  updateUserSchema,
  userIdParamSchema,
  userListQuerySchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAdmin } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './user.controller.js';

export const userRoutes = Router();

userRoutes.use(requireAuth, requireAdmin);

userRoutes.get('/', validate({ query: userListQuerySchema }), controller.list);

userRoutes.post('/', validate({ body: createUserSchema }), controller.create);

userRoutes.get('/:id', validate({ params: userIdParamSchema }), controller.detail);

userRoutes.patch(
  '/:id',
  validate({ params: userIdParamSchema, body: updateUserSchema }),
  controller.update,
);

/** The module-access grid alone, so a permission change is one clear request. */
userRoutes.patch(
  '/:id/modules',
  validate({ params: userIdParamSchema, body: setUserModulesSchema }),
  controller.setModules,
);
