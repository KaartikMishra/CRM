/**
 * Process bootstrap: configuration, database, listener, shutdown.
 *
 * Everything about *what* the API does lives elsewhere. This file is only
 * responsible for starting it safely and stopping it cleanly.
 */

import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { corsAllowlist } from './config/cors.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { attachWebSocketServer, stopWebSocketServer } from './realtime/ws-server.js';
import { purgeExpired } from './modules/notification/notification.service.js';
import { sweepOverdueRequests } from './modules/dispatch/dispatch-sweep.service.js';

/** How long a shutdown may take before the process is killed anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** How often expired notifications are swept. Daily is ample for a 30-day window. */
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;

/**
 * How often overdue partial-dispatch requests are settled.
 *
 * Five minutes against a 24-hour deadline: the worst case is that a request is
 * allowed up to five minutes late, which nobody waiting a day will notice, and
 * the cost is one indexed query per tick against `(status, deadline)` that
 * usually matches nothing. A shorter interval would buy precision the deadline
 * does not have; a much longer one would make "24 hours" visibly untrue.
 */
const PARTIAL_DISPATCH_SWEEP_MS = 5 * 60 * 1000;

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

  // The notification socket shares this listener rather than opening a second
  // port: one thing for a proxy to forward, one thing for a firewall to allow.
  const wss = attachWebSocketServer(server);

  // Notifications are kept for a fixed window. Swept once at boot so a process
  // that was down over a boundary still catches up, then daily. `unref` so a
  // pending timer never holds the process open during shutdown.
  void purgeExpired();
  const retention = setInterval(() => void purgeExpired(), RETENTION_SWEEP_MS);
  retention.unref();

  /*
    Partial-dispatch deadlines, on the same pattern and for the same reason: a
    deadline that only exists as a timer is forgotten by a restart, so the
    boot pass is what settles requests that came due while this process was
    down. `void` rather than `await` so a slow first sweep never delays the
    port being served, and `unref` so a pending tick cannot hold the process
    open during shutdown — an interrupted sweep is simply redone next time,
    because every write it makes is conditional on the row still being PENDING.
  */
  void sweepOverdueRequests();
  const partialDispatch = setInterval(
    () => void sweepOverdueRequests(),
    PARTIAL_DISPATCH_SWEEP_MS,
  );
  partialDispatch.unref();

  registerShutdownHandlers(server, wss);
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then release the database. A request that is mid-transaction when a deploy
 * happens should complete rather than leave a half-written enquiry.
 */
function registerShutdownHandlers(server: Server, wss: WebSocketServer | null = null): void {
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

    // Sockets first: an open WebSocket keeps the HTTP server from closing,
    // so `server.close` would otherwise wait for the shutdown timeout.
    void stopWebSocketServer(wss);

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
