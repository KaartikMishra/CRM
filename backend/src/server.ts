/**
 * Process bootstrap: configuration, database, listener, shutdown.
 *
 * Everything about *what* the API does lives elsewhere. This file is only
 * responsible for starting it safely and stopping it cleanly.
 */

import type { Server } from 'node:http';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { corsAllowlist } from './config/cors.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';

/** How long a shutdown may take before the process is killed anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start(): Promise<void> {
  // Fail before binding a port if the database is unreachable.
  await connectDatabase();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, environment: env.NODE_ENV, cors: corsAllowlist },
      `RoyalStuffs CRM API listening on ${env.BACKEND_URL}`,
    );
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.fatal(`Port ${env.PORT} is already in use.`);
      process.exit(1);
    }
    throw error;
  });

  registerShutdownHandlers(server);
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then release the database. A request that is mid-transaction when a deploy
 * happens should complete rather than leave a half-written enquiry.
 */
function registerShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.fatal('Shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((error) => {
      void (async () => {
        if (error) {
          logger.error({ err: error }, 'Error while closing the server');
        }
        try {
          await disconnectDatabase();
        } catch (disconnectError) {
          logger.error({ err: disconnectError }, 'Error while disconnecting the database');
        }
        clearTimeout(forceExit);
        logger.info('Shutdown complete');
        process.exit(error ? 1 : 0);
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise that nobody handled means state is unknown; log it in
  // full and let the platform restart the process rather than limping on.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
}

start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the API');
  process.exit(1);
});
