import type { Request, Response } from 'express';
import type { CreateVendorInput, VendorSearchQuery } from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedQuery } from '../../utils/requestContext.js';
import { createVendor, searchVendors } from './vendor.service.js';

export async function search(req: Request, res: Response): Promise<void> {
  const vendors = await searchVendors(validatedQuery<VendorSearchQuery>(req));
  sendSuccess(res, { vendors });
}

export async function create(req: Request, res: Response): Promise<void> {
  const vendor = await createVendor(validatedBody<CreateVendorInput>(req));
  sendCreated(res, { vendor });
}
