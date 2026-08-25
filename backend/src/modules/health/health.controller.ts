import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import { getLiveness, getReadiness } from './health.service.js';

export function healthCheck(_req: Request, res: Response): void {
  sendSuccess(res, getLiveness());
}

export async function readinessCheck(_req: Request, res: Response): Promise<void> {
  const report = await getReadiness();
  // 503 when a dependency is down, so orchestrators stop routing traffic here.
  sendSuccess(res, report, report.ready ? 200 : 503);
}
