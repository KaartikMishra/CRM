import type { Request, Response } from 'express';
import type {
  CreateAllocationInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  MapPurchaseItemInput,
  ProductChangeListQuery,
  RecordFulfillmentInput,
  RequestProductChangeInput,
  ReviewProductChangeInput,
  ReviewPurchaseBillInput,
  SalesRequirementQuery,
  PurchaseBillListQuery,
  PurchaseDelayInput,
  ReceiveItemInput,
  UpdateAllocationInput,
  UpdatePurchaseBillInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './procurement.service.js';

/*
 * There is no legacy-catalogue handler left.
 *
 * Listing, creating, editing and stock-correcting a legacy Product have all
 * gone with the legacy Product itself. RS Products is the catalogue, and
 * Procurement names goods by RsProduct.id alone.
 */

// --- requirements & shortages ----------------------------------------------

export async function orderRequirements(req: Request, res: Response): Promise<void> {
  const { orderId } = validatedQuery<{ orderId: string }>(req);
  sendSuccess(res, { order: await service.getOrderRequirements(orderId) });
}

/** Mapping a free-text order line to an RS Product. */
export async function linkOrderLine(req: Request, res: Response): Promise<void> {
  const order = await service.linkOrderLine(
    req,
    currentUser(req).id,
    validatedBody<LinkOrderLineInput>(req),
  );
  sendSuccess(res, { order });
}

/** Mapping a purchase line to an RS Product — the canonical identity. */
export async function mapPurchaseItem(req: Request, res: Response): Promise<void> {
  const { id, itemId } = validatedParams<{ id: string; itemId: string }>(req);
  const bill = await service.mapPurchaseItemToRsProduct(
    req,
    currentUser(req).id,
    id,
    itemId,
    validatedBody<MapPurchaseItemInput>(req),
  );
  sendSuccess(res, { bill });
}

/**
 * Asking to move an already-mapped line. Records a request; changes nothing.
 */
export async function requestProductChange(req: Request, res: Response): Promise<void> {
  const { id, itemId } = validatedParams<{ id: string; itemId: string }>(req);
  const bill = await service.requestProductChange(
    req,
    currentUser(req),
    id,
    itemId,
    validatedBody<RequestProductChangeInput>(req),
  );
  sendSuccess(res, { bill });
}

/** The approval queue, or one bill's request history. */
export async function listProductChanges(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ProductChangeListQuery>(req);
  sendSuccess(res, { changes: await service.listProductChanges(query) });
}

export async function approveProductChange(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const changes = await service.approveProductChange(
    req,
    currentUser(req),
    id,
    validatedBody<ReviewProductChangeInput>(req),
  );
  sendSuccess(res, { changes });
}

export async function rejectProductChange(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const changes = await service.rejectProductChange(
    req,
    currentUser(req),
    id,
    validatedBody<ReviewProductChangeInput>(req),
  );
  sendSuccess(res, { changes });
}

/** The SALES board: outstanding customer demand, line by line. */
export async function salesRequirements(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<SalesRequirementQuery>(req);
  sendSuccess(res, { requirements: await service.getSalesRequirements(query) });
}

/** Where one order line's fulfilment came from — the History detail view. */
export async function fulfillmentDetail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { detail: await service.getFulfillmentDetail(id) });
}

/** Recording fulfilment that happened outside procurement. */
export async function recordFulfillment(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const requirements = await service.recordFulfillment(
    req,
    currentUser(req).id,
    id,
    validatedBody<RecordFulfillmentInput>(req),
  );
  sendSuccess(res, { requirements });
}

export async function shortages(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { shortages: await service.getShortages() });
}

// --- bills ------------------------------------------------------------------

export async function listBills(req: Request, res: Response): Promise<void> {
  const { bills, nextCursor } = await service.listBills(
    validatedQuery<PurchaseBillListQuery>(req),
  );
  sendSuccess(res, { bills }, 200, { nextCursor });
}

export async function billDetail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { bill: await service.getBill(id) });
}

export async function createBill(req: Request, res: Response): Promise<void> {
  const bill = await service.createBill(
    req,
    currentUser(req),
    validatedBody<CreatePurchaseBillInput>(req),
  );
  sendCreated(res, { bill });
}

export async function updateBill(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const bill = await service.updateBill(
    req,
    currentUser(req).id,
    id,
    validatedBody<UpdatePurchaseBillInput>(req),
  );
  sendSuccess(res, { bill });
}

export async function receiveItem(req: Request, res: Response): Promise<void> {
  const { id, itemId } = validatedParams<{ id: string; itemId: string }>(req);
  const bill = await service.receiveItem(
    req,
    currentUser(req).id,
    id,
    itemId,
    validatedBody<ReceiveItemInput>(req),
  );
  sendSuccess(res, { bill });
}

/** Signing a recorded bill off, or refusing it. Needs PROCUREMENT ASSIGN. */
export async function approveBill(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const bill = await service.approveBill(
    req,
    currentUser(req),
    id,
    validatedBody<ReviewPurchaseBillInput>(req),
  );
  sendSuccess(res, { bill });
}

export async function rejectBill(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const bill = await service.rejectBill(
    req,
    currentUser(req),
    id,
    validatedBody<ReviewPurchaseBillInput>(req),
  );
  sendSuccess(res, { bill });
}

export async function markDelayed(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const bill = await service.markDelayed(
    req,
    currentUser(req).id,
    id,
    validatedBody<PurchaseDelayInput>(req),
  );
  sendSuccess(res, { bill });
}

// --- allocation -------------------------------------------------------------

export async function createAllocation(req: Request, res: Response): Promise<void> {
  const { id, itemId } = validatedParams<{ id: string; itemId: string }>(req);
  const bill = await service.createAllocation(
    req,
    currentUser(req),
    id,
    itemId,
    validatedBody<CreateAllocationInput>(req),
  );
  sendCreated(res, { bill });
}

export async function updateAllocation(req: Request, res: Response): Promise<void> {
  const { id, itemId, allocationId } = validatedParams<{
    id: string;
    itemId: string;
    allocationId: string;
  }>(req);
  const bill = await service.updateAllocation(
    req,
    currentUser(req),
    id,
    itemId,
    allocationId,
    validatedBody<UpdateAllocationInput>(req),
  );
  sendSuccess(res, { bill });
}
