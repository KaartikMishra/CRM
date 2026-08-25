/**
 * §53 — the browser may only reach this API from the CRM frontend.
 *
 * An allowlist rather than a wildcard, because credentialed requests are
 * coming: `Access-Control-Allow-Origin: *` cannot be combined with
 * `credentials: true`, and this is an internal tool with exactly one client.
 */

import type { CorsOptions } from 'cors';
import { env, isProduction } from './env.js';

const allowedOrigins = new Set(
  [env.FRONTEND_URL, isProduction ? null : 'http://localhost:3000'].filter(
    (origin): origin is string => Boolean(origin),
  ),
);

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin requests and server-to-server calls arrive without an Origin
    // header; those are not the cross-site case CORS defends against.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 86_400,
};

export const corsAllowlist = [...allowedOrigins];
