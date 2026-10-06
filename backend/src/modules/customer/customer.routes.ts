import { Router } from 'express';
import { createCustomerSchema, customerSearchSchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './customer.controller.js';

export const customerRoutes = Router();

customerRoutes.use(requireAuth);

/**
 * Guarded on PRODUCT_ENQUIRY rather than a module of its own: AppModule has no
 * CUSTOMER value and the approved enum is not being changed. These endpoints
 * exist to serve enquiry and order creation, so whoever may create one may look
 * up or add the customer it belongs to.
 *
 * CREATE rather than VIEW on the search, and that is the point of the change.
 * This endpoint returns every customer's name, phone and email in full, so
 * leaving it on VIEW made it a way straight round the redaction Product Enquiry
 * applies to its own payloads: an Answerer holds VIEW, and could simply ask the
 * directory for what the enquiry would not tell them.
 *
 * `requireAnyPermission` because the picker serves several modules. Gating on
 * PRODUCT_ENQUIRY CREATE alone would have broken the customer picker for
 * somebody who works in Sales and never touches enquiries.
 *
 * POST_SALES CREATE joins them for the same reason: raising a grievance case
 * starts by finding the customer who raised it, and this is the only customer
 * search in the CRM. CREATE rather than VIEW, following the rule above — a
 * Post Sales reader who may not raise a case has no need of the full directory.
 */
customerRoutes.get(
  '/',
  requireAnyPermission(
    ['PRODUCT_ENQUIRY', 'CREATE'],
    ['SALES', 'CREATE'],
    ['POST_SALES', 'CREATE'],
  ),
  validate({ query: customerSearchSchema }),
  controller.search,
);

customerRoutes.post(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'CREATE'),
  validate({ body: createCustomerSchema }),
  controller.create,
);
