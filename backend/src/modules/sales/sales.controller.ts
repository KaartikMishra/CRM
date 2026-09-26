/**
 * Thin by design: parse validated input, call one service function, send the
 * response. No branching on business state, no Prisma, no policy checks — those
 * live in the services and policies these functions call.
 */

import type { Request, Response } from 'express';
import type {
  CancelSalesItemsInput,
  CancelSalesOrderInput,
  CreateChangeRequestInput,
  CreateSalesOrderInput,
  CreateSalesRefundInput,
  RecordPaymentInput,
  RejectSalesRefundInput,
  SettleSalesRefundInput,
  ReviewChangeRequestInput,
  SalesOrderListQuery,
  SetSalesChargesInput,
  UpdateSalesOrderInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as sales from './sales.service.js';
import * as changes from './sales-change-request.service.js';
import * as chargeChanges from './sales-charge-change.service.js';
import * as refunds from './sales-refund.service.js';

type IdParam = { id: string };
type RequestParams = { id: string; requestId: string };
type RefundParams = { id: string; refundId: string };

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

/** Replaces the order's charges and adjustments with the set that was sent. */
export async function setCharges(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.setSalesCharges(
    currentUser(req),
    id,
    validatedBody<SetSalesChargesInput>(req),
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

export async function approveChargeChange(req: Request, res: Response): Promise<void> {
  const { id, requestId } = validatedParams<RequestParams>(req);
  const order = await chargeChanges.approveChargeChange(
    currentUser(req),
    id,
    requestId,
    validatedBody<ReviewChangeRequestInput>(req),
  );
  sendSuccess(res, { order });
}

export async function rejectChargeChange(req: Request, res: Response): Promise<void> {
  const { id, requestId } = validatedParams<RequestParams>(req);
  const order = await chargeChanges.rejectChargeChange(
    currentUser(req),
    id,
    requestId,
    validatedBody<ReviewChangeRequestInput>(req),
  );
  sendSuccess(res, { order });
}


// ---------------------------------------------------------------------------
//  Cancellation and refunds
// ---------------------------------------------------------------------------

export async function cancel(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.cancelSalesOrder(
    currentUser(req),
    id,
    validatedBody<CancelSalesOrderInput>(req),
  );
  sendSuccess(res, { order });
}

export async function cancelItems(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await sales.cancelSalesItems(
    currentUser(req),
    id,
    validatedBody<CancelSalesItemsInput>(req),
  );
  sendSuccess(res, { order });
}

export async function createRefund(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const order = await refunds.createRefund(
    currentUser(req),
    id,
    validatedBody<CreateSalesRefundInput>(req),
  );
  // 201: a refund record is created, even though no money has moved yet.
  sendCreated(res, { order });
}

export async function settleRefund(req: Request, res: Response): Promise<void> {
  const { id, refundId } = validatedParams<RefundParams>(req);
  const order = await refunds.settleRefund(
    currentUser(req),
    id,
    refundId,
    validatedBody<SettleSalesRefundInput>(req),
  );
  sendSuccess(res, { order });
}

export async function rejectRefund(req: Request, res: Response): Promise<void> {
  const { id, refundId } = validatedParams<RefundParams>(req);
  const order = await refunds.rejectRefund(
    currentUser(req),
    id,
    refundId,
    validatedBody<RejectSalesRefundInput>(req),
  );
  sendSuccess(res, { order });
}
