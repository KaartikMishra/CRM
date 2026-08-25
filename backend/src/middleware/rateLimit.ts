/**
 * §53 — rate limiting where it matters.
 *
 * Login is the one unauthenticated, credential-accepting endpoint in the API,
 * so it is the one worth throttling. The key combines IP and the attempted
 * email: throttling by IP alone would let one attacker spread an attack across
 * many accounts, and by email alone would let anyone lock out a colleague.
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { ErrorBody } from '../utils/apiResponse.js';
import { isTest } from '../config/env.js';

function tooManyRequests(req: Request, res: Response): void {
  const body: ErrorBody = {
    success: false,
    message: 'Too many sign-in attempts. Wait a few minutes and try again.',
    code: 'TOO_MANY_ATTEMPTS',
    requestId: String(req.id),
  };
  res.status(429).json(body);
}

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // A successful sign-in should not count towards a colleague's lockout.
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email =
      typeof (req.body as { email?: unknown })?.email === 'string'
        ? (req.body as { email: string }).email.trim().toLowerCase()
        : 'unknown';
    // Express has already normalised req.ip via the trust-proxy setting.
    return `${req.ip ?? 'unknown-ip'}:${email}`;
  },
  handler: tooManyRequests,
});
