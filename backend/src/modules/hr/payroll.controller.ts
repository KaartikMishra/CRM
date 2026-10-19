/**
 * Payroll HTTP handlers.
 *
 * No business logic and no try/catch, following every other controller in this
 * codebase: the route table validates, the service decides, the error middleware
 * translates. A controller that made a decision would be a second place to look
 * for the rule.
 *
 * The one thing these handlers do carry is the CSV response shape for the
 * register export, because `Content-Disposition` is a transport concern rather
 * than a service one.
 */

import type { Request, Response } from 'express';
import type {
  AssignEmployeeSalaryInput,
  CalculatePayrollInput,
  CancelPayrollInput,
  CreatePayrollAdjustmentInput,
  CreatePayrollPeriodInput,
  CreateSalaryComponentInput,
  CreateSalaryStructureInput,
  DecidePayrollInput,
  EmployeeSalaryQuery,
  ExcludePayrollItemInput,
  FinalizePayrollInput,
  PayrollItemListQuery,
  PayrollPeriodListQuery,
  SalaryComponentListQuery,
  SubmitPayrollInput,
  UpdatePayrollPeriodInput,
  UpdateSalaryComponentInput,
  UpdateSalaryStructureInput,
} from '@rs/shared';
import type { Pagination } from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { hrActor } from './hr.service.js';
import type { HrActor } from './hr-access.js';
import * as config from './payroll.service.js';
import * as run from './payroll-run.service.js';

type IdParam = { id: string };
type ItemParam = { id: string; itemId: string };

const actorOf = (req: Request): Promise<HrActor> => hrActor(currentUser(req));

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

export async function getOverview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { overview: await run.getOverview(await actorOf(req)) });
}

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

export async function listComponents(req: Request, res: Response): Promise<void> {
  const result = await config.listComponents(
    await actorOf(req),
    validatedQuery<SalaryComponentListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function createComponent(req: Request, res: Response): Promise<void> {
  const component = await config.createComponent(
    req,
    await actorOf(req),
    validatedBody<CreateSalaryComponentInput>(req),
  );
  sendCreated(res, { component });
}

export async function updateComponent(req: Request, res: Response): Promise<void> {
  const component = await config.updateComponent(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateSalaryComponentInput>(req),
  );
  sendSuccess(res, { component });
}

export async function deleteComponent(req: Request, res: Response): Promise<void> {
  await config.deleteComponent(req, await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { deleted: true });
}

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

export async function listStructures(req: Request, res: Response): Promise<void> {
  const result = await config.listStructures(await actorOf(req), validatedQuery<Pagination>(req));
  sendSuccess(res, result);
}

export async function getStructure(req: Request, res: Response): Promise<void> {
  const structure = await config.getStructure(
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { structure });
}

export async function createStructure(req: Request, res: Response): Promise<void> {
  const structure = await config.createStructure(
    req,
    await actorOf(req),
    validatedBody<CreateSalaryStructureInput>(req),
  );
  sendCreated(res, { structure });
}

export async function updateStructure(req: Request, res: Response): Promise<void> {
  const structure = await config.updateStructure(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateSalaryStructureInput>(req),
  );
  sendSuccess(res, { structure });
}

// ---------------------------------------------------------------------------
//  Employee salary
// ---------------------------------------------------------------------------

export async function listSalaries(req: Request, res: Response): Promise<void> {
  const result = await config.listSalaries(
    await actorOf(req),
    validatedQuery<EmployeeSalaryQuery>(req),
  );
  sendSuccess(res, result);
}

export async function assignSalary(req: Request, res: Response): Promise<void> {
  const assignment = await config.assignSalary(
    req,
    await actorOf(req),
    validatedBody<AssignEmployeeSalaryInput>(req),
  );
  sendCreated(res, { assignment });
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

export async function listPeriods(req: Request, res: Response): Promise<void> {
  const result = await run.listPeriods(
    await actorOf(req),
    validatedQuery<PayrollPeriodListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function getPeriod(req: Request, res: Response): Promise<void> {
  const period = await run.getPeriod(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { period });
}

export async function createPeriod(req: Request, res: Response): Promise<void> {
  const period = await run.createPeriod(
    req,
    await actorOf(req),
    validatedBody<CreatePayrollPeriodInput>(req),
  );
  sendCreated(res, { period });
}

export async function updatePeriod(req: Request, res: Response): Promise<void> {
  const period = await run.updatePeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdatePayrollPeriodInput>(req),
  );
  sendSuccess(res, { period });
}

export async function calculatePeriod(req: Request, res: Response): Promise<void> {
  const result = await run.calculatePeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CalculatePayrollInput>(req),
  );
  sendSuccess(res, { result });
}

export async function submitPeriod(req: Request, res: Response): Promise<void> {
  const period = await run.submitPeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<SubmitPayrollInput>(req),
  );
  sendSuccess(res, { period });
}

export async function decidePeriod(req: Request, res: Response): Promise<void> {
  const period = await run.decidePeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<DecidePayrollInput>(req),
  );
  sendSuccess(res, { period });
}

export async function finalizePeriod(req: Request, res: Response): Promise<void> {
  const period = await run.finalizePeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<FinalizePayrollInput>(req),
  );
  sendSuccess(res, { period });
}

export async function cancelPeriod(req: Request, res: Response): Promise<void> {
  const period = await run.cancelPeriod(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CancelPayrollInput>(req),
  );
  sendSuccess(res, { period });
}

// ---------------------------------------------------------------------------
//  Items, payslips, summary, export
// ---------------------------------------------------------------------------

export async function listItems(req: Request, res: Response): Promise<void> {
  const result = await run.listItems(
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedQuery<PayrollItemListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function excludeItem(req: Request, res: Response): Promise<void> {
  const params = validatedParams<ItemParam>(req);
  const item = await run.excludeItem(
    req,
    await actorOf(req),
    params.id,
    params.itemId,
    validatedBody<ExcludePayrollItemInput>(req),
  );
  sendSuccess(res, { item });
}

export async function getSummary(req: Request, res: Response): Promise<void> {
  const summary = await run.getSummary(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { summary });
}

/**
 * The register as a CSV download.
 *
 * `Content-Disposition: attachment` rather than an inline body, because the
 * whole point of this endpoint is that the file leaves the building — and
 * because a browser rendering a company's salary list inline is a screenshot
 * waiting to happen.
 */
export async function exportRegister(req: Request, res: Response): Promise<void> {
  const { filename, csv } = await run.exportRegister(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // No caching: a payroll register in a shared browser cache is the same
  // exposure as one in a shared folder.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).send(csv);
}

export async function getPayslip(req: Request, res: Response): Promise<void> {
  const payslip = await run.getPayslip(
    await actorOf(req),
    validatedParams<{ itemId: string }>(req).itemId,
  );
  sendSuccess(res, { payslip });
}

export async function getMyPayroll(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { mine: await run.getMyPayroll(await actorOf(req)) });
}

// ---------------------------------------------------------------------------
//  Adjustments
// ---------------------------------------------------------------------------

export async function createAdjustment(req: Request, res: Response): Promise<void> {
  const adjustment = await run.createAdjustment(
    req,
    await actorOf(req),
    validatedBody<CreatePayrollAdjustmentInput>(req),
  );
  sendCreated(res, { adjustment });
}

export async function listAdjustments(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<{ employeeId?: string }>(req);
  const result = await run.listAdjustments(await actorOf(req), query.employeeId);
  sendSuccess(res, result);
}
