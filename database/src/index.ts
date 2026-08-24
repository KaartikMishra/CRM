/**
 * @rs/database — the single point of database access.
 *
 * Backend imports { prisma } from '@rs/database'. Nothing else reaches across
 * the folder boundary, and the frontend never imports this package at all.
 * Keeping the client here is what makes the three-tier separation real rather
 * than a naming convention.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * A single client per process. In development the module can be re-evaluated on
 * reload, which would otherwise open a new connection pool each time — Neon
 * exhausts its connection limit quickly under that pattern.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from '@prisma/client';
