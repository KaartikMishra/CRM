'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { TrainingProgramSummary } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { linkOnboardingTrainingAction } from '@/app/(app)/hr/training-actions';

/**
 * Linking an onboarding TRAINING task to real training.
 *
 * ### Why this is an explicit step and not automatic
 *
 * Phase 3 created the TRAINING task category with no course behind it, deliberately.
 * Guessing which program a new joiner needs from their department would be wrong
 * often enough to matter, and a wrong guess here puts somebody through the wrong
 * curriculum before anybody notices. So somebody names the program.
 *
 * The task keeps its own identity, ordering and history; training progress then drives
 * its status. Nothing about the task is replaced.
 *
 * ### Idempotent, and that matters here
 *
 * Linking twice is not an error — the backend returns the existing enrollment rather
 * than creating a second, and naming a program for somebody already enrolled reuses
 * the live enrollment. That is why this renders a plain button rather than guarding
 * against a double click: the second click is harmless by construction, not by luck.
 *
 * The service refuses a cross-employee link — an enrollment belonging to somebody
 * else cannot be attached to this onboarding's task — and refuses creating one before
 * the employment record exists, since there is nobody to enrol.
 */
export function OnboardingTrainingLink({
  taskId,
  onboardingId,
  trainingEnrollmentId,
  programs,
}: {
  taskId: string;
  onboardingId: string;
  /** Already linked, where it is. Null means this step has not been taken. */
  trainingEnrollmentId: string | null;
  /** Published programs. A draft cannot be assigned. */
  programs: TrainingProgramSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [programId, setProgramId] = useState('');

  if (trainingEnrollmentId !== null) {
    return (
      <p className="text-xs text-muted">
        Linked to training ·{' '}
        <Link
          href={`/hr/training/learn/${trainingEnrollmentId}`}
          className="text-accent hover:underline"
        >
          open the course
        </Link>
      </p>
    );
  }

  const assignable = programs.filter((program) => program.status === 'ACTIVE');

  function link(): void {
    if (programId === '') {
      setMessage('Pick a program.');
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const res = await linkOnboardingTrainingAction(taskId, onboardingId, { programId });
      if (!res.ok) {
        setMessage(res.message);
        return;
      }
      router.refresh();
    });
  }

  if (assignable.length === 0) {
    return (
      <p className="text-xs text-muted">
        No published training programs to link. Publish one first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-brass-line bg-brass-soft p-2.5">
      <span className="text-xs text-ink-2">
        This task is not linked to a course yet, so nothing tracks it.
      </span>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`program-${taskId}`} className="text-xs">
            Program
          </Label>
          <select
            id={`program-${taskId}`}
            value={programId}
            onChange={(event) => setProgramId(event.target.value)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="">Pick a program</option>
            {assignable.map((program) => (
              <option key={program.id} value={program.id}>
                {program.title} ({program.code})
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" variant="outline" disabled={pending} onClick={link}>
          {pending ? 'Linking…' : 'Link to training'}
        </Button>
      </div>

      {message && (
        <p role="alert" className="text-xs text-critical">
          {message}
        </p>
      )}
    </div>
  );
}
