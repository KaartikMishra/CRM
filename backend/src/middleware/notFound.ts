import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError.js';

/**
 * Registered after every route so an unmatched path becomes a normal
 * AppError and travels through the same error handler as everything else.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound('ROUTE_NOT_FOUND', `No route matches ${req.method} ${req.path}.`));
}
