import { Router } from 'express';
import { loginSchema } from '@rs/shared';
import { loginRateLimit } from '../../middleware/rateLimit.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { login, logout, me } from './auth.controller.js';

export const authRoutes = Router();

/**
 * The only unauthenticated, credential-accepting endpoint in the API.
 * Rate limited before validation so malformed floods are cheap to reject.
 */
authRoutes.post('/login', loginRateLimit, validate({ body: loginSchema }), login);

authRoutes.get('/me', requireAuth, me);
authRoutes.post('/logout', requireAuth, logout);
