/**
 * §53 — never log passwords or authentication secrets.
 *
 * The redaction list below is the enforcement of that rule: anything matching
 * these paths is replaced before it reaches a log sink, so an accidental
 * `log.info({ body })` cannot leak a credential.
 */

import pino from 'pino';
import { env, isDevelopment } from './env.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'password',
  'passwordHash',
  'AUTH_SECRET',
  'DATABASE_URL',
  '*.password',
  '*.passwordHash',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[redacted]',
  },
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
