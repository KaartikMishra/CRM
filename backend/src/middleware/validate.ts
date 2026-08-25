/**
 * §50 — never trust frontend validation.
 *
 * Every endpoint that accepts input runs its Zod schema here first, so a
 * controller only ever sees data that has already been parsed. Output goes to
 * `req.validated` rather than back over `req.body`/`req.query`, which keeps the
 * raw input available for logging and works with Express 5's read-only query.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError, type ErrorDetail } from '../utils/AppError.js';

type Schemas = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

export function toErrorDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.validated = {};

    try {
      if (schemas.params) {
        req.validated.params = schemas.params.parse(req.params);
      }
      if (schemas.query) {
        req.validated.query = schemas.query.parse(req.query);
      }
      if (schemas.body) {
        req.validated.body = schemas.body.parse(req.body);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          AppError.validation('Some of the details need fixing.', toErrorDetails(error)),
        );
        return;
      }
      next(error);
    }
  };
}
