/**
 * §16 — the thin proxy for client-side mutations.
 *
 * A client component cannot read the httpOnly session cookie, and must not hold
 * a bearer token in JavaScript. It calls this route instead; the route reads the
 * session server-side, attaches the token and forwards to Express.
 *
 * It forwards only: it adds no headers of its own beyond Authorization and
 * never accepts an Authorization header from the caller.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sessionToken } from '@/lib/api-server';

const backendUrl = () => process.env.BACKEND_URL ?? 'http://localhost:4000';

async function forward(req: NextRequest, path: string[]): Promise<NextResponse> {
  const token = await sessionToken();

  if (!token) {
    return NextResponse.json(
      { success: false, message: 'Sign in to continue.', code: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  const target = `${backendUrl()}/api/${path.join('/')}${req.nextUrl.search}`;
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');

  const contentType = req.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);

  // Forwarded as bytes, not text: multipart uploads carry binary and a
  // boundary that must survive the hop intact. The incoming Content-Type
  // (including that boundary) is passed through untouched above.
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : Buffer.from(await req.arrayBuffer());

  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });
    const payload = await response.text();
    return new NextResponse(payload, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'The service is unavailable right now.', code: 'API_UNREACHABLE' },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
