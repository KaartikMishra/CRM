/**
 * The route table for Post Sales & Grievance, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for POST_SALES — the
 * module's own value, which already existed in the AppModule enum before this
 * phase. **No new permission vocabulary is introduced**: the four actions below
 * are the existing VIEW/CREATE/EDIT/ASSIGN, and there is no APPROVE.
 *
 * USER holds nothing on POST_SALES by default, so a plain employee reaches this
 * only once an administrator grants it through the existing overrides screen.
 *
 * ### How the four capabilities divide
 *
 *   VIEW    the board, the overview, a case, its audit trail, and the pickers
 *   CREATE  raising a case
 *   EDIT    doing the work — classification, status, notes, communications,
 *           follow-ups, attachments, resolve, close, reopen
 *   ASSIGN  deciding who owns it
 *
 * EDIT and ASSIGN are separate for the reason Phase 4C separated them on the Lead
 * module: doing the work and deciding who does it are different privileges, and
 * the route table is where that is stated rather than a service inspecting a body.
 *
 * Literal paths are declared before any parameterised one, so `/overview`,
 * `/assignees` and `/customers/...` are never read as case ids.
 */

import { Router } from 'express';
import {
  assignPostSalesCaseSchema,
  createPostSalesCaseSchema,
  postSalesActivityParamSchema,
  postSalesActivitySchema,
  postSalesAttachmentParamSchema,
  postSalesAttachmentSchema,
  postSalesCaseParamSchema,
  postSalesCaseStatusChangeSchema,
  postSalesCustomerParamSchema,
  postSalesListQuerySchema,
  updatePostSalesActivitySchema,
  updatePostSalesCaseSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './post-sales.controller.js';

export const postSalesRoutes = Router();

postSalesRoutes.use(requireAuth);

// --- literal paths first ----------------------------------------------------

/** The overview tiles. VIEW: reading counts is reading. */
postSalesRoutes.get(
  '/cases/overview',
  requirePermission('POST_SALES', 'VIEW'),
  controller.overview,
);

/**
 * Who a case can be allocated to.
 *
 * VIEW rather than ASSIGN: the detail page needs this list to show who holds a
 * case, and somebody who may read the module may read their colleagues' names.
 * The allocation itself still demands ASSIGN below, so a VIEW-only reader sees the
 * list and can change nothing. Its own endpoint because `GET /api/users` is
 * administrator-only and allocating is not an administrator's job.
 */
postSalesRoutes.get(
  '/assignees',
  requirePermission('POST_SALES', 'VIEW'),
  controller.listAssignees,
);

/**
 * One customer's orders, for the create form.
 *
 * Scoped to the customer in the URL, which is the authorisation — without it the
 * picker could list anybody's orders and expose what other customers bought.
 */
postSalesRoutes.get(
  '/customers/:customerId/orders',
  requirePermission('POST_SALES', 'VIEW'),
  validate({ params: postSalesCustomerParamSchema }),
  controller.customerOrders,
);

// --- the case collection ----------------------------------------------------

postSalesRoutes.post(
  '/cases',
  requirePermission('POST_SALES', 'CREATE'),
  validate({ body: createPostSalesCaseSchema }),
  controller.createCase,
);

postSalesRoutes.get(
  '/cases',
  requirePermission('POST_SALES', 'VIEW'),
  validate({ query: postSalesListQuerySchema }),
  controller.listCases,
);

// --- one case ---------------------------------------------------------------

postSalesRoutes.get(
  '/cases/:id',
  requirePermission('POST_SALES', 'VIEW'),
  validate({ params: postSalesCaseParamSchema }),
  controller.getCase,
);

/** The case's trail, read from the existing generic AuditLog. */
postSalesRoutes.get(
  '/cases/:id/audit',
  requirePermission('POST_SALES', 'VIEW'),
  validate({ params: postSalesCaseParamSchema }),
  controller.getCaseAudit,
);

postSalesRoutes.patch(
  '/cases/:id',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesCaseParamSchema, body: updatePostSalesCaseSchema }),
  controller.updateCase,
);

/**
 * Moving the case. EDIT, because resolving, closing and reopening are the work of
 * whoever is handling it rather than an allocation decision.
 */
postSalesRoutes.post(
  '/cases/:id/status',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesCaseParamSchema, body: postSalesCaseStatusChangeSchema }),
  controller.changeStatus,
);

/** Allocating. ASSIGN, deliberately not EDIT — see the note at the top. */
postSalesRoutes.post(
  '/cases/:id/assign',
  requirePermission('POST_SALES', 'ASSIGN'),
  validate({ params: postSalesCaseParamSchema, body: assignPostSalesCaseSchema }),
  controller.assignCase,
);

// --- activities -------------------------------------------------------------
//
// EDIT on both: recording a note, a conversation or a follow-up is the work of
// whoever is handling the case. Both paths are nested under `/cases/:id`, which is
// what makes an activity unreachable except through its own case — and the service
// scopes every read and write by that id as well.

postSalesRoutes.post(
  '/cases/:id/activities',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesCaseParamSchema, body: postSalesActivitySchema }),
  controller.addActivity,
);

postSalesRoutes.patch(
  '/cases/:id/activities/:activityId',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesActivityParamSchema, body: updatePostSalesActivitySchema }),
  controller.updateActivity,
);

// --- attachments ------------------------------------------------------------

/**
 * Attaches an already-uploaded image.
 *
 * The bytes go through the existing upload route, which is the one place binary
 * data is handled and which enforces the permitted image types and the size cap.
 * This records that the asset belongs to this case.
 */
postSalesRoutes.post(
  '/cases/:id/attachments',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesCaseParamSchema, body: postSalesAttachmentSchema }),
  controller.addAttachment,
);

/**
 * Detaches an attachment.
 *
 * DELETE on the link, never on the asset: MediaAsset is referenced by seven tables
 * and every foreign key to it is SetNull, so the image survives. EDIT rather than
 * DELETE, because removing a photo somebody attached by mistake is ordinary work
 * on the case and not the destruction of a record.
 */
postSalesRoutes.delete(
  '/cases/:id/attachments/:attachmentId',
  requirePermission('POST_SALES', 'EDIT'),
  validate({ params: postSalesAttachmentParamSchema }),
  controller.removeAttachment,
);
