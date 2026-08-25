import type { Request, Response } from 'express';
import type { CreateCustomerInput, CustomerSearchQuery } from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedQuery } from '../../utils/requestContext.js';
import { createCustomer, searchCustomers } from './customer.service.js';

export async function search(req: Request, res: Response): Promise<void> {
  const customers = await searchCustomers(validatedQuery<CustomerSearchQuery>(req));
  sendSuccess(res, { customers });
}

export async function create(req: Request, res: Response): Promise<void> {
  const customer = await createCustomer(validatedBody<CreateCustomerInput>(req));
  sendCreated(res, { customer });
}
