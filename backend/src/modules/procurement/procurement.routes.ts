/**
 * The route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for PROCUREMENT.
 * Permission answers "may this person do this kind of thing"; the freeze rule
 * inside the service answers "may they do it to *this* record". Both are
 * required — neither is sufficient alone.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  createAllocationSchema,
  createPurchaseBillSchema,
  linkOrderLineSchema,
  mapPurchaseItemSchema,
  orderRequirementQuerySchema,
  productChangeListQuerySchema,
  requestProductChangeSchema,
  reviewProductChangeSchema,
  reviewPurchaseBillSchema,
  salesRequirementQuerySchema,
  purchaseBillListQuerySchema,
  purchaseDelaySchema,
  recordFulfillmentSchema,
  receiveItemSchema,
  updateAllocationSchema,
  updatePurchaseBillSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './procurement.controller.js';

const idParam = z.object({ id: z.string().cuid() });
const itemParams = z.object({ id: z.string().cuid(), itemId: z.string().cuid() });
const allocationParams = z.object({
  id: z.string().cuid(),
  itemId: z.string().cuid(),
  allocationId: z.string().cuid(),
});

export const procurementRoutes = Router();

procurementRoutes.use(requireAuth);

/*
 * There is no legacy-catalogue route left. `GET /products`, `POST /products`,
 * `PATCH /products/:id`, `POST /products/:id/inventory` and
 * `POST /order-lines/put-in-catalogue` were all removed with the legacy Product
 * master: Procurement neither lists, creates nor stock-corrects a second
 * catalogue, and identifies goods by RsProduct.id alone.
 */

// --- requirements -----------------------------------------------------------

/** Declared before /:id so the literal path is not read as a bill id. */
procurementRoutes.get(
  '/order-requirements',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: orderRequirementQuerySchema }),
  controller.orderRequirements,
);

/**
 * Mapping an order line to an RS Product is an EDIT of procurement data, not of
 * the order: it writes one column so purchased stock can be matched to a
 * requirement. Guarded like every other write in this module.
 */
procurementRoutes.post(
  '/order-lines/link',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ body: linkOrderLineSchema }),
  controller.linkOrderLine,
);

/** The SALES board — outstanding customer demand. */
procurementRoutes.get(
  '/sales-requirements',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: salesRequirementQuerySchema }),
  controller.salesRequirements,
);

/**
 * The History detail view: read-only, and guarded by the same VIEW permission
 * the History table itself carries.
 */
procurementRoutes.get(
  '/order-lines/:id/fulfillment-detail',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ params: idParam }),
  controller.fulfillmentDetail,
);

/**
 * Recording fulfilment that happened outside procurement. An EDIT of the
 * fulfilment record, guarded like every other write in this module.
 */
procurementRoutes.patch(
  '/order-lines/:id/fulfillment',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: recordFulfillmentSchema }),
  controller.recordFulfillment,
);

procurementRoutes.get(
  '/shortages',
  requirePermission('PROCUREMENT', 'VIEW'),
  controller.shortages,
);

// --- purchase bills ---------------------------------------------------------

procurementRoutes.get(
  '/bills',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: purchaseBillListQuerySchema }),
  controller.listBills,
);

procurementRoutes.post(
  '/bills',
  requirePermission('PROCUREMENT', 'CREATE'),
  validate({ body: createPurchaseBillSchema }),
  controller.createBill,
);

procurementRoutes.get(
  '/bills/:id',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ params: idParam }),
  controller.billDetail,
);

procurementRoutes.patch(
  '/bills/:id',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: updatePurchaseBillSchema }),
  controller.updateBill,
);

procurementRoutes.post(
  '/bills/:id/items/:itemId/receive',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: itemParams, body: receiveItemSchema }),
  controller.receiveItem,
);

/**
 * Signing a recorded bill off, or refusing it.
 *
 * ASSIGN, not EDIT — and that gap is the whole rule. Anyone with CREATE can
 * record a bill; deciding whether it is trusted is a different capability, so a
 * procurement user cannot approve what they just entered. Resolved through the
 * permission service like every other capability, never from `role === 'ADMIN'`,
 * and re-checked in the service along with the self-approval bar, which no
 * permission can lift.
 *
 * Deliberately separate from `/product-changes/:id/approve`. That decides one
 * proposed edit to one line; this decides the bill itself, and merging them
 * would make a single approval mean two different things.
 */
procurementRoutes.post(
  '/bills/:id/approve',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  validate({ params: idParam, body: reviewPurchaseBillSchema }),
  controller.approveBill,
);

procurementRoutes.post(
  '/bills/:id/reject',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  validate({ params: idParam, body: reviewPurchaseBillSchema }),
  controller.rejectBill,
);

procurementRoutes.post(
  '/bills/:id/delay',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: purchaseDelaySchema }),
  controller.markDelayed,
);

// --- allocation -------------------------------------------------------------

/**
 * Mapping a purchase line to an RS Product — Procurement's canonical identity.
 *
 * An EDIT of procurement data: it writes one column on a bill line and creates
 * nothing. There is deliberately no CREATE counterpart — a product that is not
 * in RS Products is created in RS Products, under that module's own permission.
 *
 * Selecting the product needs the RS Products catalogue, which
 * `GET /api/rs-products` guards with `RS_PRODUCTS:VIEW`. That is unchanged and
 * is not widened here: a procurement user without it is told so by the picker
 * rather than shown an empty catalogue.
 */
procurementRoutes.post(
  '/bills/:id/items/:itemId/rs-product',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: itemParams, body: mapPurchaseItemSchema }),
  controller.mapPurchaseItem,
);

/**
 * Asking to move an already-mapped line to a different RS Product.
 *
 * EDIT, like the initial mapping above — filing a request is ordinary
 * Procurement work and anybody who can record a bill may ask. What they cannot
 * do is grant it: this route only records, and the service refuses to write a
 * mapping from here at all.
 */
procurementRoutes.post(
  '/bills/:id/items/:itemId/product-change',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: itemParams, body: requestProductChangeSchema }),
  controller.requestProductChange,
);

/**
 * The approval queue and its decisions.
 *
 * Deciding is ASSIGN, not EDIT — the same capability Sales reviews its own
 * change requests under, and the point of the whole workflow: somebody who can
 * edit procurement data can ask for a re-mapping, and somebody with approval
 * rights grants it. Resolved through the permission service like every other
 * capability, so a per-user grant or revocation applies here too, and never
 * from `role === 'ADMIN'`.
 *
 * The service checks ASSIGN again before writing. That is deliberate
 * duplication: a route is one registration away from losing its middleware, and
 * this is the rule the entire feature exists to enforce.
 */
procurementRoutes.get(
  '/product-changes',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: productChangeListQuerySchema }),
  controller.listProductChanges,
);

procurementRoutes.post(
  '/product-changes/:id/approve',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  validate({ params: idParam, body: reviewProductChangeSchema }),
  controller.approveProductChange,
);

procurementRoutes.post(
  '/product-changes/:id/reject',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  validate({ params: idParam, body: reviewProductChangeSchema }),
  controller.rejectProductChange,
);

procurementRoutes.post(
  '/bills/:id/items/:itemId/allocations',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: itemParams, body: createAllocationSchema }),
  controller.createAllocation,
);

procurementRoutes.patch(
  '/bills/:id/items/:itemId/allocations/:allocationId',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: allocationParams, body: updateAllocationSchema }),
  controller.updateAllocation,
);
