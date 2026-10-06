/**
 * Post Sales & Grievance — Phase 1, frontend.
 *
 * The shared contracts and the transition map are exercised as real functions; the
 * pages and components are read as source to prove facts a DOM-less test cannot
 * reach — that no actor identity is sent, that no business figure is recomputed in
 * the browser, that internal notes are marked, and that no Phase 2–6 control is
 * offered.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_MODULES,
  POST_SALES_ACTIVITY_KINDS,
  POST_SALES_ATTACHMENT_KINDS,
  POST_SALES_CASE_NUMBER_PAD,
  POST_SALES_CASE_PREFIX,
  POST_SALES_CASE_STATUSES,
  POST_SALES_CASE_STATUS_LABELS,
  POST_SALES_CASE_TYPES,
  POST_SALES_CASE_TYPE_LABELS,
  POST_SALES_COMMUNICATION_CHANNELS,
  POST_SALES_ISSUE_CATEGORIES,
  POST_SALES_ISSUE_CATEGORY_LABELS,
  POST_SALES_ISSUE_GROUPS,
  POST_SALES_OPEN_STATUSES,
  POST_SALES_PRIORITIES,
  POST_SALES_SORTS,
  assignPostSalesCaseSchema,
  canTransitionCase,
  createPostSalesCaseSchema,
  isOpenCaseStatus,
  nextCaseStatuses,
  postSalesActivitySchema,
  postSalesListQuerySchema,
  updatePostSalesCaseSchema,
} from '@rs/shared';
import { NAV_ITEMS, visibleNavItems } from '@/components/layout/nav-items';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const codeOf = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const overview = read('app/(app)/post-sales/page.tsx');
const board = read('app/(app)/post-sales/cases/page.tsx');
const detail = read('app/(app)/post-sales/cases/[id]/page.tsx');
const newCase = read('app/(app)/post-sales/cases/new/page.tsx');
const actions = read('app/(app)/post-sales/actions.ts');
const table = read('components/post-sales/case-table.tsx');
const panels = read('components/post-sales/case-detail-panels.tsx');
const form = read('components/post-sales/create-case-form.tsx');
const badges = read('components/post-sales/post-sales-badges.tsx');
const apiClient = read('lib/post-sales-api.ts');

// ---------------------------------------------------------------------------
//  Vocabularies
// ---------------------------------------------------------------------------

describe('the shared vocabularies', () => {
  it('ships the fourteen case types the business named', () => {
    expect([...POST_SALES_CASE_TYPES]).toHaveLength(14);
    for (const t of POST_SALES_CASE_TYPES) {
      expect(POST_SALES_CASE_TYPE_LABELS[t], t).toBeTruthy();
    }
  });

  it('labels every issue category', () => {
    for (const c of POST_SALES_ISSUE_CATEGORIES) {
      expect(POST_SALES_ISSUE_CATEGORY_LABELS[c], c).toBeTruthy();
    }
  });

  it('places every issue category in exactly one group', () => {
    // A category in no group would never be offered by the picker.
    const grouped = POST_SALES_ISSUE_GROUPS.flatMap((g) => [...g.categories]);
    for (const c of POST_SALES_ISSUE_CATEGORIES) {
      expect(grouped.filter((g) => g === c), c).toHaveLength(1);
    }
    expect(grouped).toHaveLength(POST_SALES_ISSUE_CATEGORIES.length);
  });

  it('ships the eleven statuses and four priorities', () => {
    expect([...POST_SALES_CASE_STATUSES]).toHaveLength(11);
    expect([...POST_SALES_PRIORITIES]).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    for (const s of POST_SALES_CASE_STATUSES) {
      expect(POST_SALES_CASE_STATUS_LABELS[s], s).toBeTruthy();
    }
  });

  it('has no status meaning overdue — SLA is a later phase', () => {
    const joined = POST_SALES_CASE_STATUSES.join(',');
    expect(joined).not.toContain('OVERDUE');
    expect(joined).not.toContain('BREACH');
    expect(joined).not.toContain('ESCALATED');
  });

  it('names the case number format', () => {
    expect(POST_SALES_CASE_PREFIX).toBe('PS');
    expect(POST_SALES_CASE_NUMBER_PAD).toBe(6);
  });
});

// ---------------------------------------------------------------------------
//  The transition map
// ---------------------------------------------------------------------------

describe('status transitions', () => {
  it('permits the ordinary path to CLOSED', () => {
    expect(canTransitionCase('NEW', 'ASSIGNED')).toBe(true);
    expect(canTransitionCase('ASSIGNED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionCase('IN_PROGRESS', 'RESOLUTION_IN_PROGRESS')).toBe(true);
    expect(canTransitionCase('RESOLUTION_IN_PROGRESS', 'RESOLVED')).toBe(true);
    expect(canTransitionCase('RESOLVED', 'CLOSED')).toBe(true);
    expect(canTransitionCase('CLOSED', 'REOPENED')).toBe(true);
  });

  it('refuses NEW straight to CLOSED', () => {
    expect(canTransitionCase('NEW', 'CLOSED')).toBe(false);
  });

  it('refuses a self-transition, which is not a change', () => {
    for (const s of POST_SALES_CASE_STATUSES) {
      expect(canTransitionCase(s, s), s).toBe(false);
    }
  });

  it('lets RESOLVED go back to IN_PROGRESS without a false closure', () => {
    expect(canTransitionCase('RESOLVED', 'IN_PROGRESS')).toBe(true);
    // But not sideways into a blocked state.
    expect(canTransitionCase('RESOLVED', 'AWAITING_VENDOR')).toBe(false);
  });

  it('makes CLOSED near-terminal, with REOPENED its only exit', () => {
    expect([...nextCaseStatuses('CLOSED')]).toEqual(['REOPENED']);
  });

  it('moves between the four awaiting states directly', () => {
    expect(canTransitionCase('AWAITING_CUSTOMER', 'AWAITING_COURIER')).toBe(true);
    expect(canTransitionCase('AWAITING_VENDOR', 'IN_PROGRESS')).toBe(true);
  });

  it('counts REOPENED as open, and RESOLVED and CLOSED as not', () => {
    expect(isOpenCaseStatus('REOPENED')).toBe(true);
    expect(isOpenCaseStatus('RESOLVED')).toBe(false);
    expect(isOpenCaseStatus('CLOSED')).toBe(false);
    expect([...POST_SALES_OPEN_STATUSES]).toHaveLength(9);
  });

  it('gives every status a reachable set', () => {
    for (const s of POST_SALES_CASE_STATUSES) {
      expect(Array.isArray(nextCaseStatuses(s)), s).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
//  Contracts
// ---------------------------------------------------------------------------

describe('the create contract', () => {
  const valid = {
    customerId: 'cuikcust00000000000000001',
    caseType: 'COMPLAINT',
    issueCategory: 'DAMAGED_PRODUCT',
    subject: 'Dented on arrival',
    description: 'A dent on the rim.',
  };

  it('accepts the minimum: customer, type, issue, subject, description', () => {
    expect(createPostSalesCaseSchema.safeParse(valid).success).toBe(true);
  });

  it('defaults priority to MEDIUM', () => {
    expect(createPostSalesCaseSchema.parse(valid).priority).toBe('MEDIUM');
  });

  it('treats the order as optional', () => {
    expect(createPostSalesCaseSchema.parse(valid).salesOrderId).toBeUndefined();
  });

  it('refuses affected items with no order to belong to', () => {
    const result = createPostSalesCaseSchema.safeParse({
      ...valid,
      items: [{ salesOrderItemId: 'cuikitem00000000000000001', affectedQty: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses the same line listed twice', () => {
    const result = createPostSalesCaseSchema.safeParse({
      ...valid,
      salesOrderId: 'cuikord000000000000000001',
      items: [
        { salesOrderItemId: 'cuikitem00000000000000001', affectedQty: 1 },
        { salesOrderItemId: 'cuikitem00000000000000001', affectedQty: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a non-positive affected quantity', () => {
    for (const affectedQty of [0, -1, 1.5]) {
      const result = createPostSalesCaseSchema.safeParse({
        ...valid,
        salesOrderId: 'cuikord000000000000000001',
        items: [{ salesOrderItemId: 'cuikitem00000000000000001', affectedQty }],
      });
      expect(result.success, String(affectedQty)).toBe(false);
    }
  });

  it('accepts no actor identity, and no status', () => {
    const parsed = createPostSalesCaseSchema.parse({
      ...valid,
      raisedById: 'cuikuser00000000000000001',
      status: 'CLOSED',
      caseNumber: 'PS-2026-000001',
      resolvedAt: new Date().toISOString(),
    } as Record<string, unknown>);

    for (const absent of ['raisedById', 'status', 'caseNumber', 'resolvedAt']) {
      expect(parsed, absent).not.toHaveProperty(absent);
    }
  });

  it('refuses an empty subject or description', () => {
    expect(createPostSalesCaseSchema.safeParse({ ...valid, subject: '  ' }).success).toBe(false);
    expect(createPostSalesCaseSchema.safeParse({ ...valid, description: '' }).success).toBe(false);
  });
});

describe('the update contract', () => {
  it('cannot change the customer or the order', () => {
    // Those are what the case IS; correcting a mis-filed one means a new case.
    const parsed = updatePostSalesCaseSchema.parse({
      priority: 'HIGH',
      customerId: 'cuikcust00000000000000002',
      salesOrderId: 'cuikord000000000000000002',
    } as Record<string, unknown>);
    expect(parsed).toEqual({ priority: 'HIGH' });
  });

  it('cannot reassign — that is the ASSIGN endpoint', () => {
    const parsed = updatePostSalesCaseSchema.parse({
      priority: 'LOW',
      assignedToId: 'cuikuser00000000000000001',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('assignedToId');
  });

  it('cannot set a status — that is the status endpoint', () => {
    const parsed = updatePostSalesCaseSchema.parse({
      priority: 'LOW',
      status: 'CLOSED',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('status');
  });

  it('refuses an empty patch', () => {
    expect(updatePostSalesCaseSchema.safeParse({}).success).toBe(false);
  });
});

describe('the assign contract', () => {
  it('unassigns with an explicit null', () => {
    expect(assignPostSalesCaseSchema.parse({ assignedToId: null }).assignedToId).toBeNull();
  });

  it('never accepts who performed the allocation', () => {
    const parsed = assignPostSalesCaseSchema.parse({
      assignedToId: null,
      assignedById: 'cuikuser00000000000000001',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('assignedById');
  });
});

describe('the activity contract', () => {
  it('accepts a plain note', () => {
    expect(postSalesActivitySchema.safeParse({ kind: 'NOTE', note: 'Called.' }).success).toBe(true);
  });

  it('REFUSES a forged system entry', () => {
    for (const kind of ['SYSTEM', 'STATUS_CHANGE', 'ASSIGNMENT_CHANGE']) {
      expect(
        postSalesActivitySchema.safeParse({ kind, note: 'fake' }).success,
        kind,
      ).toBe(false);
    }
  });

  it('requires a channel and direction on a communication', () => {
    expect(
      postSalesActivitySchema.safeParse({ kind: 'CUSTOMER_COMMUNICATION', note: 'x' }).success,
    ).toBe(false);
    expect(
      postSalesActivitySchema.safeParse({
        kind: 'CUSTOMER_COMMUNICATION',
        note: 'x',
        channel: 'WHATSAPP',
        direction: 'OUTGOING',
      }).success,
    ).toBe(true);
  });

  it('refuses a channel on anything else', () => {
    expect(
      postSalesActivitySchema.safeParse({
        kind: 'NOTE',
        note: 'x',
        channel: 'PHONE',
        direction: 'INCOMING',
      }).success,
    ).toBe(false);
  });

  it('requires a due moment on a follow-up', () => {
    expect(postSalesActivitySchema.safeParse({ kind: 'FOLLOW_UP', note: 'x' }).success).toBe(false);
    expect(
      postSalesActivitySchema.safeParse({
        kind: 'FOLLOW_UP',
        note: 'x',
        dueAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it('never accepts a performer', () => {
    const parsed = postSalesActivitySchema.parse({
      kind: 'NOTE',
      note: 'x',
      performedById: 'cuikuser00000000000000001',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('performedById');
  });
});

describe('the board query', () => {
  it('uses the cursor convention, not page numbers', () => {
    const parsed = postSalesListQuerySchema.parse({});
    expect(parsed).toHaveProperty('limit');
    expect(parsed).not.toHaveProperty('page');
  });

  it('defaults to newest first', () => {
    const parsed = postSalesListQuerySchema.parse({});
    expect(parsed.sort).toBe('createdAt');
    expect(parsed.direction).toBe('desc');
  });

  it('allowlists sort fields', () => {
    for (const sort of POST_SALES_SORTS) {
      expect(postSalesListQuerySchema.safeParse({ sort }).success, sort).toBe(true);
    }
    expect(postSalesListQuerySchema.safeParse({ sort: 'customerName' }).success).toBe(false);
    expect(postSalesListQuerySchema.safeParse({ sort: 'id; DROP TABLE x' }).success).toBe(false);
  });

  it('omits lastActivityAt from the sort allowlist, because it is derived', () => {
    expect([...POST_SALES_SORTS]).not.toContain('lastActivityAt');
  });

  it('validates every filter against its vocabulary', () => {
    expect(postSalesListQuerySchema.safeParse({ status: 'NEW' }).success).toBe(true);
    expect(postSalesListQuerySchema.safeParse({ status: 'PENDING' }).success).toBe(false);
    expect(postSalesListQuerySchema.safeParse({ priority: 'CRITICAL' }).success).toBe(true);
    expect(postSalesListQuerySchema.safeParse({ priority: 'URGENT' }).success).toBe(false);
    expect(postSalesListQuerySchema.safeParse({ channel: 'WHATSAPP' }).success).toBe(true);
    expect(postSalesListQuerySchema.safeParse({ channel: 'PIGEON' }).success).toBe(false);
  });

  it('takes `mine` as a flag, never an id', () => {
    // The server resolves it against the caller, so it cannot be another queue.
    expect(postSalesListQuerySchema.parse({ mine: 'true' }).mine).toBe(true);
    expect(postSalesListQuerySchema.safeParse({ mine: 'true' }).success).toBe(true);
    const parsed = postSalesListQuerySchema.parse({ mine: 'true' }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('mineUserId');
  });
});

// ---------------------------------------------------------------------------
//  Navigation and RBAC
// ---------------------------------------------------------------------------

describe('navigation', () => {
  it('is live, not a placeholder', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/post-sales');
    expect(item?.available).toBe(true);
    expect(item?.module).toBe('POST_SALES');
  });

  it('offers overview, all cases, my cases and new case', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/post-sales');
    expect(item?.children?.map((c) => c.href)).toEqual([
      '/post-sales/cases',
      '/post-sales/cases?mine=true',
      '/post-sales/cases/new',
    ]);
  });

  it('exposes no unbuilt sub-page', () => {
    const hrefs = JSON.stringify(NAV_ITEMS);
    for (const absent of ['/returns', '/refunds', '/replacements', '/exchanges',
                          '/warranty', '/csat', '/post-sales/reports', '/post-sales/settings']) {
      expect(hrefs, absent).not.toContain(absent);
    }
  });

  it('gives every child the parent module, so one grant reaches all', () => {
    const item = NAV_ITEMS.find((i) => i.href === '/post-sales');
    for (const child of item?.children ?? []) {
      expect(child.module).toBe('POST_SALES');
    }
  });

  it('shows the module only to somebody who holds it', () => {
    const granted = visibleNavItems(['POST_SALES'], false).map((i) => i.href);
    expect(granted).toEqual(['/dashboard', '/post-sales']);
    expect(visibleNavItems(['SALES'], false).map((i) => i.href)).not.toContain('/post-sales');
  });

  it('uses the existing AppModule value, inventing none', () => {
    expect(APP_MODULES).toContain('POST_SALES');
    expect(APP_MODULES).not.toContain('POST_SALES_GRIEVANCE');
    expect(APP_MODULES).not.toContain('POST_SALES_CASES');
  });
});

describe('RBAC in the UI', () => {
  it('gates every page on POST_SALES', () => {
    for (const [name, src] of [['overview', overview], ['board', board],
                               ['detail', detail], ['new', newCase]] as const) {
      expect(codeOf(src), name).toContain("requireModule('POST_SALES')");
      expect(codeOf(src), name).toContain('NoModuleAccess');
    }
  });

  it('uses only the four existing actions', () => {
    const code = codeOf(overview) + codeOf(board) + codeOf(detail) + codeOf(newCase);
    const checks = [...code.matchAll(/can\([^,]+,\s*'([A-Z_]+)'\s*,\s*'([A-Z_]+)'\)/g)];
    expect(new Set(checks.map((m) => m[1]))).toEqual(new Set(['POST_SALES']));
    for (const action of checks.map((m) => m[2])) {
      expect(['VIEW', 'CREATE', 'EDIT', 'ASSIGN'], action).toContain(action);
    }
  });

  it('introduces no dotted permission names and no APPROVE', () => {
    const code = codeOf(overview) + codeOf(board) + codeOf(detail) + codeOf(actions) + codeOf(panels);
    for (const absent of ['post_sales.view', 'post_sales.refund', "'APPROVE'", 'post_sales.escalate']) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('separates EDIT from ASSIGN on the detail page', () => {
    const code = codeOf(detail);
    expect(code).toContain("can(access.user, 'POST_SALES', 'EDIT')");
    expect(code).toContain("can(access.user, 'POST_SALES', 'ASSIGN')");
    expect(code).toContain('canEdit={canEdit}');
    expect(code).toContain('canAssign={canAssign}');
  });

  it('gates raising a case on CREATE', () => {
    expect(codeOf(newCase)).toContain("can(access.user, 'POST_SALES', 'CREATE')");
  });
});

// ---------------------------------------------------------------------------
//  The board
// ---------------------------------------------------------------------------

describe('the case board', () => {
  it('shows the eleven business columns', () => {
    const code = codeOf(table);
    for (const header of ['Case ID', 'Date', 'Customer', 'Order', 'Product', 'Case Type',
                          'Issue', 'Priority', 'Status', 'Assigned To', 'Last Activity']) {
      expect(code, header).toContain(header);
    }
  });

  it('shows no SLA, refund, return or CSAT column', () => {
    const code = codeOf(table);
    for (const absent of ['SLA', 'Refund', 'Return status', 'CSAT', 'Replacement']) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('recomputes nothing — every figure comes from the API', () => {
    const code = codeOf(table);
    expect(code).toContain('row.lastActivityAt');
    expect(code).not.toContain('reduce');
    expect(code).not.toMatch(/new Date\(\)/);
  });

  it('builds its filters from the shared vocabularies', () => {
    const code = codeOf(board);
    expect(code).toContain('POST_SALES_CASE_STATUSES.map');
    expect(code).toContain('POST_SALES_PRIORITIES.map');
    expect(code).toContain('POST_SALES_CASE_TYPES.map');
    expect(code).toContain('POST_SALES_ISSUE_CATEGORIES.map');
    expect(code).toContain('POST_SALES_COMMUNICATION_CHANNELS.map');
  });

  it('gives every filter an All option, and drops the cursor on search', () => {
    const code = codeOf(board);
    expect(code).toContain('<option value="">All</option>');
    expect(code).toContain('action="/post-sales/cases"');
    expect(code).not.toContain('name="cursor"');
  });

  it('carries filters onto the next page', () => {
    expect(codeOf(board)).toContain('function nextHref');
    expect(codeOf(board)).toContain("query.set('cursor', cursor)");
  });

  it('distinguishes no cases from no matches', () => {
    const code = codeOf(table);
    expect(code).toContain('No cases match those filters');
    expect(code).toContain('No post-sales cases yet');
  });

  it('links the case number to the detail page', () => {
    expect(codeOf(table)).toContain('href={`/post-sales/cases/${row.id}`}');
  });

  it('shows an em dash for a case with no order', () => {
    expect(codeOf(table)).toContain('row.orderId ??');
  });
});

// ---------------------------------------------------------------------------
//  The overview
// ---------------------------------------------------------------------------

describe('the overview', () => {
  it('shows the seven core counts plus total', () => {
    const code = codeOf(overview);
    for (const label of ['Open cases', 'Assigned to me', 'Critical', 'Unassigned',
                         'New today', 'Resolved today', 'Reopened', 'Total cases']) {
      expect(code, label).toContain(label);
    }
  });

  it('shows no Phase 5 analytics', () => {
    const code = codeOf(overview);
    for (const absent of ['Return rate', 'Refund rate', 'SLA', 'CSAT',
                          'Financial impact', 'performance']) {
      expect(code, absent).not.toContain(absent);
    }
  });
});

// ---------------------------------------------------------------------------
//  The detail page
// ---------------------------------------------------------------------------

describe('the case detail', () => {
  it('needs one read for the whole page', () => {
    const code = codeOf(detail);
    expect(code).toContain('await fetchPostSalesCase(id)');
    expect(code).not.toContain('apiFetch(');
    expect(code).not.toContain('/activities');
    expect(code).not.toContain('/attachments');
  });

  it('handles not-found and error separately', () => {
    const code = codeOf(detail);
    expect(code).toContain("result.code === 'POST_SALES_CASE_NOT_FOUND'");
    expect(code).toContain('notFound()');
    expect(code).toContain('ErrorMessage');
  });

  it('offers only statuses the server said are permitted', () => {
    // A button that exists is a move the API will accept.
    expect(codeOf(panels)).toContain('view.nextStatuses.map');
    expect(codeOf(panels)).not.toContain('POST_SALES_CASE_STATUSES.map');
  });

  it('shows the order total from the linked order, or an em dash', () => {
    const code = codeOf(detail);
    expect(code).toContain('formatCurrency(view.order.total)');
    expect(code).toContain('No order linked');
  });

  it('reads affected product identity from the order line', () => {
    const code = codeOf(detail);
    expect(code).toContain('item.salesOrderItem.productName');
    expect(code).toContain('item.salesOrderItem.rsProduct?.sku');
  });

  it('marks an internal note as internal', () => {
    const code = codeOf(panels);
    expect(code).toContain("a.kind === 'INTERNAL_NOTE'");
    expect(code).toContain('Internal');
  });

  it('offers only the four activity kinds a person may add', () => {
    const code = codeOf(panels);
    expect(code).toContain("'NOTE', 'INTERNAL_NOTE', 'CUSTOMER_COMMUNICATION', 'FOLLOW_UP'");
  });

  it('says plainly that messages cannot be sent from the CRM', () => {
    // No fake Send button: there is no WhatsApp, email or SMS integration.
    expect(panels).toContain('Sending messages from the CRM');
    expect(codeOf(panels)).not.toContain('Send WhatsApp');
    expect(codeOf(panels)).not.toContain('Send Email');
  });

  it('derives a follow-up state from its own timestamps', () => {
    const code = codeOf(panels);
    expect(code).toContain('function followUpState');
    expect(code).toContain('Overdue');
    expect(code).toContain('Completed late');
  });

  it('reuses the existing uploader rather than a second one', () => {
    const code = codeOf(panels);
    expect(code).toContain('ImageUploadField');
    expect(code).toContain('product-enquiry/image-upload-field');
    expect(code).not.toContain('cloudinary');
    expect(code).not.toContain('FormData');
  });

  it('states the image-only limit rather than letting it be discovered', () => {
    expect(panels).toContain('Images only in this release');
  });

  it('shows no Phase 2-6 section', () => {
    const code = codeOf(detail) + codeOf(panels);
    for (const absent of ['Return request', 'Refund amount', 'Replacement order',
                          'Exchange', 'Warranty claim', 'SLA', 'CSAT', 'Escalate']) {
      expect(code, absent).not.toContain(absent);
    }
  });
});

// ---------------------------------------------------------------------------
//  The create form
// ---------------------------------------------------------------------------

describe('the create form', () => {
  it('searches customers server-side, debounced', () => {
    const code = codeOf(form);
    expect(code).toContain('/api/proxy/customers?q=');
    expect(code).toContain('setTimeout');
    // Never the whole directory into the browser.
    expect(code).toContain('limit=20');
  });

  it('creates no customer', () => {
    const code = codeOf(form);
    expect(code).not.toContain("method: 'POST'");
    expect(form).toContain('add them in');
  });

  it('loads orders scoped to the chosen customer', () => {
    expect(codeOf(form)).toContain('fetchCustomerOrdersAction(customer.id)');
  });

  it('clears the affected lines when the order changes', () => {
    // Lines belong to one order; keeping them would be a cross-order payload.
    expect(codeOf(form)).toContain('setAffected({})');
  });

  it('caps an affected quantity at what was bought', () => {
    expect(codeOf(form)).toContain('max={line.quantity}');
  });

  it('groups the issue picker but stores the flat enum', () => {
    const code = codeOf(form);
    expect(code).toContain('POST_SALES_ISSUE_GROUPS.map');
    expect(code).toContain('optgroup');
  });

  it('requires customer, type, issue, subject and description', () => {
    const code = codeOf(form);
    expect(code).toContain('const ready =');
    expect(code).toContain('customer !== null');
    expect(code).toContain("caseType !== ''");
    expect(code).toContain("issueCategory !== ''");
  });

  it('sends no actor identity', () => {
    const code = codeOf(form) + codeOf(actions);
    expect(code).not.toContain('raisedById');
    expect(code).not.toContain('performedById');
    expect(code).not.toContain('uploadedById');
  });

  it('says priority is judged, not inferred', () => {
    expect(form).toContain('Nothing is inferred from order value');
  });

  it('has loading, error and empty states', () => {
    const code = codeOf(form);
    expect(code).toContain('animate-spin');
    expect(code).toContain('ErrorMessage');
    expect(code).toContain('No customer found');
  });

  it('explains a permission failure rather than showing an empty list', () => {
    expect(codeOf(form)).toContain('setDenied');
    expect(form).toContain('do not have permission to search customers');
  });
});

// ---------------------------------------------------------------------------
//  Badges
// ---------------------------------------------------------------------------

describe('badges', () => {
  it('maps every status and priority onto the existing palette', () => {
    const code = codeOf(badges);
    for (const s of POST_SALES_CASE_STATUSES) {
      expect(code, s).toContain(s);
    }
    for (const p of POST_SALES_PRIORITIES) {
      expect(code, p).toContain(p);
    }
  });

  it('keeps status and priority as two separate maps', () => {
    // A case awaiting a courier says nothing about how urgent it is.
    const code = codeOf(badges);
    expect(code).toContain('const STATUS');
    expect(code).toContain('const PRIORITY');
  });

  it('uses the shared badge variants, hard-coding no colour', () => {
    const code = codeOf(badges);
    expect(code).toContain("'positive'");
    expect(code).toContain("'critical'");
    expect(code).not.toContain('#');
    expect(code).not.toContain('bg-green');
    expect(code).not.toContain('bg-red');
  });

  it('marks CRITICAL critical and REOPENED critical', () => {
    const code = codeOf(badges);
    expect(code).toContain("CRITICAL: 'critical'");
    expect(code).toContain("REOPENED: 'critical'");
  });
});

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

describe('Phase 1 stays within its scope', () => {
  it('builds no returns, refunds, replacements, exchanges or warranty flow', () => {
    const code = codeOf(actions) + codeOf(panels) + codeOf(form) + codeOf(apiClient);
    for (const absent of ['/returns', '/refunds', '/replacements', '/exchanges',
                          '/warranty', 'SalesRefund', 'settleRefund']) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('writes no stock, order or dispatch', () => {
    const code = codeOf(actions) + codeOf(panels) + codeOf(form);
    for (const absent of ['crmStockQty', 'inventoryQty', '/api/sales', '/api/dispatch']) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('adds no SLA or escalation control', () => {
    const code = codeOf(actions) + codeOf(panels) + codeOf(board);
    for (const absent of ['slaDeadline', 'escalate', 'breach']) {
      expect(code.toLowerCase(), absent).not.toContain(absent.toLowerCase());
    }
  });

  it('ships the four activity kinds and six attachment kinds, and no more', () => {
    expect([...POST_SALES_ACTIVITY_KINDS]).toHaveLength(7);
    expect([...POST_SALES_ATTACHMENT_KINDS]).toHaveLength(6);
    expect([...POST_SALES_COMMUNICATION_CHANNELS]).toHaveLength(10);
  });

  it('revalidates the board and overview after a write', () => {
    const code = codeOf(actions);
    expect(code).toContain("revalidatePath('/post-sales/cases')");
    expect(code).toContain("revalidatePath('/post-sales')");
  });
});
