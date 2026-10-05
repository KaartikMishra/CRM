import type { Request, Response } from 'express';
import type { CreateLeadInput, LeadCustomerLookupQuery } from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './lead.service.js';

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
