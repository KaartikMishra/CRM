/**
 * The follow-up workflow and the two value figures — frontend.
 *
 * Both halves of the post-4F correction. The status derivation, the date/time
 * handling and the patch diff are exercised as real functions; the panel and the
 * detail page are read as source to prove the labelling facts a DOM-less test
 * cannot reach — that an overdue action is never drawn as upcoming, and that a
 * requirement estimate is never printed under "Order Value".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEAD_ACTIVITY_KINDS,
  LEAD_ACTIVITY_KIND_LABELS,
  leadActivitySchema,
  updateLeadActivitySchema,
  type LeadActivityView,
} from '@rs/shared';
import {
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUS_VARIANTS,
  activityDraftErrors,
  activityDraftOf,
  activityPayload,
  activityUpdatePayload,
  combineDueAt,
  completionPayload,
  emptyActivityDraft,
  groupActivities,
  hasActivityChanges,
  isActivityValid,
  reopenPayload,
  statusOf,
  type ActivityDraft,
} from '@/components/leads/activity-logic';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const panel = read('components/leads/activity-panel.tsx');
const logic = read('components/leads/activity-logic.ts');
const detail = read('app/(app)/leads/[id]/page.tsx');
const table = read('components/leads/lead-table.tsx');
const actions = read('app/(app)/leads/actions.ts');

const NOW = new Date('2026-10-05T12:00:00.000Z');
const at = (hours: number): string => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const activity = (over: Partial<LeadActivityView> = {}): LeadActivityView =>
  ({
    id: 'cuikact0000000000000000001',
    kind: 'FOLLOW_UP',
    dueAt: at(24),
    completedAt: null,
    performedBy: null,
    note: null,
    createdAt: at(-48),
    ...over,
  }) as LeadActivityView;

// ---------------------------------------------------------------------------
//  Status
// ---------------------------------------------------------------------------

describe('activity status', () => {
  it('is UPCOMING for a future incomplete action', () => {
    expect(statusOf(activity({ dueAt: at(24) }), NOW)).toBe('UPCOMING');
  });

  it('is OVERDUE for a past incomplete action', () => {
    expect(statusOf(activity({ dueAt: at(-24) }), NOW)).toBe('OVERDUE');
  });

  it('is COMPLETED when done by the deadline', () => {
    expect(
      statusOf(activity({ dueAt: at(-24), completedAt: at(-25) }), NOW),
    ).toBe('COMPLETED');
  });

  it('treats completion exactly on the deadline as on time', () => {
    // Matches `promptness` exactly: completedAt <= dueAt is on time.
    expect(statusOf(activity({ dueAt: at(-24), completedAt: at(-24) }), NOW)).toBe('COMPLETED');
  });

  it('is COMPLETED_LATE when done after the deadline', () => {
    expect(statusOf(activity({ dueAt: at(-24), completedAt: at(-2) }), NOW)).toBe(
      'COMPLETED_LATE',
    );
  });

  it('treats early completion as on time, not as its own state', () => {
    expect(statusOf(activity({ dueAt: at(-24), completedAt: at(-48) }), NOW)).toBe('COMPLETED');
  });

  it('distinguishes late from outstanding', () => {
    /*
      Both have a passed deadline; only one is still owed. Promptness scores them
      differently, so the badge has to as well.
    */
    const late = statusOf(activity({ dueAt: at(-24), completedAt: at(-2) }), NOW);
    const open = statusOf(activity({ dueAt: at(-24) }), NOW);
    expect(late).not.toBe(open);
    expect(open).toBe('OVERDUE');
  });

  it('labels and colours all four states', () => {
    for (const status of ['UPCOMING', 'OVERDUE', 'COMPLETED', 'COMPLETED_LATE'] as const) {
      expect(ACTIVITY_STATUS_LABELS[status], status).toBeTruthy();
      expect(ACTIVITY_STATUS_VARIANTS[status], status).toBeTruthy();
    }
    expect(ACTIVITY_STATUS_LABELS.COMPLETED_LATE).toBe('Completed late');
    expect(ACTIVITY_STATUS_VARIANTS.OVERDUE).toBe('critical');
    // Amber, not green — done, but not on time.
    expect(ACTIVITY_STATUS_VARIANTS.COMPLETED_LATE).toBe('warning');
    expect(ACTIVITY_STATUS_VARIANTS.COMPLETED).toBe('positive');
  });

  it('derives status rather than reading a stored field', () => {
    const code = codeOf(logic);
    expect(code).toContain('completedAt');
    expect(code).toContain('dueAt');
    // No persisted status anywhere in the contract.
    expect(code).not.toContain('activity.status');
  });
});

// ---------------------------------------------------------------------------
//  Grouping
// ---------------------------------------------------------------------------

describe('grouping', () => {
  it('splits into overdue, upcoming and history', () => {
    const { overdue, upcoming, history } = groupActivities(
      [
        activity({ id: 'a', dueAt: at(-24) }),
        activity({ id: 'b', dueAt: at(24) }),
        activity({ id: 'c', dueAt: at(-48), completedAt: at(-48) }),
      ],
      NOW,
    );

    expect(overdue.map((a) => a.id)).toEqual(['a']);
    expect(upcoming.map((a) => a.id)).toEqual(['b']);
    expect(history.map((a) => a.id)).toEqual(['c']);
  });

  it('puts the soonest upcoming first, so the head is the next follow-up', () => {
    const { upcoming } = groupActivities(
      [
        activity({ id: 'far', dueAt: at(72) }),
        activity({ id: 'soon', dueAt: at(24) }),
        activity({ id: 'mid', dueAt: at(48) }),
      ],
      NOW,
    );
    expect(upcoming.map((a) => a.id)).toEqual(['soon', 'mid', 'far']);
  });

  it('puts the longest overdue first', () => {
    const { overdue } = groupActivities(
      [activity({ id: 'recent', dueAt: at(-2) }), activity({ id: 'ancient', dueAt: at(-72) })],
      NOW,
    );
    expect(overdue.map((a) => a.id)).toEqual(['ancient', 'recent']);
  });

  it('puts the newest history first', () => {
    const { history } = groupActivities(
      [
        activity({ id: 'older', dueAt: at(-72), completedAt: at(-72) }),
        activity({ id: 'newer', dueAt: at(-48), completedAt: at(-2) }),
      ],
      NOW,
    );
    expect(history.map((a) => a.id)).toEqual(['newer', 'older']);
  });

  it('counts a late completion as history, not as overdue', () => {
    const { overdue, history } = groupActivities(
      [activity({ dueAt: at(-24), completedAt: at(-2) })],
      NOW,
    );
    expect(overdue).toHaveLength(0);
    expect(history).toHaveLength(1);
  });

  it('loses nothing', () => {
    const all = [
      activity({ id: 'a', dueAt: at(-24) }),
      activity({ id: 'b', dueAt: at(24) }),
      activity({ id: 'c', dueAt: at(-48), completedAt: at(-48) }),
      activity({ id: 'd', dueAt: at(-10), completedAt: at(-1) }),
    ];
    const g = groupActivities(all, NOW);
    expect(g.overdue.length + g.upcoming.length + g.history.length).toBe(all.length);
  });

  it('handles an empty list', () => {
    expect(groupActivities([], NOW)).toEqual({ overdue: [], upcoming: [], history: [] });
  });
});

// ---------------------------------------------------------------------------
//  Date and time
// ---------------------------------------------------------------------------

describe('combining the date and time inputs', () => {
  it('produces an ISO instant', () => {
    const iso = combineDueAt('2026-10-06', '11:00');
    expect(iso).not.toBeNull();
    const back = new Date(iso!);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(9);
    expect(back.getDate()).toBe(6);
    expect(back.getHours()).toBe(11);
    expect(back.getMinutes()).toBe(0);
  });

  it('is null when either half is missing', () => {
    expect(combineDueAt('', '11:00')).toBeNull();
    expect(combineDueAt('2026-10-06', '')).toBeNull();
    expect(combineDueAt('', '')).toBeNull();
  });

  it('rejects a date that does not exist', () => {
    // `new Date(2026, 1, 31)` silently rolls into March; the guard catches it.
    expect(combineDueAt('2026-02-31', '11:00')).toBeNull();
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(combineDueAt('2028-02-29', '09:00')).not.toBeNull();
    expect(combineDueAt('2027-02-29', '09:00')).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(combineDueAt('not-a-date', '11:00')).toBeNull();
    expect(combineDueAt('2026-10-06', 'teatime')).toBeNull();
  });

  it('round-trips an existing activity through the form and back', () => {
    const original = activity({ dueAt: at(24) });
    const draft = activityDraftOf(original);
    const back = combineDueAt(draft.dueDate, draft.dueTime);

    // To the minute: the inputs carry no seconds.
    expect(new Date(back!).getTime()).toBeCloseTo(
      Math.floor(new Date(original.dueAt).getTime() / 60000) * 60000,
      -2,
    );
  });
});

describe('draft validation', () => {
  it('requires both halves of the due moment', () => {
    const errors = activityDraftErrors(emptyActivityDraft());
    expect(errors.dueDate).toBeTruthy();
    expect(errors.dueTime).toBeTruthy();
  });

  it('accepts a complete draft', () => {
    const draft: ActivityDraft = {
      ...emptyActivityDraft(),
      dueDate: '2026-10-06',
      dueTime: '11:00',
    };
    expect(isActivityValid(draft)).toBe(true);
  });

  it('does not require a note', () => {
    const draft: ActivityDraft = {
      ...emptyActivityDraft(),
      dueDate: '2026-10-06',
      dueTime: '11:00',
      note: '',
    };
    expect(isActivityValid(draft)).toBe(true);
  });

  it('defaults a new activity to a follow-up, uncompleted', () => {
    const draft = emptyActivityDraft();
    expect(draft.kind).toBe('FOLLOW_UP');
    expect(draft.completed).toBe(false);
  });

  it('can start as a first contact instead', () => {
    expect(emptyActivityDraft('FIRST_CONTACT').kind).toBe('FIRST_CONTACT');
  });
});

// ---------------------------------------------------------------------------
//  Payloads
// ---------------------------------------------------------------------------

describe('the create payload', () => {
  const ready = (over: Partial<ActivityDraft> = {}): ActivityDraft => ({
    ...emptyActivityDraft(),
    dueDate: '2026-10-06',
    dueTime: '11:00',
    ...over,
  });

  it('carries the kind, the due moment and the note', () => {
    const payload = activityPayload(
      ready({ note: 'Call customer and confirm dinner set quantity.' }),
    )!;
    expect(payload.kind).toBe('FOLLOW_UP');
    expect(payload.dueAt).toBeTruthy();
    expect(payload.note).toBe('Call customer and confirm dinner set quantity.');
  });

  it('sends no completion for a scheduled action', () => {
    /*
      The rule the whole measurement rests on: scheduling is not performing, and
      an absent `completedAt` is what tells the API this is still owed. Defaulting
      it to now would make every new follow-up instantly "done".
    */
    expect(activityPayload(ready())!.completedAt).toBeUndefined();
  });

  it('sends a completion when the work already happened', () => {
    const payload = activityPayload(ready({ completed: true }))!;
    expect(payload.completedAt).toBe(payload.dueAt);
  });

  it('omits an empty note rather than sending a blank string', () => {
    expect(activityPayload(ready({ note: '   ' }))!.note).toBeUndefined();
  });

  it('never sends a performer — the API takes that from the session', () => {
    const payload = activityPayload(ready({ completed: true }))!;
    expect(payload.performedById).toBeUndefined();
  });

  it('is null for an invalid draft', () => {
    expect(activityPayload(ready({ dueDate: '' }))).toBeNull();
  });

  it('satisfies the shared contract', () => {
    for (const kind of LEAD_ACTIVITY_KINDS) {
      const payload = activityPayload(ready({ kind }))!;
      const result = leadActivitySchema.safeParse(payload);
      expect(result.success, `${kind}: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

describe('the completion payload', () => {
  it('is just the instant', () => {
    const payload = completionPayload(NOW);
    expect(payload).toEqual({ completedAt: NOW.toISOString() });
  });

  it('satisfies the update contract', () => {
    expect(updateLeadActivitySchema.safeParse(completionPayload(NOW)).success).toBe(true);
  });

  it('reopening sends an explicit null', () => {
    expect(reopenPayload()).toEqual({ completedAt: null });
    expect(updateLeadActivitySchema.safeParse(reopenPayload()).success).toBe(true);
  });
});

describe('the update payload', () => {
  const draftFor = (a: LeadActivityView, over: Partial<ActivityDraft> = {}): ActivityDraft => ({
    ...activityDraftOf(a),
    ...over,
  });

  it('is empty for an untouched draft', () => {
    const original = activity({ note: 'Original' });
    expect(activityUpdatePayload(original, draftFor(original))).toEqual({});
    expect(hasActivityChanges(original, draftFor(original))).toBe(false);
  });

  it('sends only the rescheduled due moment', () => {
    const original = activity();
    const patch = activityUpdatePayload(original, draftFor(original, { dueDate: '2026-12-01' }));
    expect(Object.keys(patch)).toEqual(['dueAt']);
  });

  it('clears a note with an explicit null', () => {
    const original = activity({ note: 'Original' });
    expect(activityUpdatePayload(original, draftFor(original, { note: '' })).note).toBeNull();
  });

  it('completes and reopens through completedAt', () => {
    const open = activity({ dueAt: at(-24) });
    expect(activityUpdatePayload(open, draftFor(open, { completed: true })).completedAt).toBeTruthy();

    const done = activity({ dueAt: at(-24), completedAt: at(-24) });
    expect(activityUpdatePayload(done, draftFor(done, { completed: false })).completedAt).toBeNull();
  });

  it('never sends the kind, which is immutable', () => {
    /*
      Phase 4D made kind immutable — turning a FIRST_CONTACT into a RESULT
      rewrites history rather than correcting it — and the update schema has no
      such field, so there is nothing to send.
    */
    const original = activity({ kind: 'FIRST_CONTACT' });
    const patch = activityUpdatePayload(original, draftFor(original, { kind: 'RESULT' as never }));
    expect(patch.kind).toBeUndefined();
    expect(Object.keys(updateLeadActivitySchema._def.schema.shape)).not.toContain('kind');
  });

  it('never sends a leadId', () => {
    const original = activity();
    const patch = activityUpdatePayload(original, draftFor(original, { note: 'moved' }));
    expect(patch.leadId).toBeUndefined();
  });

  it('produces a patch the shared schema accepts', () => {
    const original = activity();
    const patch = activityUpdatePayload(original, draftFor(original, { dueDate: '2026-12-01' }));
    expect(updateLeadActivitySchema.safeParse(patch).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  The panel
// ---------------------------------------------------------------------------

describe('the activity panel', () => {
  it('offers both entry points an associate needs', () => {
    const code = codeOf(panel);
    expect(code).toContain('First contact');
    expect(code).toContain('Schedule follow-up');
  });

  it('lets the type be chosen from the shared vocabulary', () => {
    const code = codeOf(panel);
    expect(code).toContain('LEAD_ACTIVITY_KINDS.map');
    expect(code).toContain('LEAD_ACTIVITY_KIND_LABELS');
    // Not retyped, so a label cannot drift from what the API accepts.
    expect(code).not.toContain("'Follow-up'");
    expect([...LEAD_ACTIVITY_KINDS]).toEqual(['FIRST_CONTACT', 'FOLLOW_UP', 'RESULT']);
    expect(LEAD_ACTIVITY_KIND_LABELS.FIRST_CONTACT).toBe('First contact');
  });

  it('collects a date and a time separately', () => {
    const code = codeOf(panel);
    expect(code).toContain('type="date"');
    expect(code).toContain('type="time"');
  });

  it('collects an optional note', () => {
    expect(codeOf(panel)).toContain('Textarea');
  });

  it('offers Mark completed only on an open activity', () => {
    const code = codeOf(panel);
    expect(code).toContain('Mark completed');
    expect(code).toContain('activity.completedAt === null');
    expect(code).toContain('completionPayload()');
  });

  it('offers Edit, through the existing PATCH', () => {
    const code = codeOf(panel);
    expect(code).toContain('updateActivityAction');
    expect(code).toContain('activityUpdatePayload');
  });

  it('shows the kind read-only when editing', () => {
    expect(codeOf(panel)).toContain('LEAD_ACTIVITY_KIND_LABELS[activity.kind]');
    expect(codeOf(panel)).toContain('disabled');
  });

  it('renders the three groups overdue-first', () => {
    const code = codeOf(panel);
    const overdue = code.indexOf('title="Overdue"');
    const upcoming = code.indexOf('title="Upcoming"');
    const history = code.indexOf('title="History"');
    expect(overdue).toBeGreaterThan(-1);
    expect(overdue).toBeLessThan(upcoming);
    expect(upcoming).toBeLessThan(history);
  });

  it('shows who performed a completed activity', () => {
    expect(codeOf(panel)).toContain('activity.performedBy');
  });

  it('takes one clock for the whole render', () => {
    // Two "now"s would let the grouping disagree with the badges.
    const code = codeOf(panel);
    expect(code.match(/new Date\(\)/g)).toHaveLength(1);
  });

  it('has empty, saving and error states', () => {
    const code = codeOf(panel);
    expect(code).toContain('No activity recorded yet');
    expect(code).toContain('animate-spin');
    expect(code).toContain('role="alert"');
    expect(code).toContain('setError(result.message)');
  });

  it('explains itself to a read-only viewer', () => {
    expect(panel).toContain('do not have permission to record activity');
  });

  it('recomputes no derived figure', () => {
    /*
      Last, Next and promptness all arrive on the response the write returns.
      Only the status badge is derived here, from the same comparison the backend
      makes.
    */
    const code = codeOf(panel);
    expect(code).not.toContain('lastFollowUpAt');
    expect(code).not.toContain('nextFollowUpAt');
    expect(code).not.toContain('onTime /');
  });

  it('reuses the existing endpoints and adds none', () => {
    const code = codeOf(actions);
    expect(code).toContain('`/api/leads/${leadId}/activities`');
    expect(code).toContain('`/api/leads/${leadId}/activities/${activityId}`');
    /*
      No activity delete: history is a record, not a scratchpad, and the business
      rules never authorised removing one. The requirement delete that does exist
      is Phase 4F's and a different thing, so this checks for an activity-scoped
      delete specifically rather than the verb anywhere in the file.
    */
    expect(code).not.toContain('deleteActivityAction');
    expect(code).not.toMatch(/activities\/\$\{activityId\}`,\s*\{\s*method:\s*'DELETE'/);
  });

  it('refreshes the board as well as the detail', () => {
    // Last and Next Follow-up are columns on /leads.
    expect(codeOf(actions)).toContain("revalidatePath('/leads')");
  });
});

// ---------------------------------------------------------------------------
//  The two values
// ---------------------------------------------------------------------------

describe('order value and requirement value are labelled apart', () => {
  it('shows both on the detail page', () => {
    const code = codeOf(detail);
    expect(code).toContain('Order Value');
    expect(code).toContain('Requirement Value');
  });

  it('says a lead has no order rather than showing a bare dash', () => {
    expect(detail).toContain('Not converted to an order');
  });

  it('never prints zero for a missing order', () => {
    /*
      The failure mode this guards: ₹0.00 under "Order Value" would claim a sale
      that totalled nothing, when the truth is there is no sale.
    */
    const code = codeOf(detail);
    expect(code).toContain('lead.orderValue != null');
    expect(code).not.toMatch(/orderValue\s*\?\?\s*'0/);
    expect(code).not.toMatch(/formatCurrency\(lead\.orderValue \?\? /);
  });

  it('labels the requirement total as an estimate, not a sale', () => {
    expect(detail).toContain('an estimate, not a sale');
  });

  it('says nothing is priced rather than showing zero', () => {
    const code = codeOf(detail);
    expect(code).toContain('lead.requirementValue != null');
    expect(detail).toContain('Nothing priced yet');
  });

  it('gives the board its own Requirement Value column', () => {
    const code = codeOf(table);
    expect(code).toContain('Requirement Value');
    expect(code).toContain('lead.requirementValue == null');
    expect(code).toContain('formatCurrency(lead.requirementValue)');
  });

  it('keeps the board Order Value column reading the order', () => {
    const code = codeOf(table);
    expect(code).toContain('lead.orderValue == null');
    expect(code).toContain('formatCurrency(lead.orderValue)');
    // The one must never be rendered from the other.
    expect(code).not.toContain('orderValue ?? lead.requirementValue');
    expect(code).not.toContain('requirementValue ?? lead.orderValue');
  });

  it('sums nothing in the browser', () => {
    // The total is derived server-side, through the shared money arithmetic.
    const code = codeOf(table) + codeOf(detail);
    expect(code).not.toContain('reduce(');
    expect(code).not.toContain('productValue');
  });
});

// ---------------------------------------------------------------------------
//  Overdue, and what "next" means
// ---------------------------------------------------------------------------

describe('overdue is never presented as the next follow-up', () => {
  it('says None scheduled when work is owed but nothing is planned', () => {
    const code = codeOf(detail);
    expect(code).toContain('lead.promptness.overdue > 0');
    expect(detail).toContain('None scheduled');
  });

  it('surfaces the overdue count beside it', () => {
    expect(codeOf(detail)).toContain('overdue}');
  });

  it('shows first contact separately from the follow-up fields', () => {
    const code = codeOf(detail);
    expect(code).toContain('lead.firstContactAt');
    expect(detail).toContain('Not yet made');
  });

  it('agrees with the backend about what counts as next', () => {
    // An overdue incomplete follow-up groups as OVERDUE, never UPCOMING, which
    // is precisely what `nextFollowUpAt` excludes.
    const { upcoming, overdue } = groupActivities([activity({ dueAt: at(-24) })], NOW);
    expect(upcoming).toHaveLength(0);
    expect(overdue).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

describe('this correction stays in its lane', () => {
  it('adds no activity or follow-up table', () => {
    const code = codeOf(panel) + codeOf(logic) + codeOf(actions);
    expect(code).not.toContain('FollowUp');
    expect(code).not.toContain('reminder');
  });

  it('adds no permission vocabulary', () => {
    const code = codeOf(panel) + codeOf(logic) + codeOf(actions) + codeOf(detail);
    const checks = [...code.matchAll(/can\([^,]+,\s*'([A-Z_]+)'\s*,\s*'([A-Z_]+)'\)/g)];
    expect(new Set(checks.map((m) => m[1]))).toEqual(new Set(['LEAD_DEAL']));
  });

  it('touches no order, stock or dispatch path', () => {
    const code = codeOf(panel) + codeOf(logic) + codeOf(actions);
    for (const absent of ['salesOrder', 'crmStockQty', 'inventoryQty', 'dispatch']) {
      expect(code, absent).not.toContain(absent);
    }
  });
});
