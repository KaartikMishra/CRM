/**
 * HTTP translation for HR, and nothing else.
 *
 * No business rule, no permission decision, no try/catch — the route table states
 * who may call what, the service decides, and the async error handler reports
 * failures. Matching every other controller in this codebase.
 */

import type { Request, Response } from 'express';
import type {
  AssignManagerInput,
  ChangeEmployeeStatusInput,
  CreateDepartmentInput,
  CreateDesignationInput,
  CreateEmployeeDocumentInput,
  CreateEmployeeInput,
  DepartmentListQuery,
  DesignationListQuery,
  EmployeeListQuery,
  LinkEmployeeUserInput,
  UnlinkEmployeeUserInput,
  UpdateDepartmentInput,
  UpdateDesignationInput,
  UpdateEmployeeInput,
  VerifyEmployeeDocumentInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './hr.service.js';

type IdParam = { id: string };
type DocumentParam = { id: string; documentId: string };

/**
 * The acting person's HR capabilities, resolved once per request.
 *
 * Every handler needs them, and resolving them in the controller rather than in
 * each service function means one set of permission lookups per request instead of
 * several.
 */
const actor = (req: Request) => service.hrActor(currentUser(req));

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

export async function overview(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { overview: await service.overview() });
}

// ---------------------------------------------------------------------------
//  Employees
// ---------------------------------------------------------------------------

export async function listEmployees(req: Request, res: Response): Promise<void> {
  const page = await service.listEmployees(
    await actor(req),
    validatedQuery<EmployeeListQuery>(req),
  );
  sendSuccess(res, page);
}

export async function getEmployee(req: Request, res: Response): Promise<void> {
  const employee = await service.getEmployee(await actor(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { employee });
}

export async function getEmployeeHistory(req: Request, res: Response): Promise<void> {
  const history = await service.getEmployeeHistory(
    await actor(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { history });
}

export async function createEmployee(req: Request, res: Response): Promise<void> {
  const employee = await service.createEmployee(
    req,
    await actor(req),
    validatedBody<CreateEmployeeInput>(req),
  );
  sendCreated(res, { employee });
}

export async function updateEmployee(req: Request, res: Response): Promise<void> {
  const employee = await service.updateEmployee(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateEmployeeInput>(req),
  );
  sendSuccess(res, { employee });
}

export async function assignManager(req: Request, res: Response): Promise<void> {
  const employee = await service.assignManager(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<AssignManagerInput>(req),
  );
  sendSuccess(res, { employee });
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  const employee = await service.changeStatus(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<ChangeEmployeeStatusInput>(req),
  );
  sendSuccess(res, { employee });
}

export async function linkUser(req: Request, res: Response): Promise<void> {
  const employee = await service.linkUser(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<LinkEmployeeUserInput>(req),
  );
  sendSuccess(res, { employee });
}

export async function unlinkUser(req: Request, res: Response): Promise<void> {
  const employee = await service.unlinkUser(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UnlinkEmployeeUserInput>(req).note,
  );
  sendSuccess(res, { employee });
}

// ---------------------------------------------------------------------------
//  Departments
// ---------------------------------------------------------------------------

export async function listDepartments(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.listDepartments(validatedQuery<DepartmentListQuery>(req)));
}

export async function getDepartment(req: Request, res: Response): Promise<void> {
  const department = await service.getDepartment(validatedParams<IdParam>(req).id);
  sendSuccess(res, { department });
}

export async function createDepartment(req: Request, res: Response): Promise<void> {
  const department = await service.createDepartment(
    req,
    await actor(req),
    validatedBody<CreateDepartmentInput>(req),
  );
  sendCreated(res, { department });
}

export async function updateDepartment(req: Request, res: Response): Promise<void> {
  const department = await service.updateDepartment(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateDepartmentInput>(req),
  );
  sendSuccess(res, { department });
}

// ---------------------------------------------------------------------------
//  Designations
// ---------------------------------------------------------------------------

export async function listDesignations(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.listDesignations(validatedQuery<DesignationListQuery>(req)));
}

export async function getDesignation(req: Request, res: Response): Promise<void> {
  const designation = await service.getDesignation(validatedParams<IdParam>(req).id);
  sendSuccess(res, { designation });
}

export async function createDesignation(req: Request, res: Response): Promise<void> {
  const designation = await service.createDesignation(
    req,
    await actor(req),
    validatedBody<CreateDesignationInput>(req),
  );
  sendCreated(res, { designation });
}

export async function updateDesignation(req: Request, res: Response): Promise<void> {
  const designation = await service.updateDesignation(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateDesignationInput>(req),
  );
  sendSuccess(res, { designation });
}

// ---------------------------------------------------------------------------
//  Documents
// ---------------------------------------------------------------------------

export async function addDocument(req: Request, res: Response): Promise<void> {
  const documents = await service.addDocument(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateEmployeeDocumentInput>(req),
  );
  sendCreated(res, { documents });
}

export async function verifyDocument(req: Request, res: Response): Promise<void> {
  const params = validatedParams<DocumentParam>(req);
  const documents = await service.verifyDocument(
    req,
    await actor(req),
    params.id,
    params.documentId,
    validatedBody<VerifyEmployeeDocumentInput>(req),
  );
  sendSuccess(res, { documents });
}

/**
 * Hands back a freshly signed, short-lived link.
 *
 * A link rather than a redirect or a proxied stream: the browser fetches the file
 * from Cloudinary directly, so the API never carries the bytes, and the link
 * expires. Returning it as data also means the audit entry is written before
 * anybody can follow it.
 */
export async function documentLink(req: Request, res: Response): Promise<void> {
  const params = validatedParams<DocumentParam>(req);
  const link = await service.documentLink(req, await actor(req), params.id, params.documentId);
  sendSuccess(res, { link });
}
