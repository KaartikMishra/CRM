import { Router } from 'express';
import { createCustomerSchema, customerSearchSchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './customer.controller.js';

export const customerRoutes = Router();

customerRoutes.use(requireAuth);

/**
 * Guarded on PRODUCT_ENQUIRY rather than a module of its own: AppModule has no
 * CUSTOMER value and the approved enum is not being changed. These endpoints
 * exist to serve enquiry creation, so whoever may view or create an enquiry may
 * look up or add the customer it belongs to.
 */
customerRoutes.get(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'VIEW'),
  validate({ query: customerSearchSchema }),
  controller.search,
);

customerRoutes.post(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'CREATE'),
  validate({ body: createCustomerSchema }),
  controller.create,
);
