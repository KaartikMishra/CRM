'use client';

import { useState, useTransition } from 'react';
import { Plus, Save, TriangleAlert } from 'lucide-react';
import type { MonitorCandidateView, MonitoredVariantView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorMessage } from '@/components/common/error-message';
import {
  addMonitoredVariantAction,
  updateMonitoredVariantAction,
} from '@/app/(app)/rs-products/alerts/actions';
import { variantLabel } from './alert-tables';

/**
 * The only interactive parts of the Inventory Alerts page.
 *
 * Client components because they hold form state; everything else on the page
 * renders on the server and ships no JavaScript. Each one posts to a server
 * action, which forwards to Express — so the API stays the only authority on
 * validation, permissions and the alert lifecycle, and a disabled control is a
 * reflection of the rule rather than the rule itself.
 *
 * Threshold validation is duplicated here only to spare a round trip on an
 * obvious mistake. The backend's Zod schema and the database CHECK are what
 * actually enforce it.
 */

const THRESHOLD_HINT = 'Whole units, zero or more';

/** Client-side mirror of `thresholdSchema`, for immediate feedback only. */
function thresholdProblem(raw: string): string | null {
  if (raw.trim() === '') return 'Enter a threshold';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'Threshold must be a number';
  if (!Number.isInteger(n)) return 'Threshold must be a whole number';
  if (n < 0) return 'Threshold cannot be negative';
  if (n > 10_000_000) return 'That threshold looks too large — check the value';
  return null;
}

export function AddMonitorForm({ candidate }: { candidate: MonitorCandidateView }) {
  const [threshold, setThreshold] = useState('10');
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pending, start] = useTransition();

  const problem = thresholdProblem(threshold);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">Threshold</span>
          <Input
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            inputMode="numeric"
            className="w-24"
            aria-label={`Threshold for ${variantLabel(candidate)}`}
            disabled={pending}
          />
        </label>

        <Button
          size="sm"
          disabled={pending || problem !== null}
          onClick={() =>
            start(async () => {
              setError(null);
              const result = await addMonitoredVariantAction({
                variantId: candidate.variantId,
                threshold: Number(threshold),
              });
              if (!result.ok) {
                setError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
              }
            })
          }
        >
          <Plus className="size-4" />
          {pending ? 'Adding…' : 'Monitor'}
        </Button>
      </div>

      {problem ? (
        <p className="text-[11px] text-critical">{problem}</p>
      ) : (
        <p className="text-[11px] text-muted">{THRESHOLD_HINT}</p>
      )}

      {error && <ErrorMessage message={error.message} code={error.code} />}
    </div>
  );
}

/**
 * Edit a threshold, or pause monitoring.
 *
 * Pausing is deliberately not called "delete": the configuration and its alert
 * history survive, so switching it back on restores the threshold somebody
 * chose rather than asking them to remember it. The backend resolves any live
 * alert with MONITORING_DISABLED so the history says what happened.
 */
export function MonitorControls({ row }: { row: MonitoredVariantView }) {
  const [threshold, setThreshold] = useState(String(row.threshold));
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pending, start] = useTransition();

  const problem = thresholdProblem(threshold);
  const changed = Number(threshold) !== row.threshold;
  const archived = row.archivedAt !== null;

  const run = (input: { threshold?: number; isActive?: boolean }) =>
    start(async () => {
      setError(null);
      const result = await updateMonitoredVariantAction(row.id, input);
      if (!result.ok) {
        setError({ message: result.message, ...(result.code ? { code: result.code } : {}) });
      }
    });

  if (archived) {
    // Nothing to configure: the variant is gone. The row stays for its history.
    return <p className="text-[11px] text-muted">Variant removed — configuration archived.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <Input
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          inputMode="numeric"
          className="w-20"
          aria-label={`Threshold for ${row.productTitle}`}
          disabled={pending}
        />

        <Button
          size="sm"
          variant="outline"
          disabled={pending || problem !== null || !changed}
          onClick={() => run({ threshold: Number(threshold) })}
        >
          <Save className="size-4" />
          Save
        </Button>

        <Button
          size="sm"
          variant={row.isActive ? 'ghost' : 'outline'}
          disabled={pending}
          onClick={() => run({ isActive: !row.isActive })}
        >
          {row.isActive ? 'Pause' : 'Resume'}
        </Button>
      </div>

      {problem && <p className="text-[11px] text-critical">{problem}</p>}
      {error && <ErrorMessage message={error.message} code={error.code} />}
    </div>
  );
}

/**
 * The dismissible low-stock popup.
 *
 * Dismissal is presentation only — it hides this banner for this person and
 * changes nothing about the alert, which stays ACTIVE and listed below until
 * stock recovers. The two states live in different tables for exactly this
 * reason, and conflating them would make a dismissed popup look like a solved
 * stock problem.
 *
 * Local state rather than a request: the persistent record of what a person has
 * seen is `Notification.dismissedAt`, maintained by the existing bell. This
 * banner is a nudge on top of that.
 */
export function LowStockPopup({ count, shortfall }: { count: number; shortfall: number }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || count === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-md border border-critical/30 bg-critical-soft p-4">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-critical" />
      <div className="flex-1 text-sm text-critical">
        <p className="font-medium">
          {count === 1 ? '1 variant is low on stock' : `${count} variants are low on stock`}
        </p>
        <p className="mt-0.5 text-xs">
          {shortfall.toLocaleString('en-IN')} units short of their thresholds in total. Dismissing
          this message does not resolve the alerts — they stay listed below until stock recovers.
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
        Dismiss
      </Button>
    </div>
  );
}
