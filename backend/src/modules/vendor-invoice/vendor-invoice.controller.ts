import type { Request, Response } from 'express';
import type {
  CreateMappingInput,
  CreateVendorInput,
  MappingListQuery,
  UpdateMappingInput,
  UpdateVendorInput,
  VendorListQuery,
  VendorTradeQuery,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './vendor-invoice.service.js';

// --- vendors ----------------------------------------------------------------

export async function listVendors(req: Request, res: Response): Promise<void> {
  const { vendors, nextCursor } = await service.listVendors(validatedQuery<VendorListQuery>(req));
  sendSuccess(res, { vendors }, 200, { nextCursor });
}

export async function getVendor(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { vendor: await service.getVendor(id) });
}

export async function createVendor(req: Request, res: Response): Promise<void> {
  const vendor = await service.createVendor(
    req,
    currentUser(req).id,
    validatedBody<CreateVendorInput>(req),
  );
  sendCreated(res, { vendor });
}

export async function updateVendor(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const vendor = await service.updateVendor(
    req,
    currentUser(req).id,
    id,
    validatedBody<UpdateVendorInput>(req),
  );
  sendSuccess(res, { vendor });
}

export async function archiveVendor(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { vendor: await service.archiveVendor(req, currentUser(req).id, id) });
}

// --- trade history (read-only) ----------------------------------------------

export async function vendorTrades(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const { trades, nextCursor } = await service.listVendorTrades(
    id,
    validatedQuery<VendorTradeQuery>(req),
  );
  sendSuccess(res, { trades }, 200, { nextCursor });
}

// --- mappings ---------------------------------------------------------------

export async function listMappings(req: Request, res: Response): Promise<void> {
  const { mappings, nextCursor } = await service.listMappings(
    validatedQuery<MappingListQuery>(req),
  );
  sendSuccess(res, { mappings }, 200, { nextCursor });
}

export async function createMapping(req: Request, res: Response): Promise<void> {
  const mapping = await service.createMapping(
    req,
    currentUser(req).id,
    validatedBody<CreateMappingInput>(req),
  );
  sendCreated(res, { mapping });
}

export async function updateMapping(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const mapping = await service.updateMapping(
    req,
    currentUser(req).id,
    id,
    validatedBody<UpdateMappingInput>(req),
  );
  sendSuccess(res, { mapping });
}

export async function archiveMapping(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { mapping: await service.archiveMapping(req, currentUser(req).id, id) });
}
