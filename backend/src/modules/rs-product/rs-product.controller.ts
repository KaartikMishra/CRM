import type { Request, Response } from 'express';
import type {
  CreateRsProductInput,
  RsProductListQuery,
  UpdateRsProductInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import * as service from './rs-product.service.js';

export async function list(req: Request, res: Response): Promise<void> {
  const { products, nextCursor } = await service.listRsProducts(
    validatedQuery<RsProductListQuery>(req),
  );
  sendSuccess(res, { products }, 200, { nextCursor });
}

/** The values the productType filter can offer, drawn from the catalogue. */
export async function productTypes(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { productTypes: await service.listProductTypes() });
}

export async function create(req: Request, res: Response): Promise<void> {
  const product = await service.createManualProduct(validatedBody<CreateRsProductInput>(req));
  sendCreated(res, { product });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { product: await service.getRsProduct(id) });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const product = await service.updateRsProduct(id, validatedBody<UpdateRsProductInput>(req));
  sendSuccess(res, { product });
}

export async function archive(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { product: await service.archiveRsProduct(id) });
}

export async function shopifyConnection(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { shopify: await service.shopifyConnectionStatus() });
}

export async function shopifySync(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { sync: await service.runShopifySync() });
}
