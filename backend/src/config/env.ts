/**
 * §53/§54 — environment configuration, parsed once at boot.
 *
 * A misconfigured deploy must fail loudly rather than run silently without a
 * secret, so the process refuses to start when anything required is missing.
 * Nothing else in the codebase reads process.env directly: importing `env`
 * gives you a typed, validated object instead.
 */

import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

// One .env at the workspace root, shared by every package.
loadDotenv({ path: resolve(here, '../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // --- database (Phase 3B) ------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().min(1).optional(),

  // --- auth (used from Phase 3D; validated now so deploys fail early) -----
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(28_800),

  // --- service URLs -------------------------------------------------------
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  BACKEND_URL: z.string().url().default('http://localhost:4000'),

  // --- business policy ----------------------------------------------------
  // Snapshotted onto each enquiry at creation; changing it never rewrites history.
  ENQUIRY_SLA_MINUTES: z.coerce.number().int().positive().default(15),
  ENQUIRY_NUMBER_PERIOD: z.enum(['CALENDAR', 'FINANCIAL']).default('CALENDAR'),

  /**
   * Cloudinary, as a single credential string:
   *   cloudinary://<api_key>:<api_secret>@<cloud_name>
   *
   * Optional on purpose — the API boots without it and uploads report that
   * they are unavailable, rather than a missing image service taking the whole
   * service down. The secret inside it is never logged or returned.
   */
  CLOUDINARY_URL: z
    .preprocess(
      // A key present but blank in .env means "not configured", not "invalid".
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z
        .string()
        .regex(/^cloudinary:\/\/[^:]+:[^@]+@[^/]+$/, 'CLOUDINARY_URL is malformed')
        .optional(),
    )
    .optional(),

  /** Largest image accepted, in megabytes. */
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(25).default(5),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Print the failing variable names only — never their values, which are secrets.
  const missing = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  console.error(`\nEnvironment configuration is invalid:\n${missing}\n`);
  console.error('Copy .env.example to .env and fill it in before starting.\n');
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
