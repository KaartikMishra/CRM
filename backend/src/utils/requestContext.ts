/**
 * Typed extensions to the Express request.
 *
 * `req.id` is declared by pino-http on IncomingMessage, so it is deliberately
 * not redeclared here — use `String(req.id)` where a plain string is needed.
 *
 * `validated` is where the Zod middleware puts its output. Express 5 exposes
 * `req.query` through a getter with no setter, so overwriting it in place is
 * not possible — and writing parsed data to a separate field is clearer anyway:
 * a handler reading `req.validated.query` is reading something that has
 * definitely been through a schema.
 */

import type { Request } from 'express';

export type ValidatedData = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated: ValidatedData;
      /** Set by multer on the single upload route. */
      file?: {
        buffer: Buffer;
        mimetype: string;
        size: number;
        originalname: string;
      };
    }
  }
}

/** Reads validated data with the caller's expected type. */
export function validatedBody<T>(req: Request): T {
  return req.validated.body as T;
}

export function validatedQuery<T>(req: Request): T {
  return req.validated.query as T;
}

export function validatedParams<T>(req: Request): T {
  return req.validated.params as T;
}
