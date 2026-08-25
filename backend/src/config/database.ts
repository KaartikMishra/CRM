/**
 * Phase 3B — the backend's single point of database access.
 *
 * The client itself lives in @rs/database and is created there; this module
 * only adopts it and adds lifecycle helpers. There is deliberately no second
 * PrismaClient and no schema in this package — the backend consumes the
 * database tier, it does not own it.
 */

import { prisma } from '@rs/database';
import { isDevelopment } from './env.js';
import { logger } from './logger.js';

export { prisma };

/**
 * Development only: how long to keep trying a sleeping database.
 *
 * Neon suspends idle compute, and a cold resume has been measured here at
 * roughly 60–90 seconds. These seven delays sum to 75 seconds of waiting
 * across eight attempts, which covers a typical resume. It is deliberately
 * finite: a database that is genuinely down should still fail the boot.
 */
const DEV_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 25_000] as const;

/**
 * Prisma codes that mean "the server did not answer", as opposed to "the
 * server answered and said no".
 *
 *   P1001  cannot reach the database server
 *   P1002  reached it, but the connection timed out
 *   P1017  the server closed the connection
 *
 * A bad password (P1000) or an unknown database (P1003) is a configuration
 * mistake: waiting cannot fix it, so those fail immediately as before.
 */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1017']);

function isTransient(error: unknown): boolean {
  const code = (error as { errorCode?: string; code?: string } | null)?.errorCode
    ?? (error as { code?: string } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/**
 * Prisma connects lazily on first query. Doing it explicitly at boot means a
 * bad DATABASE_URL fails at startup rather than on a user's first request.
 *
 * In development that strictness is unhelpful against a serverless database:
 * `npm run dev` would die with P1001 simply because Neon had scaled to zero,
 * leaving the frontend running against nothing. So development retries a
 * *transient* failure for about a minute and a half while the instance
 * resumes. Production still fails fast on the first attempt — there, an
 * unreachable database is a reason not to accept traffic, and the platform's
 * own restart policy is the right retry mechanism.
 */
export async function connectDatabase(): Promise<void> {
  const startedAt = Date.now();
  // A single attempt everywhere except development.
  const delays = isDevelopment ? DEV_RETRY_DELAYS_MS : [];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await prisma.$connect();
      logger.info({ ms: Date.now() - startedAt, attempts: attempt + 1 }, 'Database connected');
      return;
    } catch (error) {
      const last = attempt === delays.length;

      // Configuration errors are not worth waiting on.
      if (last || !isTransient(error)) {
        throw error;
      }

      const wait = delays[attempt]!;
      logger.warn(
        { attempt: attempt + 1, of: delays.length + 1, retryInMs: wait },
        'Database unreachable — it may be resuming from idle. Retrying.',
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

export type DatabaseHealth = {
  status: 'up' | 'down';
  latencyMs?: number;
};

/**
 * Readiness probe. Returns rather than throws, because a failed ping is a
 * reportable state, not an exceptional one.
 */
export async function pingDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error({ err: error }, 'Database ping failed');
    return { status: 'down' };
  }
}

/**
 * The authoritative clock (§24).
 *
 * Business time comes from Postgres, never from Node — the SLA deadline and the
 * countdown that renders it must agree, and only one of those two clocks can be
 * the source of truth.
 */
export async function databaseNow(
  client: Pick<typeof prisma, '$queryRaw'> = prisma,
): Promise<Date> {
  const [row] = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  if (!row) {
    throw new Error('Database returned no result for now()');
  }
  return row.now;
}
