/**
 * Express application assembly.
 *
 * Kept separate from server.ts so the app can be imported by tests without
 * binding a port or opening a database connection. Middleware order matters and
 * is deliberate: identity, then security headers, then parsing, then routes,
 * then the two handlers that must come last.
 */

import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOptions } from './config/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRouter } from './routes/index.js';
import { shopifyWebhookRoutes } from './modules/rs-product/rs-product.webhook.routes.js';

export function createApp(): Express {
  const app = express();

  // Neon and most hosts sit behind a proxy; without this, req.ip is the
  // proxy's address and rate limiting by IP would treat everyone as one client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 1. Identity first, so every later log line and error carries the id.
  app.use(requestId);

  // 2. Security headers. This is a JSON API with no markup of its own, so the
  //    content policy can stay at its strictest.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(cors(corsOptions));
  app.use(requestLogger);

  // 3. Shopify webhooks, mounted *before* the JSON parser.
  //
  //    Their authenticity is an HMAC over the exact bytes Shopify sent, so the
  //    body must reach the handler unparsed: express.json would consume it and
  //    a re-serialised copy would not match the signature. This router applies
  //    its own express.raw and no session middleware — Shopify presents no CRM
  //    session, and the HMAC is the authentication.
  //
  //    Every other route is unaffected: the path is specific, and the parsers
  //    below still run for everything else.
  app.use('/api/rs-products/webhooks', shopifyWebhookRoutes);

  // 4. Body parsing. The limit is generous for JSON but far below an image:
  //    uploads go browser-to-Cloudinary, never through this process.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // 5. Routes.
  app.use('/api', apiRouter);

  // 6. Unmatched paths become AppErrors, then every failure meets one handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
