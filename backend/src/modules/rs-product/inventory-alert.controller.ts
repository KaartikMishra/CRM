/**
 * Inventory Alerts — HTTP boundary.
 *
 * No business logic and no try/catch, matching the module's other controllers:
 * the service decides, `asyncHandler` and the error middleware answer.
 *
 * The write handlers notify AFTER the service's transaction has committed. That
 * ordering is the point — a WebSocket push cannot be rolled back, so a notice
 * must never be sent for an alert that did not survive.
 */

import type { Request, Response } from 'express';
import type {
  CreateMonitoredVariantInput,
  ListInventoryAlertsQuery,
  ListMonitoredVariantsQuery,
  SearchMonitorCandidatesQuery,
  UpdateMonitoredVariantInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './inventory-alert.service.js';
import * as notify from './inventory-alert.notify.js';

export async function listMonitored(req: Request, res: Response): Promise<void> {
  const { monitored, nextCursor } = await service.listMonitoredVariants(
    validatedQuery<ListMonitoredVariantsQuery>(req),
  );
  sendSuccess(res, { monitored }, 200, { nextCursor });
}

export async function monitoredDetail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { monitored: await service.getMonitoredVariant(id) });
}

export async function createMonitored(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const input = validatedBody<CreateMonitoredVariantInput>(req);

  const { id, outcome } = await service.createMonitoredVariant(input, actor.id);
  // Committed. Safe to tell people.
  await notifyOutcome(outcome);

  sendCreated(res, { monitored: await service.getMonitoredVariant(id) });
}

export async function updateMonitored(req: Request, res: Response): Promise<void> {
  const actor = currentUser(req);
  const { id } = validatedParams<{ id: string }>(req);
  const input = validatedBody<UpdateMonitoredVariantInput>(req);

  const outcome = await service.updateMonitoredVariant(id, input, actor.id);
  await notifyOutcome(outcome);

  sendSuccess(res, { monitored: await service.getMonitoredVariant(id) });
}

export async function listAlerts(req: Request, res: Response): Promise<void> {
  const { alerts, nextCursor } = await service.listAlerts(
    validatedQuery<ListInventoryAlertsQuery>(req),
  );
  sendSuccess(res, { alerts }, 200, { nextCursor });
}

export async function summary(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { summary: await service.getSummary() });
}

export async function candidates(req: Request, res: Response): Promise<void> {
  const { candidates: rows, nextCursor } = await service.searchCandidates(
    validatedQuery<SearchMonitorCandidatesQuery>(req),
  );
  sendSuccess(res, { candidates: rows }, 200, { nextCursor });
}

/**
 * Turns a lifecycle outcome into notices, or does nothing.
 *
 * Persisting and delivering are separate calls on purpose: the row is written
 * first so it survives a delivery failure, and `notify.deliver` swallows its
 * own errors so a disconnected recipient cannot fail the request that caused
 * the alert.
 */
async function notifyOutcome(outcome: service.EvaluationOutcome): Promise<void> {
  if (outcome.action !== 'RAISED') return;
  await service.notifyRaised(outcome.alertId);
}
