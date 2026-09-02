/**
 * Phase 3B — the backend's single point of database access.
 *
 * The client itself lives in @rs/database and is created there; this module
 * only adopts it and adds lifecycle helpers. There is deliberately no second
 * PrismaClient and no schema in this package — the backend consumes the
 * database tier, it does not own it.
 */

import { prisma } from '@rs/database';
import { logger } from './logger.js';

export { prisma };

/**
 * How long to keep trying a database that is not answering yet.
 *
 * Neon suspends idle compute, and a cold resume on this project has been
 * observed taking anywhere from 60 seconds to over 90. These nine delays sum
 * to 120 seconds across ten attempts — the top of the intended one-to-two
 * minute window, because a budget that merely covers the average still fails
 * on a slow resume. It is deliberately finite: a database that is genuinely
 * down should still fail the boot rather than hang forever.
 */
const RETRY_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 25_000, 25_000, 20_000,
] as const;

/**
 * DNS is treated as transient too, and this is not theoretical.
 *
 * Prisma resolves through getaddrinfo, and a resolver that has cached a bad
 * negative answer returns ENOTFOUND for one hostname while the record plainly
 * exists — observed here as getaddrinfo failing 10/10 for the pooler host in
 * the same second that a direct DNS query answered 5/5. Retrying rides out
 * that window; failing immediately turns a resolver hiccup into an outage.
 */
const TRANSIENT_DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT']);

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
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;

  // P1001 wraps the underlying cause in its message; a name-resolution failure
  // there is a resolver problem, not a wrong hostname.
  const message = (error as { message?: string } | null)?.message ?? '';
  return [...TRANSIENT_DNS_CODES].some((dnsCode) => message.includes(dnsCode));
}

/**
 * Prisma connects lazily on first query. Doing it explicitly at boot means a
 * bad DATABASE_URL fails at startup rather than on a user's first request.
 *
 * That strictness is unhelpful against a serverless database: the process
 * would die with P1001 simply because Neon had scaled to zero, or because the
 * local resolver briefly lost the hostname. So a *transient* failure is
 * retried for about a minute and a half while the instance resumes.
 *
 * This applies in production as well as development. Retrying a transient
 * fault is not the same as hiding a permanent one: a bad password (P1000) or
 * an unknown database (P1003) still fails on the first attempt, because
 * waiting cannot fix those. Only "the server did not answer" is waited on, and
 * only for a bounded budget — after which the boot fails and the platform's
 * own restart policy takes over.
 */
export async function connectDatabase(): Promise<void> {
  const startedAt = Date.now();
  const delays = RETRY_DELAYS_MS;

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
