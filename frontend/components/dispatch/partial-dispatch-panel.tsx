'use client';

import { useState, useTransition } from 'react';
import { Loader2, ShieldQuestion } from 'lucide-react';
import { toast } from 'sonner';
import type { DispatchDetail, PartialDispatchRequestView } from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import { createPartialRequestAction } from '@/app/(app)/dispatch/actions';
import { DecidePartialDialog } from './decide-partial-dialog';
import { AUTO_ALLOWED_EXPLANATION, PartialRequestBadge } from './dispatch-badges';
import { canDecide, canRequestPartial, deadlineCountdown, openRequest } from './dispatch-logic';

/**
 * The partial-dispatch conversation, from both sides.
 *
 * Dispatch asks whether the ready half of an order may go; Procurement answers.
 * Both halves live here because they are one conversation and a reader of this
 * file should see the whole of it — who asked, when the answer is due, what was
 * decided and why.
 *
 * Nothing here decides anything. The button to ask is offered only when the
 * question makes sense, and the decision controls only to somebody holding
 * PROCUREMENT:ASSIGN, but the API re-checks both and its refusal is what this
 * displays.
 */
export function PartialDispatchPanel({
  detail,
  canCreate,
  canAssign,
  isAdmin,
  onChanged,
}: {
  detail: DispatchDetail;
  canCreate: boolean;
  canAssign: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const [decision, setDecision] = useState<'ALLOW' | 'DISALLOW' | null>(null);

  const pending = openRequest(detail.partialRequests);
  const mayAsk =
    canCreate &&
    canRequestPartial({
      fullyReady: detail.readiness.fullyReady,
      partiallyReady: detail.readiness.partiallyReady,
      pendingRequest: pending,
    });

  if (detail.partialRequests.length === 0 && !mayAsk) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-ink">Partial dispatch</h2>
            <p className="mt-0.5 text-sm text-muted">
              Whether the ready part of this order may be sent before the rest arrives.
            </p>
          </div>

          {mayAsk && (
            <Button variant="outline" onClick={() => setAskOpen(true)}>
              <ShieldQuestion className="size-4" />
              Initiate Partial Dispatch
            </Button>
          )}
        </div>

        {detail.partialRequests.length > 0 && (
          <ul className="flex flex-col gap-3">
            {detail.partialRequests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                canDecideThis={canDecide(request, canAssign)}
                onAllow={() => setDecision('ALLOW')}
                onDisallow={() => setDecision('DISALLOW')}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <AskDialog
        open={askOpen}
        onOpenChange={setAskOpen}
        salesOrderId={detail.salesOrderId}
        orderNumber={detail.orderId}
        isAdmin={isAdmin}
        onDone={onChanged}
      />

      {pending && (
        <DecidePartialDialog
          open={decision !== null}
          onOpenChange={(open) => !open && setDecision(null)}
          decision={decision ?? 'ALLOW'}
          request={pending}
          salesOrderId={detail.salesOrderId}
          onDone={onChanged}
        />
      )}
    </Card>
  );
}

/** One request, with its outcome spelled out. */
function RequestRow({
  request,
  canDecideThis,
  onAllow,
  onDisallow,
}: {
  request: PartialDispatchRequestView;
  canDecideThis: boolean;
  onAllow: () => void;
  onDisallow: () => void;
}) {
  const countdown = deadlineCountdown(request.deadline);

  return (
    <li className="rounded-md border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PartialRequestBadge request={request} />
        <span className="text-sm text-ink">
          Asked by {request.requestedBy.name} · {formatDateTime(request.requestedAt)}
        </span>

        {request.status === 'PENDING' && (
          <span className="ml-auto text-xs text-muted tabular">
            Due {formatDateTime(request.deadline)} · {countdown.label}
          </span>
        )}
      </div>

      {request.status === 'PENDING' && (
        <p className="mt-2 text-sm text-muted">
          Awaiting Procurement decision. If nobody answers by the deadline it is allowed
          automatically.
        </p>
      )}

      {/*
        The automatic allow says why it happened, and deliberately does not
        present that sentence as somebody's reason: `reason` is null on every
        automatic allow, and writing one here would put words in the mouth of a
        person who never replied.
      */}
      {request.autoDecided && (
        <p className="mt-2 text-sm text-warning">{AUTO_ALLOWED_EXPLANATION}</p>
      )}

      {request.status === 'MOOT' && (
        <p className="mt-2 text-sm text-muted">
          No longer needed — the rest of the order became ready, so the question stopped applying.
        </p>
      )}

      {!request.autoDecided && request.reason && (
        <p className="mt-2 text-sm text-ink">
          <span className="text-muted">Reason: </span>
          {request.reason}
        </p>
      )}

      {request.poa && (
        <p className="mt-1 text-sm text-ink">
          <span className="text-muted">Plan of action: </span>
          {request.poa}
        </p>
      )}

      {request.decidedAt && (
        <p className="mt-2 text-xs text-muted">
          {request.decidedBy
            ? `Decided by ${request.decidedBy.name} · ${formatDateTime(request.decidedAt)}`
            : `Settled ${formatDateTime(request.decidedAt)}`}
        </p>
      )}

      {canDecideThis && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={onAllow}>
            Allow
          </Button>
          <Button size="sm" variant="outline" onClick={onDisallow}>
            Disallow
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Raising the question — and, for an administrator, answering it in the same
 * act.
 *
 * The distinction this dialog exists to keep straight: **a requester is never
 * asked to justify the request.** Dispatch's part is "these lines are ready and
 * these are not, may we send what is ready", which the order's own readiness
 * states completely. The reason and the plan of action belong to the *decision*,
 * and the decision belongs to Procurement.
 *
 * An administrator is the one case where the two acts are the same act. Their
 * request is ALLOWED the moment it is made — the CRM-wide rule that an
 * administrator needs nobody's approval — so what they are giving is a decision
 * reason, not a request reason, and the dialog says so in those words. That is
 * an existing policy enforced by the API (`REASON_REQUIRED`), not something
 * this dialog invents.
 */
function AskDialog({
  open,
  onOpenChange,
  salesOrderId,
  orderNumber,
  isAdmin,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  salesOrderId: string;
  orderNumber: string;
  isAdmin: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [poa, setPoa] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const reasonMissing = isAdmin && reason.trim() === '';

  const submit = () => {
    setError(null);
    startSaving(async () => {
      /*
        A plain requester sends the order id and nothing else — no note, no
        reason, no plan of action. Only the administrator path, which decides
        the request in the same call, carries the decision fields.
      */
      const result = await createPartialRequestAction({
        salesOrderId,
        ...(isAdmin && reason.trim() ? { reason: reason.trim() } : {}),
        ...(isAdmin && poa.trim() ? { poa: poa.trim() } : {}),
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      /*
        What to say is read from the request that came back, not predicted from
        the role: the backend decides whether it was born ALLOWED, and a
        prediction here could disagree with it.
      */
      toast.success(
        result.data.request.status === 'ALLOWED'
          ? 'Partial dispatch allowed.'
          : 'Partial dispatch requested. Procurement has 24 hours to respond.',
      );

      setReason('');
      setPoa('');
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isAdmin ? 'Allow partial dispatch' : 'Initiate partial dispatch'}
          </DialogTitle>
          <DialogDescription>
            {orderNumber} ·{' '}
            {isAdmin
              ? 'the ready part may be sent, and your reason is recorded against the order.'
              : 'ask Procurement whether the ready part of this order may be sent now.'}
          </DialogDescription>
        </DialogHeader>

        {isAdmin ? (
          /*
            The administrator is deciding, not requesting — their request is
            ALLOWED the moment it is made — so these are the DECISION's reason
            and plan of action, labelled as such. The API requires the reason.
          */
          <>
            <p className="text-sm text-muted">
              As an administrator this needs nobody else&rsquo;s approval, so it is allowed
              immediately.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="partial-reason">Reason for allowing</Label>
              <Textarea
                id="partial-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why the ready part should go now"
                rows={3}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="partial-poa">Plan of action (optional)</Label>
              <Textarea
                id="partial-poa"
                value={poa}
                onChange={(e) => setPoa(e.target.value)}
                placeholder="What happens to the rest of the order"
                rows={2}
              />
            </div>
          </>
        ) : (
          /*
            A requester is asked for nothing. No reason, no plan of action, and
            not even a note: the question is "these lines are ready and these
            are not, may we send what is ready", which the order's readiness
            already states in full. Explaining it is Procurement's job, on the
            decision.
          */
          <div className="flex flex-col gap-2 text-sm text-muted">
            <p>
              Procurement will be notified and has <strong>24 hours</strong> to decide. If nobody
              responds by then it is allowed automatically.
            </p>
            <p>The reason for the decision is recorded by whoever makes it.</p>
          </div>
        )}

        {error && <ErrorMessage message={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || reasonMissing}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {isAdmin ? 'Allow partial dispatch' : 'Send request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Procurement's answer.
 *
 * The asymmetry is the rule: allowing needs a reason and may carry a plan of
 * action; refusing needs both, because a refusal leaves goods sitting and owes
 * the warehouse a plan. The same rule is in the shared schema and in the
 * database's CHECK constraints — this asks for it, it does not define it.
 */
