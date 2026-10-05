/**
 * The route table for Create Lead / Deal, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for LEAD_DEAL — the
 * module's own value, added to the AppModule enum for this feature rather than
 * borrowed from Sales or Product Enquiry. A lead is its own kind of work with
 * its own people; gating it on another module's permission would mean granting
 * access to that module to do this job.
 *
 * USER holds nothing on LEAD_DEAL by default, so a plain employee reaches this
 * only once an administrator grants it through the existing overrides screen.
 *
 * Literal paths are declared before any parameterised one, so
 * `/customer-lookup` is never read as a lead id.
 */

import { Router } from 'express';
import { createLeadSchema, leadCustomerLookupSchema, leadIdParamSchema } from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './lead.controller.js';

export const leadRoutes = Router();

leadRoutes.use(requireAuth);

/**
 * The phone lookup the create form runs as somebody types.
 *
 * VIEW rather than CREATE: it answers "does this number belong to anybody",
 * which is reading the customer directory, and somebody who may see the module
 * may see that. Creating the lead below is the privileged half.
 */
leadRoutes.get(
  '/customer-lookup',
  requirePermission('LEAD_DEAL', 'VIEW'),
  validate({ query: leadCustomerLookupSchema }),
  controller.lookupCustomer,
);

leadRoutes.post(
  '/',
  requirePermission('LEAD_DEAL', 'CREATE'),
  validate({ body: createLeadSchema }),
  controller.createLead,
);

leadRoutes.get(
  '/:id',
  requirePermission('LEAD_DEAL', 'VIEW'),
  validate({ params: leadIdParamSchema }),
  controller.getLead,
);
