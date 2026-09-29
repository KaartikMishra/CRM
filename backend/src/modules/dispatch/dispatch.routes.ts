/**
 * The route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for PACKING_DISPATCH
 * — the module value that already existed in the enum, reusing the CRM's one
 * permission system rather than introducing a second. USER holds nothing on it
 * by default, so a plain employee reaches this only once an administrator
 * grants it through the existing overrides screen.
 *
 * The split follows what each action actually is:
 *
 *   VIEW    reading the board and one order's dispatch picture.
 *   CREATE  opening a shipment and starting to pack it — creating a record.
 *   EDIT    recording how it travels, sealing it, cancelling it, and sending
 *           it. Sending is the most consequential of these, and it sits behind
 *           EDIT rather than a permission of its own because inventing one
 *           would mean a second permission vocabulary for one verb.
 *
 * Literal paths are declared before any parameterised one, so `/board` is never
 * read as an id.
 */

import { Router } from 'express';
import {
  createDispatchSchema,
  createPartialDispatchRequestSchema,
  decidePartialDispatchSchema,
  dispatchIdParamSchema,
  dispatchListQuerySchema,
  dispatchOrderSchema,
  updateDispatchSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './dispatch.controller.js';

export const dispatchRoutes = Router();

dispatchRoutes.use(requireAuth);

// --- reading ----------------------------------------------------------------

/** The board: orders worth a dispatcher's attention, readiness derived per row. */
dispatchRoutes.get(
  '/board',
  requirePermission('PACKING_DISPATCH', 'VIEW'),
  validate({ query: dispatchListQuerySchema }),
  controller.listBoard,
);

/** One shipment. */
dispatchRoutes.get(
  '/shipments/:id',
  requirePermission('PACKING_DISPATCH', 'VIEW'),
  validate({ params: dispatchIdParamSchema }),
  controller.getDispatch,
);

// --- one shipment's lifecycle -----------------------------------------------

dispatchRoutes.post(
  '/shipments',
  requirePermission('PACKING_DISPATCH', 'CREATE'),
  validate({ body: createDispatchSchema }),
  controller.createDispatch,
);

dispatchRoutes.patch(
  '/shipments/:id',
  requirePermission('PACKING_DISPATCH', 'EDIT'),
  validate({ params: dispatchIdParamSchema, body: updateDispatchSchema }),
  controller.updateDispatch,
);

dispatchRoutes.post(
  '/shipments/:id/pack',
  requirePermission('PACKING_DISPATCH', 'CREATE'),
  validate({ params: dispatchIdParamSchema }),
  controller.startPacking,
);

dispatchRoutes.post(
  '/shipments/:id/packed',
  requirePermission('PACKING_DISPATCH', 'EDIT'),
  validate({ params: dispatchIdParamSchema }),
  controller.completePacking,
);

/**
 * Sending the goods. The point of no return, so it revalidates everything:
 * the state, the customer's details and the tracing fields.
 */
dispatchRoutes.post(
  '/shipments/:id/dispatch',
  requirePermission('PACKING_DISPATCH', 'EDIT'),
  validate({ params: dispatchIdParamSchema, body: dispatchOrderSchema }),
  controller.dispatchShipment,
);

/** Abandoning a pack. Releases its units back to the order's dispatchable total. */
dispatchRoutes.post(
  '/shipments/:id/cancel',
  requirePermission('PACKING_DISPATCH', 'EDIT'),
  validate({ params: dispatchIdParamSchema }),
  controller.cancelDispatch,
);

// --- partial dispatch -------------------------------------------------------
//
// Two sides of one conversation, and they carry different permissions because
// they are genuinely different jobs:
//
//   Raising it   is dispatch work — the warehouse noticing part of an order is
//                ready — so it sits behind PACKING_DISPATCH:CREATE, the same
//                permission as opening a shipment.
//
//   Deciding it  is a procurement judgement about whether goods should wait for
//                the rest, so it sits behind PROCUREMENT:ASSIGN — the existing
//                permission for committing stock to an order. No new permission
//                is introduced for either.
//
// Reading is PACKING_DISPATCH:VIEW, like the rest of the board.

dispatchRoutes.post(
  '/partial-requests',
  requirePermission('PACKING_DISPATCH', 'CREATE'),
  validate({ body: createPartialDispatchRequestSchema }),
  controller.createPartialRequest,
);

/**
 * Procurement's decision queue: every open question, across every order.
 *
 * Behind PROCUREMENT:ASSIGN and deliberately **no** PACKING_DISPATCH
 * permission. Deciding whether goods should wait for the rest of an order is a
 * procurement judgement, and a reviewer must be able to make it from their own
 * module — requiring dispatch access to answer a dispatch question would mean
 * granting a permission nobody needs for the work.
 *
 * Declared before `/partial-requests/:id` so `pending` is never read as an id.
 */
dispatchRoutes.get(
  '/partial-requests/pending',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  controller.listPendingPartialRequests,
);

dispatchRoutes.get(
  '/partial-requests/:id',
  requirePermission('PACKING_DISPATCH', 'VIEW'),
  validate({ params: dispatchIdParamSchema }),
  controller.getPartialRequest,
);

dispatchRoutes.post(
  '/partial-requests/:id/decide',
  requirePermission('PROCUREMENT', 'ASSIGN'),
  validate({ params: dispatchIdParamSchema, body: decidePartialDispatchSchema }),
  controller.decidePartialRequest,
);

// --- one order --------------------------------------------------------------
//
// Declared last so `/shipments`, `/board` and `/partial-requests` are never
// parsed as an order id.

dispatchRoutes.get(
  '/orders/:id',
  requirePermission('PACKING_DISPATCH', 'VIEW'),
  validate({ params: dispatchIdParamSchema }),
  controller.getDetail,
);

dispatchRoutes.get(
  '/orders/:id/partial-requests',
  requirePermission('PACKING_DISPATCH', 'VIEW'),
  validate({ params: dispatchIdParamSchema }),
  controller.listPartialRequests,
);
