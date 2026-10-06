'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserCheck, UserX } from 'lucide-react';
import {
  DEAL_STATUSES,
  DEAL_STATUS_LABELS,
  type DealStatus,
  type LeadView,
  type UserRef,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AllocationBadge, DealStatusBadge } from './lead-badges';
import { assignLeadAction, fetchAssigneesAction, updateLeadAction } from '@/app/(app)/leads/actions';

/**
 * Allocating a lead, and moving its deal status.
 *
 * Two controls in one card because they are the two decisions somebody makes
 * about a lead they are looking at — but they are **separate operations behind
 * separate permissions**, and that separation is the point:
 *
 *   ASSIGN  deciding who owns the work
 *   EDIT    doing the work, including saying where the deal stands
 *
 * Phase 4C gave allocation its own endpoint precisely so the route table states
 * which capability each needs. This component honours that: a user holding EDIT
 * but not ASSIGN sees the status control and no allocation control, and cannot
 * smuggle an allocation through the status PATCH — the update contract accepts
 * only `dealStatus`, so there is no field to smuggle it in.
 */
export function LeadControls({
  lead,
  canEdit,
  canAssign,
}: {
  lead: LeadView;
  canEdit: boolean;
  canAssign: boolean;
}) {
  return (
    <Card className="grid gap-5 p-4 sm:grid-cols-2">
      <AllocationControl lead={lead} canAssign={canAssign} />
      <StatusControl lead={lead} canEdit={canEdit} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

/** The sentinel the Select uses for "nobody" — Radix forbids an empty value. */
const UNASSIGNED = '__unassigned__';

function AllocationControl({ lead, canAssign }: { lead: LeadView; canAssign: boolean }) {
  const router = useRouter();
  const [assignees, setAssignees] = useState<UserRef[]>([]);
  const [choice, setChoice] = useState(lead.associate?.id ?? UNASSIGNED);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  /*
    Loaded once, and only for somebody who can actually allocate. A VIEW-only
    reader sees the current state below without the list being fetched at all —
    there is nothing they could do with it.
  */
  useEffect(() => {
    if (!canAssign) return;
    let live = true;
    void fetchAssigneesAction().then((result) => {
      if (live && result.ok) setAssignees(result.data.assignees);
    });
    return () => {
      live = false;
    };
  }, [canAssign]);

  const current = lead.associate?.id ?? UNASSIGNED;
  const changed = choice !== current;

  function save(): void {
    setError(null);
    startSaving(async () => {
      const result = await assignLeadAction(lead.id, choice === UNASSIGNED ? null : choice);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Allocation</span>
        <div className="flex flex-wrap items-center gap-2">
          <AllocationBadge allocation={lead.allocation} />
          {/*
            SELF, OTHER_USER and UNASSIGNED are derived from the two ids by
            `allocationKind` on the server — never stored, and never recomputed
            here. The badge reports what the API said.
          */}
        </div>
      </div>

      <div className="grid gap-2 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted">Associate</span>
          <span className="text-ink">{lead.associate?.name ?? 'Unassigned'}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted">Allocated by</span>
          <span className="text-ink">{lead.allocatedBy?.name ?? '—'}</span>
        </div>
      </div>

      {canAssign && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="associate">
            {lead.associate ? 'Reassign to' : 'Assign to'}
          </Label>
          <div className="flex flex-wrap gap-2">
            <Select value={choice} onValueChange={setChoice} disabled={saving}>
              <SelectTrigger id="associate" className="min-w-48 flex-1">
                <SelectValue placeholder="Choose an associate" />
              </SelectTrigger>
              <SelectContent>
                {/* Clearing the allocation is a real choice, not a missing one. */}
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {assignees.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.name} · {user.employeeId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button type="button" size="sm" onClick={save} disabled={saving || !changed}>
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : choice === UNASSIGNED ? (
                <UserX className="size-4" />
              ) : (
                <UserCheck className="size-4" />
              )}
              {choice === UNASSIGNED ? 'Unassign' : 'Allocate'}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Deal status
// ---------------------------------------------------------------------------

/**
 * Where the deal stands.
 *
 * All three statuses are reachable in both directions, because the backend
 * permits it: `updateLeadSchema` accepts any member of DEAL_STATUSES and the
 * service records the change without a terminal-state rule. A deal marked WON by
 * mistake has to be correctable, so nothing here locks it.
 */
function StatusControl({ lead, canEdit }: { lead: LeadView; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function set(status: DealStatus): void {
    if (status === lead.dealStatus) return;
    setError(null);
    startSaving(async () => {
      const result = await updateLeadAction(lead.id, { dealStatus: status });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Deal status</span>
        <div className="flex items-center gap-2">
          <DealStatusBadge status={lead.dealStatus} />
          {saving && <Loader2 className="size-4 animate-spin text-muted" />}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-ink-2">Move the deal</span>
          <div className="flex flex-wrap gap-2">
            {DEAL_STATUSES.map((status) => (
              <Button
                key={status}
                type="button"
                size="sm"
                variant={status === lead.dealStatus ? 'default' : 'outline'}
                aria-pressed={status === lead.dealStatus}
                disabled={saving || status === lead.dealStatus}
                onClick={() => set(status)}
              >
                {DEAL_STATUS_LABELS[status]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted">
            In process while it is being worked; Won or Lost once it closes. Either close
            can be reopened.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
