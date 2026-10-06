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
import {
  assignLeadSchema,
  createLeadSchema,
  leadActivityParamSchema,
  leadActivitySchema,
  leadCustomerLookupSchema,
  leadIdParamSchema,
  leadListQuerySchema,
  leadProductRequirementSchema,
  leadRequirementParamSchema,
  updateLeadActivitySchema,
  updateLeadRequirementSchema,
  updateLeadSchema,
} from '@rs/shared';
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

/**
 * The analytics list. Declared before `/:id` so it is never read as one.
 *
 * VIEW: reading the board is reading, and the figures on it are derived from
 * rows this permission already grants sight of.
 */
leadRoutes.get(
  '/',
  requirePermission('LEAD_DEAL', 'VIEW'),
  validate({ query: leadListQuerySchema }),
  controller.listLeads,
);

/**
 * Who a lead can be allocated to. Declared before `/:id` so it is never read
 * as one, alongside `/customer-lookup` above.
 *
 * VIEW rather than ASSIGN, deliberately: the allocation panel needs this list to
 * show who currently holds the lead, and somebody who may read the module may
 * read the names of their colleagues. The allocation itself still demands ASSIGN
 * on the route below, so a VIEW-only reader can see the list and change nothing.
 */
leadRoutes.get(
  '/assignees',
  requirePermission('LEAD_DEAL', 'VIEW'),
  controller.listAssignees,
);

leadRoutes.get(
  '/:id',
  requirePermission('LEAD_DEAL', 'VIEW'),
  validate({ params: leadIdParamSchema }),
  controller.getLead,
);

// --- deal status and assignment ---------------------------------------------

/**
 * Managing the deal. EDIT, because changing where a deal stands is ordinary
 * work for whoever is handling it.
 */
leadRoutes.patch(
  '/:id',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadIdParamSchema, body: updateLeadSchema }),
  controller.updateLead,
);

/**
 * Allocating a lead. ASSIGN, not EDIT — deciding who owns work is a different
 * capability from doing it, and the CRM already separates the two everywhere
 * else (Product Enquiry's `/:id/assign`, Procurement's allocation routes).
 *
 * Its own route rather than a field on the PATCH above, so the permission is
 * declared in this table instead of a service inspecting a body to decide which
 * one to demand.
 */
leadRoutes.post(
  '/:id/assign',
  requirePermission('LEAD_DEAL', 'ASSIGN'),
  validate({ params: leadIdParamSchema, body: assignLeadSchema }),
  controller.assignLead,
);

// --- activities -------------------------------------------------------------
//
// EDIT on both: recording that a follow-up was due, or that it happened, is the
// work of whoever is handling the lead rather than an allocation decision.

leadRoutes.post(
  '/:id/activities',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadIdParamSchema, body: leadActivitySchema }),
  controller.createActivity,
);

leadRoutes.patch(
  '/:id/activities/:activityId',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadActivityParamSchema, body: updateLeadActivitySchema }),
  controller.updateActivity,
);

// --- requirements: Complete the Ideal ---------------------------------------
//
// VIEW to read, EDIT to write — the same split the activities above use, and no
// new permission: capturing what a customer wants is the work of whoever is
// handling the lead, not a separate privilege.
//
// Every path is nested under `/:id`, which is what makes a requirement
// unreachable except through its own lead. The service scopes each read and
// write by that id as well, so a requirement id from another lead returns
// not-found rather than somebody else's row.

leadRoutes.get(
  '/:id/requirements',
  requirePermission('LEAD_DEAL', 'VIEW'),
  validate({ params: leadIdParamSchema }),
  controller.listRequirements,
);

leadRoutes.post(
  '/:id/requirements',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadIdParamSchema, body: leadProductRequirementSchema }),
  controller.createRequirement,
);

leadRoutes.patch(
  '/:id/requirements/:requirementId',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadRequirementParamSchema, body: updateLeadRequirementSchema }),
  controller.updateRequirement,
);

/**
 * Removes a requirement line.
 *
 * DELETE, and it genuinely deletes — a requirement is working notes about what a
 * customer asked for, not a record anything downstream depends on, so there is
 * nothing to archive. The MediaAsset it pointed at is retained; see the service.
 */
leadRoutes.delete(
  '/:id/requirements/:requirementId',
  requirePermission('LEAD_DEAL', 'EDIT'),
  validate({ params: leadRequirementParamSchema }),
  controller.deleteRequirement,
);
