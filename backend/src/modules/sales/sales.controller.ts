/**
 * Thin by design: parse validated input, call one service function, send the
 * response. No branching on business state, no Prisma, no policy checks — those
 * live in the services and policies these functions call.
 */

import type { Request, Response } from 'express';
import type {
  CreateChangeRequestInput,
  CreateSalesOrderInput,
  RecordPaymentInput,
  ReviewChangeRequestInput,
  SalesOrderListQuery,
  UpdateSalesOrderInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as sales from './sales.service.js';
import * as changes from './sales-change-request.service.js';

type IdParam = { id: string };
type RequestParams = { id: string; requestId: string };

export async function create(req: Request, res: Response): Promise<void> {
  const order = await sales.createSalesOrder(
    currentUser(req),
    validatedBody<CreateSalesOrderInput>(req),
  );
  sendCreated(res, { order });
}

export async function list(req: Request, res: Response): Promise<void> {
  const { items, nextCursor, serverTime } = await sales.listSalesOrders(
    validatedQuery<SalesOrderListQuery>(req),
  );
  // serverTime travels with every list so "overdue" is judged against the
  // authoritative clock rather than the viewer's laptop.
  sendSuccess(res, { orders: items }, 200, { nextCursor, serverTime });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const { order, serverTime } = await sales.getSalesOrder(id);
  sendSuccess(res, { order }, 200, { serverTime });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.updateSalesOrder(
    currentUser(req),
    id,
    validatedBody<UpdateSalesOrderInput>(req),
  );
  sendSuccess(res, { order });
}

export async function payment(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.recordPayment(
    currentUser(req),
    id,
    validatedBody<RecordPaymentInput>(req),
  );
  sendCreated(res, { order });
}

export async function dispatch(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.dispatchSalesOrder(currentUser(req), id);
  sendSuccess(res, { order });
}

export async function close(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.closeSalesOrder(currentUser(req), id);
  sendSuccess(res, { order });
}

// ---------------------------------------------------------------------------
//  Product change requests
// ---------------------------------------------------------------------------

export async function createChangeRequest(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await changes.createChangeRequest(
    currentUser(req),
    id,
    validatedBody<CreateChangeRequestInput>(req),
  );
  sendCreated(res, { order });
}

export async function approveChangeRequest(req: Request, res: Response): Promise<void> {
  const { id, requestId } = validatedParams<RequestParams>(req);
  const order = await changes.approveChangeRequest(
    currentUser(req),
    id,
    requestId,
    validatedBody<ReviewChangeRequestInput>(req),
  );
  sendSuccess(res, { order });
}

export async function rejectChangeRequest(req: Request, res: Response): Promise<void> {
  const { id, requestId } = validatedParams<RequestParams>(req);
  const order = await changes.rejectChangeRequest(
    currentUser(req),
    id,
    requestId,
    validatedBody<ReviewChangeRequestInput>(req),
  );
  sendSuccess(res, { order });
}
