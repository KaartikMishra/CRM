/**
 * Wakes the database before any suite runs.
 *
 * Neon scales its compute to zero when idle, so the first connection after a
 * quiet period can take several seconds or fail outright while the instance
 * resumes. Whichever suite ran first would otherwise fail during collection —
 * not because anything is wrong, but because it happened to be the one that
 * paid the cold start.
 *
 * Retrying here means the cost is paid once, before the run, rather than
 * randomly by whichever file vitest schedules first.
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });

const ATTEMPTS = 6;
const BACKOFF_MS = 2_000;

export default async function setup(): Promise<void> {
  // Imported after dotenv, so the client sees DATABASE_URL.
  const { prisma } = await import('@rs/database');

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const startedAt = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      const ms = Date.now() - startedAt;
      if (attempt > 1 || ms > 1_000) {
        console.log(`  database ready after ${attempt} attempt(s), ${ms}ms`);
      }
      await prisma.$disconnect();
      return;
    } catch (error) {
      if (attempt === ATTEMPTS) {
        await prisma.$disconnect().catch(() => undefined);
        throw new Error(
          `Database unreachable after ${ATTEMPTS} attempts. ` +
            `Check DATABASE_URL and that the Neon project is not suspended. ` +
            `Last error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
}
