import { Router } from 'express';
import { createVendorSchema, vendorSearchSchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './vendor.controller.js';

export const vendorRoutes = Router();

vendorRoutes.use(requireAuth);

/** Guarded on PRODUCT_ENQUIRY for the same reason as customers. */
vendorRoutes.get(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'VIEW'),
  validate({ query: vendorSearchSchema }),
  controller.search,
);

/** The inline "+ Add Vendor" during a vendor response (§37). */
vendorRoutes.post(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'CREATE'),
  validate({ body: createVendorSchema }),
  controller.create,
);
