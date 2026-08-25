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
 * Prisma connects lazily on first query. Doing it explicitly at boot means a
 * bad DATABASE_URL fails at startup rather than on a user's first request.
 */
export async function connectDatabase(): Promise<void> {
  const startedAt = Date.now();
  await prisma.$connect();
  logger.info({ ms: Date.now() - startedAt }, 'Database connected');
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
export async function databaseNow(): Promise<Date> {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  if (!row) {
    throw new Error('Database returned no result for now()');
  }
  return row.now;
}
