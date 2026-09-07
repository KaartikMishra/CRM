import { Router } from 'express';
import { createVendorSchema, vendorSearchSchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAnyPermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './vendor.controller.js';

export const vendorRoutes = Router();

vendorRoutes.use(requireAuth);

/**
 * Guarded on PRODUCT_ENQUIRY for the same reason as customers, and now also on
 * PROCUREMENT: a purchase bill names a vendor, and procurement must be able to
 * read the same master rather than grow a second vendor list of its own. The
 * guard widens, so anyone who could reach this before still can.
 */
vendorRoutes.get(
  '/',
  requireAnyPermission(['PRODUCT_ENQUIRY', 'VIEW'], ['PROCUREMENT', 'VIEW']),
  validate({ query: vendorSearchSchema }),
  controller.search,
);

/** The inline "+ Add Vendor" during a vendor response (§37), and when a
 *  purchase bill arrives from a supplier not yet on file. */
vendorRoutes.post(
  '/',
  requireAnyPermission(['PRODUCT_ENQUIRY', 'CREATE'], ['PROCUREMENT', 'CREATE']),
  validate({ body: createVendorSchema }),
  controller.create,
);
