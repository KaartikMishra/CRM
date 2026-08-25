/**
 * Per-worker setup: environment first, then a live database connection.
 *
 * Two things have to happen before any test file's own `beforeAll` runs.
 *
 * 1. Load the workspace .env. Module evaluation order would otherwise construct
 *    the Prisma client before config/env.ts calls dotenv, leaving it without
 *    DATABASE_URL.
 *
 * 2. Confirm the database actually answers. Vitest gives each test file its own
 *    worker process with its own client and connection pool, and Neon suspends
 *    idle compute — so a worker starting after a quiet gap can have its very
 *    first query fail while the instance resumes. globalSetup warms the
 *    database once for the run, but that does not help a worker that starts
 *    several minutes later. Retrying here means a cold start costs a few
 *    seconds instead of failing a whole suite during collection.
 */

import { beforeAll } from 'vitest';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });

const ATTEMPTS = 8;
const BACKOFF_MS = 2_000;

beforeAll(async () => {
  const { prisma } = await import('@rs/database');

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (error) {
      if (attempt === ATTEMPTS) {
        throw new Error(
          `Database unreachable from this test worker after ${ATTEMPTS} attempts. ` +
            `Last error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
}, 120_000);
