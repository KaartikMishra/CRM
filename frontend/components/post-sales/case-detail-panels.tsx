'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Check, Loader2, Trash2, UserCheck, UserX } from 'lucide-react';
import {
  POST_SALES_ATTACHMENT_KINDS,
  POST_SALES_ATTACHMENT_KIND_LABELS,
  POST_SALES_CASE_STATUS_LABELS,
  POST_SALES_COMMUNICATION_CHANNELS,
  POST_SALES_COMMUNICATION_CHANNEL_LABELS,
  POST_SALES_PRIORITIES,
  POST_SALES_PRIORITY_LABELS,
  type PostSalesActivityKind,
  type PostSalesAttachmentKind,
  type PostSalesCaseStatus,
  type PostSalesCaseView,
  type PostSalesPriority,
  type UserRef,
} from '@rs/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ImageUploadField } from '@/components/product-enquiry/image-upload-field';
import { formatDateTime } from '@/lib/format';
import { CasePriorityBadge, CaseStatusBadge } from './post-sales-badges';
import {
  addCaseActivityAction,
  addCaseAttachmentAction,
  assignCaseAction,
  changeCaseStatusAction,
  removeCaseAttachmentAction,
  updateCaseAction,
  updateCaseActivityAction,
  fetchCaseAssigneesAction,
} from '@/app/(app)/post-sales/actions';

/**
 * The case detail controls, as one client island.
 *
 * Status, priority, allocation, timeline and attachments. Every write goes through
 * a server action to the API, and **nothing here decides a business outcome**: the
 * status buttons are built from `nextStatuses`, which the server derived from the
 * shared transition map, so a button that exists is a move the API will accept and
 * a move it refuses was never offered.
 *
 * Phase 1 shows no Returns, Replacements, Refunds, Exchanges, Warranty, SLA or CSAT
 * section. None of that exists yet, and a disabled control for an unbuilt feature
 * is a promise the module cannot keep.
 */
export function CaseControls({
  view,
  canEdit,
  canAssign,
}: {
  view: PostSalesCaseView;
  canEdit: boolean;
  canAssign: boolean;
}) {
  return (
    <Card className="grid gap-5 p-4 lg:grid-cols-2">
      <StatusControl view={view} canEdit={canEdit} />
      <AllocationControl view={view} canAssign={canAssign} />
    </Card>
  );
}

const UNASSIGNED = '__unassigned__';

function StatusControl({ view, canEdit }: { view: PostSalesCaseView; canEdit: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function move(status: PostSalesCaseStatus): void {
    setError(null);
    startSaving(async () => {
      const result = await changeCaseStatusAction(view.id, {
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNote('');
      router.refresh();
    });
  }

  function setPriority(priority: PostSalesPriority): void {
    if (priority === view.priority) return;
    setError(null);
    startSaving(async () => {
      const result = await updateCaseAction(view.id, { priority });
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
        <span className="text-xs text-muted">Status</span>
        <div className="flex items-center gap-2">
          <CaseStatusBadge status={view.status} />
          {saving && <Loader2 className="size-4 animate-spin text-muted" />}
        </div>
      </div>

      {canEdit && (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">Move the case</span>
            {/*
              Built from what the server said is permitted. An empty list means the
              case is at a dead end — only CLOSED is, and its one exit is REOPENED.
            */}
            {view.nextStatuses.length === 0 ? (
              <p className="text-xs text-muted">This case cannot move from here.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {view.nextStatuses.map((status) => (
                  <Button
                    key={status}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => move(status)}
                  >
                    {POST_SALES_CASE_STATUS_LABELS[status]}
                  </Button>
                ))}
              </div>
            )}

            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why (optional) — recorded on the timeline"
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">Priority</span>
            <div className="flex flex-wrap gap-2">
              {POST_SALES_PRIORITIES.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={p === view.priority ? 'default' : 'outline'}
                  aria-pressed={p === view.priority}
                  disabled={saving || p === view.priority}
                  onClick={() => setPriority(p)}
                >
                  {POST_SALES_PRIORITY_LABELS[p]}
                </Button>
              ))}
            </div>
          </div>
        </>
      )}

      {!canEdit && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Priority</span>
          <CasePriorityBadge priority={view.priority} />
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

function AllocationControl({
  view,
  canAssign,
}: {
  view: PostSalesCaseView;
  canAssign: boolean;
}) {
  const router = useRouter();
  const [assignees, setAssignees] = useState<UserRef[]>([]);
  const [choice, setChoice] = useState(view.assignedTo?.id ?? UNASSIGNED);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // Loaded once, and only for somebody who can allocate — a read-only viewer has
  // nothing they could do with the list.
  useEffect(() => {
    if (!canAssign) return;
    let live = true;
    void fetchCaseAssigneesAction().then((result) => {
      if (live && result.ok) setAssignees(result.data.assignees as UserRef[]);
    });
    return () => {
      live = false;
    };
  }, [canAssign]);

  const current = view.assignedTo?.id ?? UNASSIGNED;

  function save(): void {
    setError(null);
    startSaving(async () => {
      const result = await assignCaseAction(view.id, {
        assignedToId: choice === UNASSIGNED ? null : choice,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted">Assigned to</span>
          <span className="text-ink">{view.assignedTo?.name ?? 'Unassigned'}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted">Raised by</span>
          <span className="text-ink">{view.raisedBy.name}</span>
        </div>
      </div>

      {canAssign && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="assignee">{view.assignedTo ? 'Reassign to' : 'Assign to'}</Label>
          <div className="flex flex-wrap gap-2">
            <Select value={choice} onValueChange={setChoice} disabled={saving}>
              <SelectTrigger id="assignee" className="min-w-48 flex-1">
                <SelectValue placeholder="Choose an employee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {assignees.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} · {u.employeeId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={saving || choice === current}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : choice === UNASSIGNED ? (
                <UserX className="size-4" />
              ) : (
                <UserCheck className="size-4" />
              )}
              {choice === UNASSIGNED ? 'Unassign' : 'Assign'}
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
//  Timeline
// ---------------------------------------------------------------------------

/** What a follow-up's state is, derived from its own two timestamps and now. */
function followUpState(dueAt: string | null, completedAt: string | null, now: Date): string | null {
  if (!dueAt) return null;
  if (completedAt) return new Date(completedAt) <= new Date(dueAt) ? 'Completed' : 'Completed late';
  return new Date(dueAt) <= now ? 'Overdue' : 'Upcoming';
}

const KIND_LABEL: Record<PostSalesActivityKind, string> = {
  SYSTEM: 'System',
  NOTE: 'Note',
  INTERNAL_NOTE: 'Internal note',
  CUSTOMER_COMMUNICATION: 'Customer communication',
  FOLLOW_UP: 'Follow-up',
  STATUS_CHANGE: 'Status change',
  ASSIGNMENT_CHANGE: 'Assignment change',
};

/**
 * The timeline, and the form that adds to it.
 *
 * Notes, internal notes, logged conversations and follow-ups all live in one list
 * discriminated by kind — which is also how they are stored, so the screen and the
 * table agree about what an entry is.
 *
 * An internal note is visibly marked as internal. **Server-side authorization is
 * what actually protects it**: this badge is a courtesy to the reader, not a
 * security boundary, and the API refuses the whole case to anybody without VIEW.
 */
export function CaseTimeline({
  view,
  canEdit,
}: {
  view: PostSalesCaseView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<PostSalesActivityKind>('NOTE');
  const [note, setNote] = useState('');
  const [channel, setChannel] = useState('');
  const [direction, setDirection] = useState('OUTGOING');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // One clock for the whole render, so two entries a millisecond apart are not
  // judged against different "now"s.
  const now = new Date();

  function add(): void {
    setError(null);

    if (note.trim() === '') {
      setError('Enter what happened.');
      return;
    }

    const payload: Record<string, unknown> = { kind, note: note.trim() };

    if (kind === 'CUSTOMER_COMMUNICATION') {
      if (channel === '') {
        setError('Choose how the customer was contacted.');
        return;
      }
      payload.channel = channel;
      payload.direction = direction;
    }

    if (kind === 'FOLLOW_UP') {
      if (dueDate === '' || dueTime === '') {
        setError('Choose when this follow-up is due.');
        return;
      }
      const [y, m, d] = dueDate.split('-').map(Number);
      const [h, min] = dueTime.split(':').map(Number);
      payload.dueAt = new Date(y!, m! - 1, d!, h!, min!).toISOString();
    }

    startSaving(async () => {
      const result = await addCaseActivityAction(
        view.id,
        payload as Parameters<typeof addCaseActivityAction>[1],
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNote('');
      setDueDate('');
      setDueTime('');
      router.refresh();
    });
  }

  function complete(activityId: string): void {
    startSaving(async () => {
      const result = await updateCaseActivityAction(view.id, activityId, {
        completedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold text-ink">Timeline</h2>
        <p className="text-xs text-muted">
          Notes, conversations and follow-ups, newest first.
        </p>
      </div>

      {canEdit && (
        <div className="flex flex-col gap-3 rounded-md border border-line-2 bg-surface-2 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kind">Entry type</Label>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as PostSalesActivityKind)}
                disabled={saving}
              >
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Only the four a person may add. SYSTEM, STATUS_CHANGE and
                      ASSIGNMENT_CHANGE are written by the service. */}
                  {(
                    ['NOTE', 'INTERNAL_NOTE', 'CUSTOMER_COMMUNICATION', 'FOLLOW_UP'] as const
                  ).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {kind === 'CUSTOMER_COMMUNICATION' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="channel">Channel</Label>
                  <Select value={channel} onValueChange={setChannel} disabled={saving}>
                    <SelectTrigger id="channel">
                      <SelectValue placeholder="How was the customer contacted?" />
                    </SelectTrigger>
                    <SelectContent>
                      {POST_SALES_COMMUNICATION_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {POST_SALES_COMMUNICATION_CHANNEL_LABELS[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="direction">Direction</Label>
                  <Select value={direction} onValueChange={setDirection} disabled={saving}>
                    <SelectTrigger id="direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OUTGOING">Outgoing</SelectItem>
                      <SelectItem value="INCOMING">Incoming</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {kind === 'FOLLOW_UP' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="dueDate">Due date</Label>
                  <Input
                    id="dueDate"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="dueTime">Due time</Label>
                  <Input
                    id="dueTime"
                    type="time"
                    value={dueTime}
                    onChange={(e) => setDueTime(e.target.value)}
                    disabled={saving}
                  />
                </div>
              </>
            )}
          </div>

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              kind === 'CUSTOMER_COMMUNICATION'
                ? 'What was said'
                : kind === 'FOLLOW_UP'
                  ? 'What needs doing'
                  : 'What happened'
            }
            rows={2}
            disabled={saving}
          />

          {kind === 'CUSTOMER_COMMUNICATION' && (
            /*
              Said plainly rather than offering a Send button that does nothing:
              there is no WhatsApp, email or SMS integration in this CRM, and a
              control implying otherwise would claim a message nobody sent.
            */
            <p className="text-xs text-muted">
              This records a conversation that already happened. Sending messages from the CRM
              is not available.
            </p>
          )}

          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}

          <Button type="button" size="sm" onClick={add} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Add entry
          </Button>
        </div>
      )}

      {view.activities.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-2 px-4 py-8 text-center text-sm text-muted">
          No activity yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.activities.map((a) => {
            const state = followUpState(a.dueAt, a.completedAt, now);
            return (
              <li
                key={a.id}
                className="flex flex-col gap-1 rounded-md border border-line-2 bg-surface p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{KIND_LABEL[a.kind]}</span>

                  {a.kind === 'INTERNAL_NOTE' && <Badge variant="warning">Internal</Badge>}

                  {a.channel && (
                    <Badge variant="neutral">
                      {POST_SALES_COMMUNICATION_CHANNEL_LABELS[a.channel]}
                      {a.direction === 'INCOMING' ? ' · in' : ' · out'}
                    </Badge>
                  )}

                  {state && (
                    <Badge
                      variant={
                        state === 'Overdue'
                          ? 'critical'
                          : state === 'Completed late'
                            ? 'warning'
                            : state === 'Completed'
                              ? 'positive'
                              : 'neutral'
                      }
                    >
                      {state}
                    </Badge>
                  )}

                  {canEdit && a.kind === 'FOLLOW_UP' && a.completedAt === null && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => complete(a.id)}
                      disabled={saving}
                    >
                      <Check className="size-4" />
                      Mark done
                    </Button>
                  )}
                </div>

                <p className="text-sm text-ink-2">{a.note}</p>

                <p className="text-xs text-muted">
                  {formatDateTime(a.createdAt)}
                  {a.performedBy && ` · ${a.performedBy.name}`}
                  {a.dueAt && ` · due ${formatDateTime(a.dueAt)}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
//  Attachments
// ---------------------------------------------------------------------------

/**
 * Case attachments.
 *
 * Reuses the existing upload field, which streams to Cloudinary through the one
 * upload route in this CRM and enforces its own type and size rules. Phase 1
 * therefore accepts JPEG, PNG, WebP and GIF — PDF and video are genuinely needed
 * and genuinely unsupported today, and that limit is stated to the user rather
 * than discovered through a failure.
 *
 * Removing an attachment detaches it. The underlying image is retained, because
 * several tables may reference the same asset.
 */
export function CaseAttachments({
  view,
  canEdit,
}: {
  view: PostSalesCaseView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<PostSalesAttachmentKind>('PRODUCT_PHOTO');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function attach(assetId: string | null): void {
    if (!assetId) return;
    setError(null);
    startSaving(async () => {
      const result = await addCaseAttachmentAction(view.id, { mediaAssetId: assetId, kind });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function detach(attachmentId: string): void {
    startSaving(async () => {
      const result = await removeCaseAttachmentAction(view.id, attachmentId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold text-ink">Attachments</h2>
        <p className="text-xs text-muted">
          Photos of the product, the packaging or a screenshot. Images only in this release.
        </p>
      </div>

      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <ImageUploadField label="Add an image" value={null} onChange={attach} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attachmentKind">What does it show?</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as PostSalesAttachmentKind)}
              disabled={saving}
            >
              <SelectTrigger id="attachmentKind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POST_SALES_ATTACHMENT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {POST_SALES_ATTACHMENT_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted">
              Chosen before uploading, so the image is filed as you add it.
            </p>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}

      {view.attachments.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-2 px-4 py-6 text-center text-sm text-muted">
          No attachments yet.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {view.attachments.map((a) => (
            <li key={a.id} className="flex flex-col gap-1">
              <div className="relative aspect-square overflow-hidden rounded-md border border-line-2 bg-surface-2">
                {a.media ? (
                  <Image
                    src={a.media.secureUrl}
                    alt={POST_SALES_ATTACHMENT_KIND_LABELS[a.kind]}
                    fill
                    sizes="200px"
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-xs text-faint">
                    Image removed
                  </span>
                )}

                {canEdit && (
                  <button
                    type="button"
                    onClick={() => detach(a.id)}
                    disabled={saving}
                    aria-label="Remove attachment"
                    className="absolute right-1.5 top-1.5 rounded-sm bg-surface/90 p-1 text-ink-2 shadow-card transition-colors hover:text-critical"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>

              <span className="text-xs text-muted">
                {POST_SALES_ATTACHMENT_KIND_LABELS[a.kind]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
