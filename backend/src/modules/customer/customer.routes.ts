import { Router } from 'express';
import {
  createCustomerSchema,
  customerDirectoryQuerySchema,
  customerDuplicateDecisionSchema,
  customerDuplicateQuerySchema,
  customerHistoryQuerySchema,
  customerIdParamSchema,
  customerSearchSchema,
} from '@rs/shared';
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

/**
 * All Customers — the directory.
 *
 * A separate path on its own module rather than a widening of `GET /` above.
 * Two reasons, and the first is a contract: the picker is submitted to by
 * Product Enquiry, Create Lead, Sales and Post Sales, and changing what it
 * accepts or returns would change four working modules.
 *
 * The second is access. The picker is gated on CREATE in the module a person is
 * working in, because looking up a customer is part of filing an enquiry or an
 * order. Reading every customer's purchase history, GSTIN and contact details
 * is a different act, so it is a different grant — CUSTOMERS, which USER does
 * not hold by default.
 *
 * Declared BEFORE any `/:id` route, so "directory" and "analytics" are matched
 * as the literal paths they are rather than parsed as a customer id. Express
 * matches in registration order, and a `/:id` route placed above would answer
 * these with a 422 from `cuidSchema`.
 */
customerRoutes.get(
  '/directory',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ query: customerDirectoryQuerySchema }),
  controller.directory,
);

customerRoutes.get(
  '/analytics',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ query: customerDirectoryQuerySchema }),
  controller.analytics,
);

/*
  Duplicate review and export. Literal paths, so they are declared here with
  `/directory` and `/analytics` and before the `/:id` routes below — otherwise
  "duplicates" and "export" would be parsed as customer ids and rejected by
  cuidSchema with a 422 that looks like a validation bug.
*/

customerRoutes.get(
  '/duplicates',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ query: customerDuplicateQuerySchema }),
  controller.duplicates,
);

/**
 * What a rescan would change.
 *
 * VIEW rather than EDIT: it computes a plan and writes nothing. Applying the
 * plan is a separate act and will carry its own gate.
 */
customerRoutes.get(
  '/duplicates/scan-plan',
  requirePermission('CUSTOMERS', 'VIEW'),
  controller.duplicateScanPlan,
);

customerRoutes.get(
  '/duplicates/:id',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema }),
  controller.duplicateDetail,
);

/**
 * Records a confirm or dismiss decision.
 *
 * EDIT, because it writes — but what it writes is a review decision and
 * nothing else. No customer row, enquiry, lead or order is changed by this
 * route, and there is deliberately no merge endpoint: merging is a separate
 * decision with rules nobody has approved, and a reviewer who could trigger one
 * by accident is the risk this whole feature exists to avoid.
 */
customerRoutes.patch(
  '/duplicates/:id',
  requirePermission('CUSTOMERS', 'EDIT'),
  validate({ params: customerIdParamSchema, body: customerDuplicateDecisionSchema }),
  controller.decideDuplicate,
);

/**
 * The directory as a CSV file.
 *
 * EXPORT, not VIEW. The two are separate grants on this module precisely
 * because this endpoint hands over a file of every matching customer's name,
 * phone, email and purchase history, which then lives outside the CRM's access
 * controls. Hiding a button would not be authorization; this is.
 */
customerRoutes.get(
  '/export',
  requirePermission('CUSTOMERS', 'EXPORT'),
  validate({ query: customerDirectoryQuerySchema }),
  controller.exportDirectory,
);

/*
  Phase A2 — one customer's profile and history.

  Declared AFTER the two literal paths above, which is the ordering that makes
  both work: Express matches in registration order, so "/directory" reaches its
  own handler rather than arriving here as an id that `cuidSchema` would reject
  with a 422.

  Every one of these is gated on CUSTOMERS VIEW. The picker's own gating above
  is untouched — reading one customer's purchase history, GSTIN and contact
  details is a different act from looking a customer up to attach to an order.
*/
customerRoutes.get(
  '/:id/profile',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema }),
  controller.profile,
);

customerRoutes.get(
  '/:id/enquiries',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema, query: customerHistoryQuerySchema }),
  controller.enquiries,
);

customerRoutes.get(
  '/:id/leads',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema, query: customerHistoryQuerySchema }),
  controller.leads,
);

customerRoutes.get(
  '/:id/orders',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema, query: customerHistoryQuerySchema }),
  controller.orders,
);

customerRoutes.get(
  '/:id/timeline',
  requirePermission('CUSTOMERS', 'VIEW'),
  validate({ params: customerIdParamSchema }),
  controller.timeline,
);
