/**
 * Thin by design (§27): parse validated input, call one service function, send
 * the response. No branching on business state, no Prisma, no policy checks —
 * those live in the services and policies these functions call.
 */

import type { Request, Response } from 'express';
import type {
  AddEnquiryProductInput,
  CreateEnquiryInput,
  CreateVendorResponseInput,
  DelayReasonInput,
  EnquiryListQuery,
  ReassignEnquiryInput,
  ReopenEnquiryInput,
  UpdateEnquiryInput,
  UpdateEnquiryProductInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as enquiries from './product-enquiry.service.js';
import * as products from './enquiry-product.service.js';
import * as vendorResponses from './vendor-response.service.js';
import * as submissions from './enquiry-submission.service.js';

type IdParam = { id: string };
type ProductParams = { id: string; productId: string };
type NestedProductParams = { enquiryId: string; productId: string };

export async function create(req: Request, res: Response): Promise<void> {
  const enquiry = await enquiries.createEnquiry(
    currentUser(req),
    validatedBody<CreateEnquiryInput>(req),
  );
  sendCreated(res, { enquiry });
}

export async function assignees(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { assignees: await enquiries.listAssignees() });
}

export async function list(req: Request, res: Response): Promise<void> {
  const { items, nextCursor, serverTime } = await enquiries.listEnquiries(
    validatedQuery<EnquiryListQuery>(req),
  );
  // serverTime travels with every list so countdown timers correct against the
  // authoritative clock rather than the viewer's laptop (§18).
  sendSuccess(res, { enquiries: items }, 200, { nextCursor, serverTime });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const { enquiry, serverTime } = await enquiries.getEnquiry(id);
  sendSuccess(res, { enquiry }, 200, { serverTime });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await enquiries.updateEnquiry(
    currentUser(req),
    id,
    validatedBody<UpdateEnquiryInput>(req),
  );
  sendSuccess(res, { enquiry });
}

export async function addProduct(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await products.addProduct(
    currentUser(req),
    id,
    validatedBody<AddEnquiryProductInput>(req),
  );
  sendCreated(res, { enquiry });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { id, productId } = validatedParams<ProductParams>(req);
  const enquiry = await products.updateProduct(
    currentUser(req),
    id,
    productId,
    validatedBody<UpdateEnquiryProductInput>(req),
  );
  sendSuccess(res, { enquiry });
}

export async function addVendorResponse(req: Request, res: Response): Promise<void> {
  const { enquiryId, productId } = validatedParams<NestedProductParams>(req);
  const enquiry = await vendorResponses.addVendorResponse(
    currentUser(req),
    enquiryId,
    productId,
    validatedBody<CreateVendorResponseInput>(req),
  );
  sendCreated(res, { enquiry });
}

export async function partialSubmit(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await submissions.partialSubmit(currentUser(req), id);
  sendSuccess(res, { enquiry });
}

export async function fullSubmit(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await submissions.fullSubmit(currentUser(req), id);
  sendSuccess(res, { enquiry });
}

export async function delayReason(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await submissions.recordDelayReason(
    currentUser(req),
    id,
    validatedBody<DelayReasonInput>(req),
  );
  sendCreated(res, { enquiry });
}

export async function assign(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await enquiries.assignEnquiry(
    currentUser(req),
    id,
    validatedBody<ReassignEnquiryInput>(req),
  );
  sendSuccess(res, { enquiry });
}

export async function reopen(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<IdParam>(req);
  const enquiry = await enquiries.reopenEnquiry(
    currentUser(req),
    id,
    validatedBody<ReopenEnquiryInput>(req),
  );
  sendSuccess(res, { enquiry });
}
