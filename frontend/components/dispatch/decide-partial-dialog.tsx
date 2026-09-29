'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PartialDispatchRequestView } from '@rs/shared';
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
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/common/error-message';
import { formatDateTime } from '@/lib/format';
import { decidePartialRequestAction } from '@/app/(app)/dispatch/actions';

/**
 * Procurement's answer to a partial-dispatch request.
 *
 * Lives here rather than inside either screen because two modules ask the same
 * question: Packing & Dispatch shows it on the order, and Purchase &
 * Procurement shows it in the decision queue. One copy means one set of rules —
 * a second copy would be a second place for the reason/plan-of-action
 * asymmetry to drift.
 *
 * That asymmetry is the business rule, and it is stated in three places on
 * purpose: the shared Zod schema validates it, the database's CHECK constraints
 * enforce it, and this dialog asks for it.
 *
 *   ALLOW     reason required, plan of action optional — permitting needs no
 *             alternative plan, but it does need a justification on record.
 *   DISALLOW  reason AND plan of action required — a refusal leaves goods
 *             sitting, so somebody has to say what happens instead.
 *
 * The button is disabled until the rule is satisfied, but that is a courtesy:
 * the API re-checks and its refusal is what this displays.
 */
export function DecidePartialDialog({
  open,
  onOpenChange,
  decision,
  request,
  salesOrderId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decision: 'ALLOW' | 'DISALLOW';
  request: PartialDispatchRequestView;
  /** The order the request belongs to — revalidated after the decision. */
  salesOrderId: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [poa, setPoa] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const refusing = decision === 'DISALLOW';
  const incomplete = reason.trim() === '' || (refusing && poa.trim() === '');

  const submit = () => {
    setError(null);
    startSaving(async () => {
      const result = await decidePartialRequestAction(request.id, salesOrderId, {
        decision,
        reason: reason.trim(),
        ...(poa.trim() ? { poa: poa.trim() } : {}),
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      toast.success(refusing ? 'Partial dispatch refused.' : 'Partial dispatch allowed.');
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
            {refusing ? 'Disallow partial dispatch' : 'Allow partial dispatch'}
          </DialogTitle>
          <DialogDescription>
            {request.orderId} · asked by {request.requestedBy.name} ·{' '}
            {formatDateTime(request.requestedAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decide-reason">Reason</Label>
          <Textarea
            id="decide-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={refusing ? 'Why the goods should wait' : 'Why the ready part may go now'}
            rows={3}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decide-poa">Plan of action{refusing ? '' : ' (optional)'}</Label>
          <Textarea
            id="decide-poa"
            value={poa}
            onChange={(e) => setPoa(e.target.value)}
            placeholder={
              refusing ? 'What happens instead, and when' : 'What happens to the rest of the order'
            }
            rows={2}
          />
          {refusing && (
            <p className="text-xs text-muted">
              Required when refusing: the warehouse needs to know what to do with the goods.
            </p>
          )}
        </div>

        {error && <ErrorMessage message={error} />}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || incomplete}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {refusing ? 'Disallow partial dispatch' : 'Allow partial dispatch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
