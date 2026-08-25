/**
 * Loads the workspace .env before any test module is imported.
 *
 * Module evaluation order would otherwise construct the Prisma client before
 * config/env.ts gets a chance to call dotenv, and the client would come up
 * without DATABASE_URL. A setup file runs ahead of the whole import graph, so
 * the ordering is guaranteed rather than incidental.
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });
