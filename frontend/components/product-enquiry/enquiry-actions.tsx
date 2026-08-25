'use client';

import { useState, useTransition } from 'react';
import { CheckCheck, Clock, Loader2, RotateCcw, Send, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import type { EnquiryDetail } from '@rs/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  assignAction,
  delayReasonAction,
  fullSubmitAction,
  partialSubmitAction,
  reopenAction,
} from '@/app/(app)/product-enquiry/actions';

type Assignee = { id: string; name: string; employeeId: string };

type Props = {
  enquiry: EnquiryDetail;
  assignees: Assignee[];
  /** All resolved server-side from backend permissions + ownership. */
  canSubmit: boolean;
  canAssign: boolean;
  canReopen: boolean;
};

/**
 * The action bar.
 *
 * Every button here calls the real endpoint and then re-reads the enquiry — no
 * status is changed locally (§30). Full Submit is disabled while lines are
 * pending as a courtesy, and the API refuses it regardless.
 *
 * The delay dialog opens in response to the backend saying
 * DELAY_REASON_REQUIRED, rather than the UI deciding on its own that a
 * submission is late.
 */
export function EnquiryActions({ enquiry, assignees, canSubmit, canAssign, canReopen }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<'partial' | 'full' | null>(null);
  const [delayOpen, setDelayOpen] = useState(false);
  const [delayReason, setDelayReason] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignee, setAssignee] = useState(enquiry.assignedTo.id);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  /** Remembers which submit triggered the delay gate, to retry after the reason. */
  const [blocked, setBlocked] = useState<'partial' | 'full' | null>(null);

  const closed = enquiry.status === 'CLOSED';
  const pendingLines = enquiry.products.filter((p) => p.status === 'PENDING');
  const resolved = enquiry.products.length - pendingLines.length;
  const noVendor = enquiry.products.filter((p) => p.status === 'NO_VENDOR').length;
  const anyResolved = resolved > 0;

  function runSubmit(kind: 'partial' | 'full') {
    startTransition(async () => {
      const result = kind === 'partial'
        ? await partialSubmitAction(enquiry.id)
        : await fullSubmitAction(enquiry.id);

      setConfirm(null);

      if (!result.ok) {
        // §32 — the backend decides this is late, not the UI.
        if (result.code === 'DELAY_REASON_REQUIRED') {
          setBlocked(kind);
          setDelayOpen(true);
          return;
        }
        toast.error(result.message, {
          description: result.details?.map((d) => d.message).join(' '),
        });
        return;
      }

      toast.success(kind === 'partial' ? 'Partial submit recorded' : 'Enquiry closed');
    });
  }

  function submitDelayReason() {
    if (delayReason.trim().length < 5) return;

    startTransition(async () => {
      const result = await delayReasonAction(enquiry.id, delayReason.trim());
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      setDelayOpen(false);
      setDelayReason('');
      toast.success('Delay reason recorded');

      // The gate is open now; finish what the person was trying to do.
      if (blocked) {
        const kind = blocked;
        setBlocked(null);
        runSubmit(kind);
      }
    });
  }

  function saveAssignment() {
    startTransition(async () => {
      const result = await assignAction(enquiry.id, assignee);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setAssignOpen(false);
      toast.success('Assignment updated');
    });
  }

  function confirmReopen() {
    if (reopenReason.trim().length < 5) return;

    startTransition(async () => {
      const result = await reopenAction(enquiry.id, reopenReason.trim());
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setReopenOpen(false);
      setReopenReason('');
      toast.success('Enquiry reopened');
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canAssign && !closed && (
          <Button variant="outline" onClick={() => setAssignOpen(true)} disabled={pending}>
            <UserCog className="size-4" />
            Reassign
          </Button>
        )}

        {canSubmit && !closed && (
          <>
            <Button
              variant="outline"
              onClick={() => setConfirm('partial')}
              disabled={pending || !anyResolved}
              title={anyResolved ? undefined : 'Record at least one vendor response first'}
            >
              <Send className="size-4" />
              Partial submit
            </Button>

            <Button
              onClick={() => setConfirm('full')}
              disabled={pending || pendingLines.length > 0}
              title={
                pendingLines.length > 0
                  ? `${pendingLines.length} line(s) still unresolved`
                  : undefined
              }
            >
              <CheckCheck className="size-4" />
              Full submit
            </Button>
          </>
        )}

        {canReopen && closed && (
          <Button variant="outline" onClick={() => setReopenOpen(true)} disabled={pending}>
            <RotateCcw className="size-4" />
            Reopen enquiry
          </Button>
        )}
      </div>

      {/* ---------------- Submit confirmation ---------------- */}
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'full' ? 'Close this enquiry?' : 'Submit the responses so far?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'full'
                ? 'Every line is resolved. Closing records who closed it and when, and the enquiry becomes read-only.'
                : 'Pending lines stay open and can still receive vendor responses afterwards.'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <dl className="grid grid-cols-3 gap-3 rounded-md border border-line bg-surface-2 p-3 text-center">
            {[
              { label: 'Responded', value: resolved - noVendor },
              { label: 'No vendor', value: noVendor },
              { label: 'Unresolved', value: pendingLines.length },
            ].map((stat) => (
              <div key={stat.label}>
                <dt className="text-[11px] uppercase tracking-wider text-muted">{stat.label}</dt>
                <dd className="mt-1 font-mono text-lg text-ink tabular">
                  {stat.value}
                  <span className="text-xs text-muted"> / {enquiry.products.length}</span>
                </dd>
              </div>
            ))}
          </dl>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirm) runSubmit(confirm);
              }}
              disabled={pending}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {confirm === 'full' ? 'Close enquiry' : 'Partial submit'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---------------- Delay reason ---------------- */}
      <Dialog open={delayOpen} onOpenChange={setDelayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="size-4 text-warning" />
              Response deadline exceeded
            </DialogTitle>
            <DialogDescription>
              This enquiry passed its fifteen-minute window. Record why before submitting — the
              reason is kept for review and cannot be edited later.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delayReason">Reason for delay</Label>
            <Textarea
              id="delayReason"
              value={delayReason}
              onChange={(e) => setDelayReason(e.target.value)}
              placeholder="Vendor did not respond on time."
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDelayOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submitDelayReason} disabled={pending || delayReason.trim().length < 5}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Submit reason
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Reassign ---------------- */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign enquiry</DialogTitle>
            <DialogDescription>
              The change is recorded on the timeline with both names.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assignee">Towards</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger id="assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignees.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} · {a.employeeId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={saveAssignment} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- Reopen ---------------- */}
      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen this enquiry?</DialogTitle>
            <DialogDescription>
              The recorded response time and efficiency stay exactly as they were — reopening does
              not un-answer the enquiry.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reopenReason">Reason</Label>
            <Textarea
              id="reopenReason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Customer came back with changes."
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={confirmReopen} disabled={pending || reopenReason.trim().length < 5}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
