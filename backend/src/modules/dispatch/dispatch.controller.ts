import type { Request, Response } from 'express';
import type {
  CreateDispatchInput,
  CreatePartialDispatchRequestInput,
  DecidePartialDispatchInput,
  DispatchListQuery,
  DispatchOrderInput,
  UpdateDispatchInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './dispatch.service.js';
import * as partial from './dispatch-partial.service.js';

type IdParam = { id: string };

export async function listBoard(req: Request, res: Response): Promise<void> {
  const { orders, nextCursor } = await service.listBoard(
    validatedQuery<DispatchListQuery>(req),
  );
  sendSuccess(res, { orders }, 200, { nextCursor });
}

export async function getDetail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { detail: await service.getDetail(id) });
}

export async function getDispatch(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { dispatch: await service.getDispatch(id) });
}

export async function createDispatch(req: Request, res: Response): Promise<void> {
  const dispatch = await service.createDispatch(
    req,
    currentUser(req),
    validatedBody<CreateDispatchInput>(req),
  );
  sendCreated(res, { dispatch });
}

export async function updateDispatch(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const dispatch = await service.updateDispatch(
    req,
    currentUser(req),
    id,
    validatedBody<UpdateDispatchInput>(req),
  );
  sendSuccess(res, { dispatch });
}

export async function startPacking(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, {
    dispatch: await service.setDispatchStatus(req, currentUser(req), id, 'PACKING'),
  });
}

export async function completePacking(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, {
    dispatch: await service.setDispatchStatus(req, currentUser(req), id, 'PACKED'),
  });
}

export async function cancelDispatch(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, {
    dispatch: await service.setDispatchStatus(req, currentUser(req), id, 'CANCELLED'),
  });
}

export async function dispatchShipment(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const dispatch = await service.dispatchShipment(
    req,
    currentUser(req),
    id,
    validatedBody<DispatchOrderInput>(req),
  );
  sendSuccess(res, { dispatch });
}

// --- partial dispatch -------------------------------------------------------

export async function createPartialRequest(req: Request, res: Response): Promise<void> {
  const request = await partial.createRequest(
    req,
    currentUser(req),
    validatedBody<CreatePartialDispatchRequestInput>(req),
  );
  sendCreated(res, { request });
}

export async function getPartialRequest(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { request: await partial.getRequest(id) });
}

export async function listPartialRequests(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  sendSuccess(res, { requests: await partial.listForOrder(id) });
}

/**
 * Procurement's decision queue.
 *
 * Takes no id, because a reviewer opening Purchase & Procurement has neither an
 * order nor a request to name — being told what is waiting is the point.
 */
export async function listPendingPartialRequests(
  _req: Request,
  res: Response,
): Promise<void> {
  sendSuccess(res, { requests: await partial.listPending() });
}

/**
 * Procurement's answer. One endpoint for both decisions rather than two,
 * because they are the same act with different evidence attached — and the
 * shared schema is what enforces which evidence each one needs.
 */
export async function decidePartialRequest(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const request = await partial.decide(
    req,
    currentUser(req),
    id,
    validatedBody<DecidePartialDispatchInput>(req),
  );
  sendSuccess(res, { request });
}
