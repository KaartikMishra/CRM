/**
 * The foundation smoke suite (formerly a scratchpad script).
 *
 * Covers the response envelope, error handling, security headers and CORS —
 * the guarantees every other endpoint inherits from app.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, stopTestServer } from './helpers/test-server.js';

/** The shape app.ts guarantees for every response, success or failure. */
type Envelope = {
  success: boolean;
  data: {
    service?: string;
    environment?: string;
    database?: { status: string; latencyMs?: number };
    ready?: boolean;
  };
  message?: string;
  code?: string;
  requestId?: string;
  stack?: unknown;
};

/** fetch().json() is `unknown` under strict TS; this narrows it once. */
const json = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

let base = '';

beforeAll(async () => {
  base = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.service).toBe('royalstuffs-crm-api');
    expect(body.data.database).toBeUndefined();
  });

  it('reports readiness with a live database', async () => {
    const res = await fetch(`${base}/api/health/ready`);
    const body = await json(res);

    expect(res.status).toBe(200);
    expect(body.data.database?.status).toBe('up');
    expect(body.data.ready).toBe(true);
  });

  it('leaks no credentials in the readiness payload', async () => {
    const res = await fetch(`${base}/api/health/ready`);
    const raw = JSON.stringify(await json(res));

    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('npg_');
    expect(raw).not.toContain('neon.tech');
  });
});

describe('error handling', () => {
  it('turns an unknown route into the standard envelope', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    const body = await json(res);

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.code).toBe('ROUTE_NOT_FOUND');
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
  });

  it('never exposes a stack trace', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    const body = await json(res);

    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('    at ');
  });

  it('rejects malformed JSON with a usable code', async () => {
    const res = await fetch(`${base}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    const body = await json(res);

    expect(res.status).toBe(400);
    expect(body.code).toBe('MALFORMED_JSON');
  });
});

describe('request correlation', () => {
  it('echoes a caller-supplied request id', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { 'X-Request-Id': 'trace-me-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-me-123');
  });

  it('generates one when absent', async () => {
    const res = await fetch(`${base}/api/health`);
    expect((res.headers.get('x-request-id') ?? '').length).toBeGreaterThan(10);
  });
});

describe('security headers', () => {
  it('sets X-Content-Type-Options and hides the framework', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('CORS', () => {
  it('allows the configured frontend origin with credentials', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('rejects an unknown origin through the same error envelope', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    const body = await json(res);

    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
  });
});
