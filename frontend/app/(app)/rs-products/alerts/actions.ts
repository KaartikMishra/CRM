'use server';

import { revalidatePath } from 'next/cache';
import type {
  CreateMonitoredVariantInput,
  MonitoredVariantView,
  UpdateMonitoredVariantInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';
import type { ActionResult } from '../actions';

/**
 * Inventory Alerts mutations, as server actions.
 *
 * The session token never leaves the server: a form posts here, this attaches
 * the bearer and calls Express. Nothing decides business outcomes — the action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on permissions, validation and the alert
 * lifecycle. Mirrors `../actions.ts`.
 *
 * Both paths revalidate the alerts page and the dashboard: enabling monitoring
 * can raise an alert immediately, which changes the dashboard count, and a
 * stale card would understate it.
 */

const revalidate = (): void => {
  revalidatePath('/rs-products/alerts');
  revalidatePath('/dashboard');
};

export async function addMonitoredVariantAction(
  input: CreateMonitoredVariantInput,
): Promise<ActionResult<{ monitored: MonitoredVariantView }>> {
  const result = await apiFetch<{ monitored: MonitoredVariantView }>(
    '/api/rs-products/alerts/monitored',
    { method: 'POST', body: JSON.stringify(input) },
  );

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  revalidate();
  return { ok: true, data: result.data };
}

export async function updateMonitoredVariantAction(
  id: string,
  input: UpdateMonitoredVariantInput,
): Promise<ActionResult<{ monitored: MonitoredVariantView }>> {
  const result = await apiFetch<{ monitored: MonitoredVariantView }>(
    `/api/rs-products/alerts/monitored/${id}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  revalidate();
  return { ok: true, data: result.data };
}
