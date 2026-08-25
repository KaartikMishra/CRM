/**
 * Boots the real Express app in-process on an ephemeral port.
 *
 * Tests exercise the whole stack — middleware, validation, policies, Prisma,
 * Neon — rather than calling services directly, because most of the rules being
 * tested live in the middleware chain and the database constraints. Mocking
 * either would test the mock.
 */

import type { Server } from 'node:http';
import { SignJWT } from 'jose';
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER, type Role } from '@rs/shared';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';

let server: Server | null = null;
let baseUrl = '';

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  baseUrl = '';
}

/**
 * Mints a session token the way Auth.js does, so requireAuth verifies it for
 * real. Options exist so tests can deliberately produce bad tokens.
 */
export async function mintToken(
  subject: string,
  options: {
    role?: Role;
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    secret?: string;
  } = {},
): Promise<string> {
  const secret = new TextEncoder().encode(options.secret ?? env.AUTH_SECRET);

  return new SignJWT({ role: options.role ?? 'USER' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject)
    .setIssuer(options.issuer ?? SESSION_JWT_ISSUER)
    .setAudience(options.audience ?? SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '8h')
    .sign(secret);
}

export type ApiResponse<T = unknown> = {
  status: number;
  body: {
    success: boolean;
    data?: T;
    meta?: Record<string, unknown>;
    message?: string;
    code?: string;
    details?: { path: string; message: string }[];
  };
};

export async function api<T = unknown>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {},
  };
}
