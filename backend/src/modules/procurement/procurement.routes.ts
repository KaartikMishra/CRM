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
  adjustInventorySchema,
  createAllocationSchema,
  createProductSchema,
  createPurchaseBillSchema,
  linkOrderLineSchema,
  linkPurchaseItemSchema,
  orderRequirementQuerySchema,
  putInCatalogueSchema,
  salesRequirementQuerySchema,
  productListQuerySchema,
  purchaseBillListQuerySchema,
  purchaseDelaySchema,
  recordFulfillmentSchema,
  receiveItemSchema,
  updateAllocationSchema,
  updateProductSchema,
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

// --- products & inventory ---------------------------------------------------

procurementRoutes.get(
  '/products',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: productListQuerySchema }),
  controller.listProducts,
);

procurementRoutes.post(
  '/products',
  requirePermission('PROCUREMENT', 'CREATE'),
  validate({ body: createProductSchema }),
  controller.createProduct,
);

procurementRoutes.patch(
  '/products/:id',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: updateProductSchema }),
  controller.updateProduct,
);

/** Correcting a physical count is an edit, not a create. */
procurementRoutes.post(
  '/products/:id/inventory',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: adjustInventorySchema }),
  controller.adjustInventory,
);

// --- requirements -----------------------------------------------------------

/** Declared before /:id so the literal path is not read as a bill id. */
procurementRoutes.get(
  '/order-requirements',
  requirePermission('PROCUREMENT', 'VIEW'),
  validate({ query: orderRequirementQuerySchema }),
  controller.orderRequirements,
);

/**
 * Linking an order line to the catalogue is an EDIT of procurement data, not of
 * the order: it writes one column so purchased stock can be matched to a
 * requirement. Guarded like every other write in this module.
 */
procurementRoutes.post(
  '/order-lines/link',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ body: linkOrderLineSchema }),
  controller.linkOrderLine,
);

/**
 * Cataloguing an order line's product. A CREATE of catalogue data, so it
 * carries the CREATE permission rather than EDIT — it can add a Product.
 */
procurementRoutes.post(
  '/order-lines/put-in-catalogue',
  requirePermission('PROCUREMENT', 'CREATE'),
  validate({ body: putInCatalogueSchema }),
  controller.putInCatalogue,
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

procurementRoutes.post(
  '/bills/:id/delay',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: idParam, body: purchaseDelaySchema }),
  controller.markDelayed,
);

// --- allocation -------------------------------------------------------------

/** Reconciling a vendor's wording with a catalogue entry. */
procurementRoutes.post(
  '/bills/:id/items/:itemId/link',
  requirePermission('PROCUREMENT', 'EDIT'),
  validate({ params: itemParams, body: linkPurchaseItemSchema }),
  controller.linkPurchaseItem,
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
