/**
 * Correlation id for every request.
 *
 * The client never sees a stack trace (§52), so when something fails it sees a
 * request id instead — enough for a developer to find the full error in the
 * logs without leaking anything about the server.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Request-Id');
  req.id = incoming && incoming.length <= 100 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
