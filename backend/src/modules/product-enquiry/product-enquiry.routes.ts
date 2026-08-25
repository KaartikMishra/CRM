/**
 * §26 — the route table, and nothing else.
 *
 * Every route carries requireAuth and a requirePermission for the module and
 * action it needs. Permission answers "may this person do this kind of thing";
 * the ownership policy inside each service answers "may they do it to *this*
 * record". Both are required — neither is sufficient alone.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  addEnquiryProductSchema,
  createEnquirySchema,
  createVendorResponseSchema,
  delayReasonSchema,
  enquiryListQuerySchema,
  reassignEnquirySchema,
  reopenEnquirySchema,
  updateEnquirySchema,
  updateEnquiryProductSchema,
} from '@rs/shared';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './product-enquiry.controller.js';

// Ids are validated as cuids before any lookup, so a malformed id is a 422
// rather than a database round trip (§26).
const idParam = z.object({ id: z.string().cuid() });
const productParams = z.object({ id: z.string().cuid(), productId: z.string().cuid() });
const nestedProductParams = z.object({
  enquiryId: z.string().cuid(),
  productId: z.string().cuid(),
});

export const productEnquiryRoutes = Router();

productEnquiryRoutes.use(requireAuth);

productEnquiryRoutes.post(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'CREATE'),
  validate({ body: createEnquirySchema }),
  controller.create,
);

productEnquiryRoutes.get(
  '/',
  requirePermission('PRODUCT_ENQUIRY', 'VIEW'),
  validate({ query: enquiryListQuerySchema }),
  controller.list,
);

/** Declared before /:id so the literal path is not parsed as an enquiry id. */
productEnquiryRoutes.get(
  '/assignees',
  requirePermission('PRODUCT_ENQUIRY', 'VIEW'),
  controller.assignees,
);

productEnquiryRoutes.get(
  '/:id',
  requirePermission('PRODUCT_ENQUIRY', 'VIEW'),
  validate({ params: idParam }),
  controller.detail,
);

productEnquiryRoutes.patch(
  '/:id',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: idParam, body: updateEnquirySchema }),
  controller.update,
);

productEnquiryRoutes.post(
  '/:id/products',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: idParam, body: addEnquiryProductSchema }),
  controller.addProduct,
);

productEnquiryRoutes.patch(
  '/:id/products/:productId',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: productParams, body: updateEnquiryProductSchema }),
  controller.updateProduct,
);

productEnquiryRoutes.post(
  '/:enquiryId/products/:productId/vendor-responses',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: nestedProductParams, body: createVendorResponseSchema }),
  controller.addVendorResponse,
);

productEnquiryRoutes.post(
  '/:id/partial-submit',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: idParam }),
  controller.partialSubmit,
);

productEnquiryRoutes.post(
  '/:id/full-submit',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: idParam }),
  controller.fullSubmit,
);

/**
 * Beyond §34's list, and necessary: the approved rule refuses a breached submit
 * with DELAY_REASON_REQUIRED, which needs somewhere to record the reason.
 */
productEnquiryRoutes.post(
  '/:id/delay-reason',
  requirePermission('PRODUCT_ENQUIRY', 'EDIT'),
  validate({ params: idParam, body: delayReasonSchema }),
  controller.delayReason,
);

productEnquiryRoutes.post(
  '/:id/assign',
  requirePermission('PRODUCT_ENQUIRY', 'ASSIGN'),
  validate({ params: idParam, body: reassignEnquirySchema }),
  controller.assign,
);

productEnquiryRoutes.post(
  '/:id/reopen',
  requirePermission('PRODUCT_ENQUIRY', 'ASSIGN'),
  validate({ params: idParam, body: reopenEnquirySchema }),
  controller.reopen,
);
