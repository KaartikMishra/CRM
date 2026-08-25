/**
 * §15 — the one place Next.js server code calls Express.
 *
 * The session token lives in an httpOnly cookie, so only server-side code can
 * read it. This helper reads it and attaches the Authorization header; nothing
 * else in the app should construct a call to the API, and no client component
 * ever sees the token.
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME } from '@/auth.config';

const backendUrl = () => process.env.BACKEND_URL ?? 'http://localhost:4000';

export type ApiSuccess<T> = { success: true; data: T; meta?: Record<string, unknown> };
export type ApiFailure = {
  success: false;
  message: string;
  code: string;
  details?: { path: string; message: string }[];
  requestId?: string;
};
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** Reads the raw session JWT. Server-only — `cookies()` throws in the browser. */
export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const token = await sessionToken();

  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  try {
    const response = await fetch(`${backendUrl()}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
    return (await response.json()) as ApiResult<T>;
  } catch {
    // A network failure must not surface the backend URL to the user.
    return {
      success: false,
      code: 'API_UNREACHABLE',
      message: 'The service is unavailable right now. Try again in a moment.',
    };
  }
}
