import type { Request, Response } from 'express';
import type {
  AssignLeadInput,
  CreateLeadInput,
  LeadActivityInput,
  LeadCustomerLookupQuery,
  LeadListQuery,
  LeadProductRequirementInput,
  UpdateLeadActivityInput,
  UpdateLeadInput,
  UpdateLeadRequirementInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './lead.service.js';
import * as requirements from './lead-requirement.service.js';

type IdParam = { id: string };

export async function createLead(req: Request, res: Response): Promise<void> {
  const lead = await service.createLead(
    req,
    currentUser(req),
    validatedBody<CreateLeadInput>(req),
  );
  sendCreated(res, { lead });
}

export async function getLead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { lead: await service.getLead(id) });
}

/**
 * Who, if anyone, already has this number.
 *
 * Always a list — never "the" customer. See the service for why the plural
 * matters: the live data carries duplicate phone numbers, and picking one for
 * the caller would link a lead to possibly the wrong person.
 */
export async function lookupCustomer(req: Request, res: Response): Promise<void> {
  const { phone } = validatedQuery<LeadCustomerLookupQuery>(req);
  sendSuccess(res, await service.lookupCustomersByPhone(phone));
}

/**
 * Who a lead can be allocated to.
 *
 * Its own endpoint because `GET /api/users` is administrator-only and allocating
 * is not an administrator's job — see the service for the full reasoning.
 */
export async function listAssignees(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { assignees: await service.listAssignees() });
}

/**
 * The Lead/Deal analytics table.
 *
 * One request serves a whole page: every figure the table draws is either a
 * column or derived in the service from data the same page already fetched.
 */
export async function listLeads(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.listLeads(validatedQuery<LeadListQuery>(req)));
}

// --- deal status and assignment ---------------------------------------------

export async function updateLead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const lead = await service.updateLead(
    req,
    currentUser(req),
    id,
    validatedBody<UpdateLeadInput>(req),
  );
  sendSuccess(res, { lead });
}

/**
 * Allocating a lead, or clearing its allocation.
 *
 * A route of its own rather than a field on the update above, because it is
 * gated on ASSIGN rather than EDIT — the same shape Product Enquiry uses for
 * `/:id/assign`. The permission then lives in the route table, where a reader
 * can see it, instead of being inferred from which keys a body happened to hold.
 */
export async function assignLead(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const lead = await service.assignLead(
    req,
    currentUser(req),
    id,
    validatedBody<AssignLeadInput>(req),
  );
  sendSuccess(res, { lead });
}

// --- activities -------------------------------------------------------------

export async function createActivity(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const lead = await service.createActivity(
    req,
    currentUser(req),
    id,
    validatedBody<LeadActivityInput>(req),
  );
  sendCreated(res, { lead });
}

export async function updateActivity(req: Request, res: Response): Promise<void> {
  const { id, activityId } = validatedParams<IdParam & { activityId: string }>(req);
  const lead = await service.updateActivity(
    req,
    currentUser(req),
    id,
    activityId,
    validatedBody<UpdateLeadActivityInput>(req),
  );
  sendSuccess(res, { lead });
}

// --- requirements: Complete the Ideal ---------------------------------------
//
// Every handler takes the lead id from the validated URL, never from the body.
// A requirement belongs to the lead in the path, and that is what the service
// scopes every read and write by.

export async function listRequirements(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { requirements: await requirements.listRequirements(id) });
}

export async function createRequirement(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const requirement = await requirements.createRequirement(
    req,
    currentUser(req),
    id,
    validatedBody<LeadProductRequirementInput>(req),
  );
  sendCreated(res, { requirement });
}

export async function updateRequirement(req: Request, res: Response): Promise<void> {
  const { id, requirementId } = validatedParams<IdParam & { requirementId: string }>(req);
  const requirement = await requirements.updateRequirement(
    req,
    currentUser(req),
    id,
    requirementId,
    validatedBody<UpdateLeadRequirementInput>(req),
  );
  sendSuccess(res, { requirement });
}

export async function deleteRequirement(req: Request, res: Response): Promise<void> {
  const { id, requirementId } = validatedParams<IdParam & { requirementId: string }>(req);
  await requirements.deleteRequirement(req, currentUser(req), id, requirementId);
  // The id of what went, so a client can reconcile its own list without a
  // follow-up read.
  sendSuccess(res, { deleted: requirementId });
}
