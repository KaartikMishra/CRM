/**
 * The route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for the module and
 * action it needs. Permission answers "may this person do this kind of thing";
 * the ownership policy inside each service answers "may they do it to *this*
 * record". Both are required — neither is sufficient alone.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  createChangeRequestSchema,
  createSalesOrderSchema,
  recordPaymentSchema,
  reviewChangeRequestSchema,
  salesOrderListQuerySchema,
  updateSalesOrderSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './sales.controller.js';

// Ids are validated as cuids before any lookup, so a malformed id is a 422
// rather than a database round trip.
const idParam = z.object({ id: z.string().cuid() });
const requestParams = z.object({ id: z.string().cuid(), requestId: z.string().cuid() });

export const salesRoutes = Router();

salesRoutes.use(requireAuth);

salesRoutes.post(
  '/',
  requirePermission('SALES', 'CREATE'),
  validate({ body: createSalesOrderSchema }),
  controller.create,
);

salesRoutes.get(
  '/',
  requirePermission('SALES', 'VIEW'),
  validate({ query: salesOrderListQuerySchema }),
  controller.list,
);

/** By internal record id — never by the manually entered order number. */
salesRoutes.get(
  '/:id',
  requirePermission('SALES', 'VIEW'),
  validate({ params: idParam }),
  controller.detail,
);

salesRoutes.patch(
  '/:id',
  requirePermission('SALES', 'EDIT'),
  validate({ params: idParam, body: updateSalesOrderSchema }),
  controller.update,
);

salesRoutes.post(
  '/:id/payments',
  requirePermission('SALES', 'EDIT'),
  validate({ params: idParam, body: recordPaymentSchema }),
  controller.payment,
);

salesRoutes.post(
  '/:id/dispatch',
  requirePermission('SALES', 'EDIT'),
  validate({ params: idParam }),
  controller.dispatch,
);

salesRoutes.post(
  '/:id/close',
  requirePermission('SALES', 'EDIT'),
  validate({ params: idParam }),
  controller.close,
);

// ---------------------------------------------------------------------------
//  Product change requests
// ---------------------------------------------------------------------------
//
// There is deliberately no PATCH or DELETE for an item. Those existed and were
// the defect: they let whoever could edit an order rewrite or delete a live
// product with no review at all. Every product change now goes through a
// request, so there is no second path to bypass.

/**
 * Filing a request is the EDIT capability plus the ownership rule. Whether it
 * is ever applied is a separate decision, taken by somebody else.
 */
salesRoutes.post(
  '/:id/change-requests',
  requirePermission('SALES', 'EDIT'),
  validate({ params: idParam, body: createChangeRequestSchema }),
  controller.createChangeRequest,
);

/**
 * Deciding is SALES ASSIGN — admin-only by default, grantable per person.
 * Checked here and again in the service, so neither the route nor a direct call
 * is a way around it. The service additionally refuses self-review.
 */
salesRoutes.post(
  '/:id/change-requests/:requestId/approve',
  requirePermission('SALES', 'ASSIGN'),
  validate({ params: requestParams, body: reviewChangeRequestSchema }),
  controller.approveChangeRequest,
);

salesRoutes.post(
  '/:id/change-requests/:requestId/reject',
  requirePermission('SALES', 'ASSIGN'),
  validate({ params: requestParams, body: reviewChangeRequestSchema }),
  controller.rejectChangeRequest,
);
