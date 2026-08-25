'use client';

import { useEffect, useMemo, useState } from 'react';
import type { EnquirySlaView } from '@rs/shared';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';

/**
 * The countdown.
 *
 * This is a *rendering* of a server fact, never a source of truth. The backend
 * owns createdAt, slaDeadlineAt, firstSubmitAt and efficiency; all this does is
 * subtract two numbers and paint the result.
 *
 * Two rules keep it honest:
 *
 *   1. It corrects for clock skew. Every payload carries the server's `now`, so
 *      the offset between that and the browser's clock is measured once and
 *      applied to every tick. A laptop twenty minutes fast shows the same
 *      remaining time as everyone else's.
 *
 *   2. It ticks locally. No request is made per second (§15) — the interval
 *      only re-renders arithmetic that is already known.
 *
 * Once the enquiry has been answered, the clock stops entirely and the frozen
 * verdict is shown instead of a running number.
 */

const WARNING_SECONDS = 120;

type Props = {
  sla: EnquirySlaView;
  /** The server's clock at the moment this data was fetched. */
  serverTime: string;
  size?: 'sm' | 'lg';
  className?: string;
};

export function SlaTimer({ sla, serverTime, size = 'sm', className }: Props) {
  // Measured once, on mount, and deliberately not re-measured: the offset is a
  // property of the two clocks, not of the tick.
  const offsetMs = useMemo(
    () => new Date(serverTime).getTime() - Date.now(),
    [serverTime],
  );

  const deadlineMs = useMemo(() => new Date(sla.slaDeadlineAt).getTime(), [sla.slaDeadlineAt]);
  const answered = sla.firstSubmitAt !== null;

  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    Math.round((deadlineMs - (Date.now() + offsetMs)) / 1000),
  );

  useEffect(() => {
    if (answered) return;

    const tick = () =>
      setRemainingSeconds(Math.round((deadlineMs - (Date.now() + offsetMs)) / 1000));

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [answered, deadlineMs, offsetMs]);

  // Answered: show what the backend recorded, not a live number.
  if (answered) {
    const onTime = sla.efficiency === 'ON_TIME';
    return (
      <div className={cn('flex flex-col gap-0.5', className)}>
        <span
          className={cn(
            'font-mono tabular font-medium',
            size === 'lg' ? 'text-2xl' : 'text-sm',
            onTime ? 'text-positive' : 'text-critical',
          )}
        >
          {formatDuration(sla.responseSeconds ?? 0)}
        </span>
        <span className="text-xs text-muted">
          {onTime ? 'Responded on time' : 'Responded late'}
        </span>
      </div>
    );
  }

  const overdue = remainingSeconds <= 0;
  const warning = !overdue && remainingSeconds <= WARNING_SECONDS;

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <span
        role="timer"
        aria-live={warning || overdue ? 'polite' : 'off'}
        className={cn(
          'font-mono tabular font-medium',
          size === 'lg' ? 'text-2xl' : 'text-sm',
          overdue ? 'text-critical' : warning ? 'text-warning' : 'text-ink',
        )}
      >
        {overdue ? `+${formatDuration(-remainingSeconds)}` : formatDuration(remainingSeconds)}
      </span>
      <span
        className={cn(
          'text-xs',
          overdue ? 'text-critical' : warning ? 'text-warning' : 'text-muted',
        )}
      >
        {overdue ? 'Past deadline' : 'remaining'}
      </span>
    </div>
  );
}
