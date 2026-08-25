/**
 * §3C — one response shape for the whole API.
 *
 * Controllers never format failures themselves; they throw, and the centralized
 * error handler produces the failure envelope. That is what keeps the contract
 * consistent across every endpoint.
 */

import type { Response } from 'express';
import type { ErrorDetail } from './AppError.js';

export type SuccessMeta = {
  /** Keyset pagination cursor; null when there is no further page. */
  nextCursor?: string | null;
  /** The authoritative clock. Countdown timers correct against this. */
  serverTime?: string;
  [key: string]: unknown;
};

export type SuccessBody<T> = {
  success: true;
  data: T;
  meta?: SuccessMeta;
};

export type ErrorBody = {
  success: false;
  message: string;
  code: string;
  details?: ErrorDetail[];
  requestId?: string;
};

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: SuccessMeta,
): void {
  const body: SuccessBody<T> = { success: true, data };
  if (meta) {
    body.meta = meta;
  }
  res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T, meta?: SuccessMeta): void {
  sendSuccess(res, data, 201, meta);
}
