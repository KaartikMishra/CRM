import type { Request, Response } from 'express';
import type {
  AssignPostSalesCaseInput,
  CreatePostSalesCaseInput,
  PostSalesActivityInput,
  PostSalesAttachmentInput,
  PostSalesCaseStatusChangeInput,
  PostSalesListQuery,
  UpdatePostSalesActivityInput,
  UpdatePostSalesCaseInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './post-sales.service.js';

type IdParam = { id: string };

export async function createCase(req: Request, res: Response): Promise<void> {
  const postSalesCase = await service.createCase(
    req,
    currentUser(req),
    validatedBody<CreatePostSalesCaseInput>(req),
  );
  sendCreated(res, { case: postSalesCase });
}

/**
 * The case board.
 *
 * `mine` is resolved against the authenticated user inside the service, so the
 * caller passes a flag rather than an id and cannot read somebody else's queue.
 */
export async function listCases(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await service.listCases(currentUser(req), validatedQuery<PostSalesListQuery>(req)),
  );
}

/** The lightweight overview. Only figures the core case system can answer. */
export async function overview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { overview: await service.getOverview(currentUser(req)) });
}

/** Who a case can be allocated to. Its own endpoint; see the service for why. */
export async function listAssignees(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { assignees: await service.listAssignees() });
}

/** One customer's orders and lines, for the create form's pickers. */
export async function customerOrders(req: Request, res: Response): Promise<void> {
  const { customerId } = validatedParams<{ customerId: string }>(req);
  sendSuccess(res, { orders: await service.listCustomerOrders(customerId) });
}

export async function getCase(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { case: await service.getCase(id) });
}

export async function getCaseAudit(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { entries: await service.getCaseAudit(id) });
}

export async function updateCase(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const postSalesCase = await service.updateCase(
    req,
    currentUser(req),
    id,
    validatedBody<UpdatePostSalesCaseInput>(req),
  );
  sendSuccess(res, { case: postSalesCase });
}

/**
 * Moving a case through its lifecycle.
 *
 * Its own route rather than a field on the update above, because the move is
 * validated against the shared transition map and deserves to be refused by name
 * when it is illegal — not silently dropped from a general-purpose patch.
 */
export async function changeStatus(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const postSalesCase = await service.changeStatus(
    req,
    currentUser(req),
    id,
    validatedBody<PostSalesCaseStatusChangeInput>(req),
  );
  sendSuccess(res, { case: postSalesCase });
}

/**
 * Allocating a case, or clearing the allocation.
 *
 * Gated on ASSIGN rather than EDIT — deciding who owns work is a different
 * capability from doing it, and the route table is where that is declared.
 */
export async function assignCase(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const postSalesCase = await service.assignCase(
    req,
    currentUser(req),
    id,
    validatedBody<AssignPostSalesCaseInput>(req),
  );
  sendSuccess(res, { case: postSalesCase });
}

// --- activities -------------------------------------------------------------

export async function addActivity(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const postSalesCase = await service.addActivity(
    req,
    currentUser(req),
    id,
    validatedBody<PostSalesActivityInput>(req),
  );
  sendCreated(res, { case: postSalesCase });
}

export async function updateActivity(req: Request, res: Response): Promise<void> {
  const { id, activityId } = validatedParams<IdParam & { activityId: string }>(req);
  const postSalesCase = await service.updateActivity(
    req,
    currentUser(req),
    id,
    activityId,
    validatedBody<UpdatePostSalesActivityInput>(req),
  );
  sendSuccess(res, { case: postSalesCase });
}

// --- attachments ------------------------------------------------------------

export async function addAttachment(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const postSalesCase = await service.addAttachment(
    req,
    currentUser(req),
    id,
    validatedBody<PostSalesAttachmentInput>(req),
  );
  sendCreated(res, { case: postSalesCase });
}

export async function removeAttachment(req: Request, res: Response): Promise<void> {
  const { id, attachmentId } = validatedParams<IdParam & { attachmentId: string }>(req);
  const postSalesCase = await service.removeAttachment(
    req,
    currentUser(req),
    id,
    attachmentId,
  );
  sendSuccess(res, { case: postSalesCase });
}
