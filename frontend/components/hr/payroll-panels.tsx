'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PayrollCalculationResultView, PayrollPeriodView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  calculatePayrollAction,
  cancelPayrollAction,
  decidePayrollAction,
  finalizePayrollAction,
  submitPayrollAction,
} from '@/app/(app)/hr/payroll-actions';
import { NOT_STATUTORY_NOTICE, PERIOD_NEXT_STEP } from './payroll-labels';

/**
 * The workflow controls for one payroll run.
 *
 * ### Every control is gated on `viewerCan`, from the server
 *
 * Nothing here re-derives who may do what. `period.viewerCan.finalize` is false
 * for a reader whose own salary is inside the run — whatever grants they hold —
 * and this component renders that answer rather than recomputing it. A browser
 * that decided for itself would eventually offer a control the API refuses,
 * which is a worse experience than no control and a worse signal than an honest
 * explanation.
 *
 * **Hiding a control is not authorization.** Every action below posts to an
 * endpoint that checks the same rule again. The hiding is courtesy; the server
 * is the boundary. That is why `viewerIsPaidByThisRun` produces a *stated
 * reason* rather than a silently missing button: somebody who expects to be able
 * to finalise should learn why they cannot.
 *
 * ### Warnings and blockers are both shown
 *
 * A calculation returns `warnings` (things worth knowing — unvalued overtime, an
 * employee with no salary) and `blockers` (things that must be fixed before
 * finalisation — a negative net, an incoherent component set). Neither is
 * swallowed. A run that quietly produced a smaller number than expected is the
 * failure mode this module most needs to avoid.
 */
export function PayrollWorkflowPanel({ period }: { period: PayrollPeriodView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PayrollCalculationResultView | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [showReject, setShowReject] = useState(false);

  const run = (work: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    startTransition(async () => {
      const outcome = await work();
      if (!outcome.ok) {
        setError(outcome.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  };

  const can = period.viewerCan;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted">{PERIOD_NEXT_STEP[period.status]}</p>

        {/*
          The separation-of-duties explanation. Stated rather than left as an
          absent button, because a payroll administrator who is also an employee
          will otherwise think the system is broken.
        */}
        {period.viewerIsPaidByThisRun && (
          <p className="rounded border border-warning/30 bg-warning-soft p-2 text-xs text-warning">
            You are paid by this run, so you cannot approve or finalise it. Somebody
            else with payroll approval rights has to decide it.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {can.calculate && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const outcome = await calculatePayrollAction(period.id);
                  if (outcome.ok) setResult(outcome.data.result);
                  return outcome;
                })
              }
            >
              {period.status === 'DRAFT' ? 'Cost this run' : 'Recalculate'}
            </Button>
          )}

          {can.submitForApproval && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => submitPayrollAction(period.id))}
            >
              Submit for approval
            </Button>
          )}

          {can.approve && (
            <>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => decidePayrollAction(period.id, 'APPROVE'))}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setShowReject((v) => !v)}
              >
                Send back
              </Button>
            </>
          )}

          {can.finalize && !confirmFinalize && (
            <Button size="sm" disabled={pending} onClick={() => setConfirmFinalize(true)}>
              Finalise
            </Button>
          )}

          {can.cancel && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setShowCancel((v) => !v)}
            >
              Cancel run
            </Button>
          )}

          {can.export && (
            // A plain link, not an action: the download is a GET the browser makes
            // against a route gated on HR_PAYROLL:EXPORT, so the file never passes
            // through a server action that could log it.
            <Button asChild size="sm" variant="outline">
              <a href={`/api/hr/payroll/periods/${period.id}/export`}>Export register</a>
            </Button>
          )}
        </div>

        {/*
          Finalisation is a two-step confirmation, and the second step states what
          is being acknowledged. `acknowledgeNotStatutory` is required by the API;
          clicking through without reading it would make the acknowledgement
          meaningless, so the words are here rather than in a tooltip.
        */}
        {confirmFinalize && can.finalize && (
          <div className="flex flex-col gap-2 rounded border border-warning/30 bg-warning-soft p-3">
            <p className="text-xs text-warning">
              Finalising locks every figure in this run and issues payslips. It cannot be
              undone — a correction afterwards is an adjustment in a later period.
            </p>
            <p className="text-xs text-warning">{NOT_STATUTORY_NOTICE}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => finalizePayrollAction(period.id))}
              >
                I understand — finalise this run
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmFinalize(false)}
              >
                Not yet
              </Button>
            </div>
          </div>
        )}

        {showReject && can.approve && (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-ink" htmlFor="reject-note">
              Why is it going back? The payroll team will read this.
            </label>
            <textarea
              id="reject-note"
              className="min-h-[72px] rounded border border-line bg-surface p-2 text-sm text-ink"
              value={rejectNote}
              onChange={(event) => setRejectNote(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || rejectNote.trim().length < 3}
                onClick={() => run(() => decidePayrollAction(period.id, 'REJECT', rejectNote))}
              >
                Send back
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowReject(false)}>
                Keep it open
              </Button>
            </div>
          </div>
        )}

        {showCancel && can.cancel && (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-ink" htmlFor="cancel-reason">
              Why is this run being abandoned?
            </label>
            <textarea
              id="cancel-reason"
              className="min-h-[72px] rounded border border-line bg-surface p-2 text-sm text-ink"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || cancelReason.trim().length < 3}
                onClick={() => run(() => cancelPayrollAction(period.id, cancelReason))}
              >
                Cancel this run
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCancel(false)}>
                Keep it
              </Button>
            </div>
          </div>
        )}

        {pending && <p className="text-xs text-muted">Working…</p>}
        {error && <p className="text-xs text-critical">{error}</p>}
      </Card>

      {result && <CalculationReport result={result} />}
    </div>
  );
}

/**
 * What a calculation did, and what it refused to do.
 *
 * Blockers before warnings, because a blocker stops finalisation and a warning
 * does not.
 */
function CalculationReport({ result }: { result: PayrollCalculationResultView }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="text-sm text-ink">
        Costed {result.calculated} employee{result.calculated === 1 ? '' : 's'}
        {result.excluded > 0 ? `, excluded ${result.excluded}` : ''}.
      </p>

      {result.blockers.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-critical/30 bg-critical-soft p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-critical">
            Must be resolved before finalising
          </h3>
          {result.blockers.map((blocker, index) => (
            <p key={`${blocker.employeeId ?? 'run'}-${index}`} className="text-xs text-critical">
              {blocker.message}
            </p>
          ))}
        </div>
      )}

      {result.warnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-warning/30 bg-warning-soft p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-warning">
            Worth knowing
          </h3>
          {result.warnings.map((warning, index) => (
            <p key={`${warning.employeeId}-${index}`} className="text-xs text-warning">
              <span className="font-medium">{warning.employeeName}:</span> {warning.message}
            </p>
          ))}
        </div>
      )}

      {result.blockers.length === 0 && result.warnings.length === 0 && (
        <p className="text-xs text-muted">
          Nothing to flag. Every eligible employee was costed from a salary assignment
          in force for this period.
        </p>
      )}
    </Card>
  );
}
