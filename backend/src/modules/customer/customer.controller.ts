import type { Request, Response } from 'express';
import type {
  CreateCustomerInput,
  CustomerDirectoryQuery,
  CustomerDuplicateDecisionInput,
  CustomerDuplicateQuery,
  CustomerHistoryQuery,
  CustomerIdParam,
  CustomerSearchQuery,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { currentUser } from '../../middleware/requireAuth.js';
import {
  validatedBody,
  validatedParams,
  validatedQuery,
} from '../../utils/requestContext.js';
import { createCustomer, searchCustomers } from './customer.service.js';
import { directoryAnalytics, listDirectory } from './customer-directory.service.js';
import {
  decideCandidate,
  getCandidate,
  listCandidates,
  planDuplicateScan,
} from './customer-duplicate.service.js';
import { exportDirectoryCsv } from './customer-export.service.js';
import {
  customerEnquiries,
  customerLeads,
  customerOrders,
  customerProfile,
  customerTimeline,
} from './customer-profile.service.js';

export async function search(req: Request, res: Response): Promise<void> {
  const customers = await searchCustomers(validatedQuery<CustomerSearchQuery>(req));
  sendSuccess(res, { customers });
}

export async function create(req: Request, res: Response): Promise<void> {
  const customer = await createCustomer(validatedBody<CreateCustomerInput>(req));
  sendCreated(res, { customer });
}

/*
  All Customers. Separate handlers from the two above, which serve the picker:
  the picker's contract is relied on by Product Enquiry, Create Lead, Sales and
  Post Sales, and is deliberately unchanged.
*/

export async function directory(req: Request, res: Response): Promise<void> {
  const page = await listDirectory(validatedQuery<CustomerDirectoryQuery>(req));
  /*
    The pagination descriptor travels in meta, and says which mode the server
    used: keyset when the sort is a column, offset when it is a derived
    aggregate. `nextCursor` is lifted to the top of meta as well, so a caller
    written against the existing convention keeps working.
  */
  sendSuccess(res, { customers: page.customers }, 200, {
    pagination: page.pagination,
    ...(page.pagination.mode === 'keyset' ? { nextCursor: page.pagination.nextCursor } : {}),
  });
}

export async function analytics(req: Request, res: Response): Promise<void> {
  const summary = await directoryAnalytics(validatedQuery<CustomerDirectoryQuery>(req));
  sendSuccess(res, { analytics: summary });
}

/*
  Phase A2 — one customer. Each list pages its own relation rather than the
  profile loading every enquiry, lead and order a customer has ever had; the
  aggregate figures on the profile itself do read everything, because a total
  over the first page would be wrong and silently so.
*/

export async function profile(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  sendSuccess(res, { customer: await customerProfile(id) });
}

export async function enquiries(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  const { limit, cursor } = validatedQuery<CustomerHistoryQuery>(req);
  const page = await customerEnquiries(id, limit, cursor);
  sendSuccess(res, { enquiries: page.rows }, 200, { nextCursor: page.nextCursor });
}

export async function leads(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  const { limit, cursor } = validatedQuery<CustomerHistoryQuery>(req);
  const page = await customerLeads(id, limit, cursor);
  sendSuccess(res, { leads: page.rows }, 200, { nextCursor: page.nextCursor });
}

export async function orders(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  const { limit, cursor } = validatedQuery<CustomerHistoryQuery>(req);
  const page = await customerOrders(id, limit, cursor);
  sendSuccess(res, { orders: page.rows }, 200, { nextCursor: page.nextCursor });
}

/*
  Duplicate review. Every handler here records or reads a decision; none of
  them merges or edits a customer, which is the feature's safety property and
  is stated again in the UI the reviewer sees.
*/

export async function duplicates(req: Request, res: Response): Promise<void> {
  const { status, limit, cursor } = validatedQuery<CustomerDuplicateQuery>(req);
  const page = await listCandidates(status, limit, cursor);
  sendSuccess(res, { candidates: page.candidates, counts: page.counts }, 200, {
    nextCursor: page.nextCursor,
  });
}

export async function duplicateDetail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  sendSuccess(res, { candidate: await getCandidate(id) });
}

export async function decideDuplicate(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  const { status } = validatedBody<CustomerDuplicateDecisionInput>(req);
  // The reviewer is the signed-in user, never a value from the body: a client
  // that could name the decider could attribute its decision to somebody else.
  const actor = currentUser(req);
  sendSuccess(res, { candidate: await decideCandidate(id, status, actor.id) });
}

/**
 * What a rescan would change, without changing it.
 *
 * Returns a plan plus the coverage figures, so a caller can see how many rows
 * carry a phone the scan could not match on. Applying the plan needs the
 * duplicate table, which the unapplied migrations have not created yet.
 */
export async function duplicateScanPlan(_req: Request, res: Response): Promise<void> {
  const plan = await planDuplicateScan();
  sendSuccess(res, { plan });
}

/**
 * The directory as a CSV download.
 *
 * `CUSTOMERS:EXPORT` rather than VIEW, and that is the authorization decision
 * rather than a formality: this endpoint produces a file of every matching
 * customer's name, phone, email and purchase history that then leaves the CRM's
 * access controls behind. Reading one customer on screen and copying the book
 * are different acts.
 */
export async function exportDirectory(req: Request, res: Response): Promise<void> {
  const { filename, csv } = await exportDirectoryCsv(
    validatedQuery<CustomerDirectoryQuery>(req),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // No caching: a customer list in a shared browser cache is the same exposure
  // as one in a shared folder. Follows the payroll register's precedent.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).send(csv);
}

export async function timeline(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<CustomerIdParam>(req);
  const page = await customerTimeline(id);
  /*
    `truncated` travels in meta, naming any source that hit its per-source cap.
    A reader needs to know the difference between "nothing else happened" and
    "this view does not show everything that happened".
  */
  sendSuccess(res, { timeline: page.entries }, 200, { truncated: page.truncated });
}
