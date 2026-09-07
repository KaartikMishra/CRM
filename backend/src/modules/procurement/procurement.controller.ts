import type { Request, Response } from 'express';
import type {
  AdjustInventoryInput,
  CreateAllocationInput,
  CreateProductInput,
  CreatePurchaseBillInput,
  LinkOrderLineInput,
  LinkPurchaseItemInput,
  RecordFulfillmentInput,
  ProductListQuery,
  PutInCatalogueInput,
  SalesRequirementQuery,
  PurchaseBillListQuery,
  PurchaseDelayInput,
  ReceiveItemInput,
  UpdateAllocationInput,
  UpdateProductInput,
  UpdatePurchaseBillInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './procurement.service.js';

// --- products ---------------------------------------------------------------

export async function listProducts(req: Request, res: Response): Promise<void> {
  const products = await service.listProducts(validatedQuery<ProductListQuery>(req));
  sendSuccess(res, { products });
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const product = await service.createProduct(
    req,
    currentUser(req).id,
    validatedBody<CreateProductInput>(req),
  );
  sendCreated(res, { product });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const product = await service.updateProduct(
    req,
    currentUser(req).id,
    id,
    validatedBody<UpdateProductInput>(req),
  );
  sendSuccess(res, { product });
}

export async function adjustInventory(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const product = await service.adjustInventory(
    req,
    currentUser(req).id,
    id,
    validatedBody<AdjustInventoryInput>(req),
  );
  sendSuccess(res, { product });
}

// --- requirements & shortages ----------------------------------------------

export async function orderRequirements(req: Request, res: Response): Promise<void> {
  const { orderId } = validatedQuery<{ orderId: string }>(req);
  sendSuccess(res, { order: await service.getOrderRequirements(orderId) });
}

/** Attaching a free-text or legacy order line to the catalogue. */
export async function linkOrderLine(req: Request, res: Response): Promise<void> {
  const order = await service.linkOrderLine(
    req,
    currentUser(req).id,
    validatedBody<LinkOrderLineInput>(req),
  );
  sendSuccess(res, { order });
}

/** Attaching a free-text purchase line to the catalogue. */
export async function linkPurchaseItem(req: Request, res: Response): Promise<void> {
  const { id, itemId } = validatedParams<{ id: string; itemId: string }>(req);
  const bill = await service.linkPurchaseItem(
    req,
    currentUser(req).id,
    id,
    itemId,
    validatedBody<LinkPurchaseItemInput>(req),
  );
  sendSuccess(res, { bill });
}

/** Cataloguing a free-text order line's product, then linking the line to it. */
export async function putInCatalogue(req: Request, res: Response): Promise<void> {
  const order = await service.putInCatalogue(
    req,
    currentUser(req).id,
    validatedBody<PutInCatalogueInput>(req),
  );
  sendSuccess(res, { order });
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
