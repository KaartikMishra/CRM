/**
 * The customer CSV download.
 *
 * A route of its own rather than the shared `/api/proxy` handler, and for one
 * concrete reason: that proxy forwards the body and `Content-Type` but not
 * `Content-Disposition`. A CSV arriving without it renders as text in the
 * browser instead of downloading, which is precisely what the export is for.
 *
 * It is otherwise the same shape as the proxy — read the session server-side,
 * attach the bearer, forward, relay. It adds no headers of its own beyond
 * Authorization and never accepts an Authorization header from the caller.
 *
 * ### This route is not the authorization
 *
 * Express requires `CUSTOMERS:EXPORT` on the endpoint itself. If the signed-in
 * person does not hold it, the backend answers 403 and that is what the browser
 * receives. This handler forwards a refusal as faithfully as it forwards a
 * file; hiding the button elsewhere is a courtesy, not a control.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { sessionToken } from '@/lib/api-server';

const backendUrl = () => process.env.BACKEND_URL ?? 'http://localhost:4000';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = await sessionToken();

  if (!token) {
    return NextResponse.json(
      { success: false, message: 'Sign in to continue.', code: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  }

  // The directory's filters ride along untouched, so the file matches the view
  // the person was looking at when they clicked Export.
  const target = `${backendUrl()}/api/customers/export${req.nextUrl.search}`;

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/csv, application/json' },
      cache: 'no-store',
    });

    const body = await response.text();

    /*
      A refusal comes back as JSON, not a file. Relaying it with the CSV
      headers attached would hand the browser a download called
      rs-customers-....csv containing an error — so the content type decides
      which headers go on.
    */
    const contentType = response.headers.get('content-type') ?? 'application/json';
    if (!response.ok || !contentType.includes('csv')) {
      return new NextResponse(body, {
        status: response.status,
        headers: { 'Content-Type': contentType },
      });
    }

    const headers = new Headers({
      'Content-Type': contentType,
      // Forwarded from the backend, which names the file and stamps the date.
      'Content-Disposition':
        response.headers.get('content-disposition') ?? 'attachment; filename="customers.csv"',
      // A customer list in a shared browser cache is the same exposure as one
      // in a shared folder.
      'Cache-Control': 'no-store, max-age=0',
    });

    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json(
      { success: false, message: 'The service is unavailable right now.', code: 'API_UNREACHABLE' },
      { status: 502 },
    );
  }
}
