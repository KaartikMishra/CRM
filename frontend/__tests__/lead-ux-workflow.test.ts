/**
 * Allocation, deal status and the country dial prefix — the post-4F UX pass.
 *
 * Three separate workflows that manual testing found incomplete, each verified
 * the way it can actually be verified: the dial-code map as data, the badge and
 * permission decisions as source structure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COUNTRIES,
  COUNTRY_DIAL_CODES,
  DEAL_STATUSES,
  DEAL_STATUS_LABELS,
  DEFAULT_COUNTRY,
  LEAD_PROMPTNESS_RATINGS,
  dialCodeFor,
  normalizePhone,
  updateLeadSchema,
} from '@rs/shared';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const codeOf = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const controls = read('components/leads/lead-controls.tsx');
const badges = read('components/leads/lead-badges.tsx');
const detail = read('app/(app)/leads/[id]/page.tsx');
const form = read('components/lead/create-lead-form.tsx');
const actions = read('app/(app)/leads/actions.ts');
const table = read('components/leads/lead-table.tsx');
const page = read('app/(app)/leads/page.tsx');

// ---------------------------------------------------------------------------
//  Dial codes
// ---------------------------------------------------------------------------

describe('the dial-code map', () => {
  it('covers every country, with no gaps', () => {
    // A selector must never land on a country with no prefix.
    const missing = COUNTRIES.filter((c) => !(c in COUNTRY_DIAL_CODES));
    expect(missing).toEqual([]);
    expect(Object.keys(COUNTRY_DIAL_CODES)).toHaveLength(COUNTRIES.length);
  });

  it('invents no country the list does not have', () => {
    const extra = Object.keys(COUNTRY_DIAL_CODES).filter(
      (k) => !(COUNTRIES as readonly string[]).includes(k),
    );
    expect(extra).toEqual([]);
  });

  it('gives the five the business named', () => {
    expect(dialCodeFor('India')).toBe('+91');
    expect(dialCodeFor('United States of America')).toBe('+1');
    expect(dialCodeFor('United Kingdom')).toBe('+44');
    expect(dialCodeFor('United Arab Emirates')).toBe('+971');
    expect(dialCodeFor('Indonesia')).toBe('+62');
  });

  it('starts every code with + and digits only', () => {
    for (const [country, code] of Object.entries(COUNTRY_DIAL_CODES)) {
      expect(code, country).toMatch(/^\+\d{1,4}$/);
    }
  });

  it('allows several countries to share one code, as the real plan does', () => {
    // +1 is the North American plan; Vatican City uses Italy's +39.
    expect(dialCodeFor('Canada')).toBe('+1');
    expect(dialCodeFor('United States of America')).toBe('+1');
    expect(dialCodeFor('Vatican City')).toBe(dialCodeFor('Italy'));
  });

  it('answers null for an unknown value rather than throwing', () => {
    expect(dialCodeFor('Atlantis')).toBeNull();
    expect(dialCodeFor('')).toBeNull();
    expect(dialCodeFor(null)).toBeNull();
    expect(dialCodeFor(undefined)).toBeNull();
  });

  it('has a prefix for the form default', () => {
    expect(dialCodeFor(DEFAULT_COUNTRY)).toBe('+91');
  });
});

describe('the prefixed phone field', () => {
  /** What the form builds: the prefix joined to the national part. */
  const full = (country: string, local: string): string =>
    local.trim() === '' ? '' : `${dialCodeFor(country) ?? ''}${local.trim()}`;

  it('builds a full international number', () => {
    expect(full('India', '9876543210')).toBe('+919876543210');
    expect(full('United States of America', '4155550123')).toBe('+14155550123');
    expect(full('United Kingdom', '7700900123')).toBe('+447700900123');
    expect(full('United Arab Emirates', '501234567')).toBe('+971501234567');
    expect(full('Indonesia', '81234567890')).toBe('+6281234567890');
  });

  it('re-prefixes when the country changes, keeping the digits', () => {
    const local = '9876543210';
    expect(full('India', local)).toBe('+919876543210');
    expect(full('United States of America', local)).toBe('+19876543210');
    expect(full('United Kingdom', local)).toBe('+449876543210');
  });

  it('stays empty while nothing is typed, so no lookup fires', () => {
    expect(full('India', '')).toBe('');
    expect(full('India', '   ')).toBe('');
  });

  it('matches the shape the existing customer rows already use', () => {
    // The live data holds +918528885250; the form now produces that shape.
    expect(full('India', '8528885250')).toBe('+918528885250');
  });

  it('leaves customer lookup semantics untouched', () => {
    /*
      `normalizePhone` strips the + and every separator, so a prefixed number
      still matches the row it always did. The map is input assistance, not
      parsing: nothing here teaches the lookup about country codes.
      */
    expect(normalizePhone(full('India', '8528885250'))).toBe('918528885250');
    expect(normalizePhone('+91 85288 85250')).toBe('918528885250');
    expect(normalizePhone(full('India', '8528885250'))).toBe(normalizePhone('+91-85288-85250'));
  });

  it('still distinguishes a bare local number from a prefixed one', () => {
    // The deliberate Phase 1 rule, unchanged: no country-code inference.
    expect(normalizePhone('8528885250')).not.toBe(normalizePhone('+918528885250'));
  });

  it('derives the full number instead of holding it in a second state', () => {
    const code = codeOf(form);
    expect(code).toContain('const dialCode = dialCodeFor(country)');
    expect(code).toContain('const phone =');
    expect(code).toContain('setLocalPhone');
    // No setPhone: a second setter could disagree with the prefix.
    expect(code).not.toContain('setPhone(');
  });

  it('shows the prefix beside the field', () => {
    expect(codeOf(form)).toContain('{dialCode ?? ');
    expect(codeOf(form)).toContain('Dial code for');
  });
});

// ---------------------------------------------------------------------------
//  Deal status
// ---------------------------------------------------------------------------

describe('deal status colours', () => {
  it('is amber for in process, green for won, red for lost', () => {
    const code = codeOf(badges);
    expect(code).toContain("INPROCESS: { variant: 'warning' }");
    expect(code).toContain("WON: { variant: 'positive' }");
    expect(code).toContain("LOST: { variant: 'critical' }");
  });

  it('no longer renders in process as neutral grey', () => {
    // The defect this pass fixes: INPROCESS was neutral, not the business's amber.
    expect(codeOf(badges)).not.toContain("INPROCESS: { variant: 'neutral' }");
  });

  it('keeps promptness colours in a separate map', () => {
    /*
      Two vocabularies that share a palette and must never merge: a deal in
      process says nothing about anybody's performance.
      */
    const code = codeOf(badges);
    expect(code).toContain('const DEAL');
    expect(code).toMatch(/GOOD/);
    expect([...LEAD_PROMPTNESS_RATINGS]).toHaveLength(4);
    expect([...DEAL_STATUSES]).toHaveLength(3);
  });

  it('labels the three statuses from the shared constants', () => {
    expect(DEAL_STATUS_LABELS.INPROCESS).toBe('In process');
    expect(DEAL_STATUS_LABELS.WON).toBe('Won');
    expect(DEAL_STATUS_LABELS.LOST).toBe('Lost');
  });
});

describe('the deal status control', () => {
  it('offers all three statuses, built from the shared list', () => {
    expect(codeOf(controls)).toContain('DEAL_STATUSES.map');
    expect(codeOf(controls)).toContain('DEAL_STATUS_LABELS[status]');
  });

  it('accepts every status in both directions — no terminal lock', () => {
    // A deal marked WON by mistake must be correctable.
    for (const dealStatus of DEAL_STATUSES) {
      expect(updateLeadSchema.safeParse({ dealStatus }).success, dealStatus).toBe(true);
    }
  });

  it('refuses an invented status', () => {
    expect(updateLeadSchema.safeParse({ dealStatus: 'PENDING' }).success).toBe(false);
  });

  it('cannot smuggle an allocation through the status update', () => {
    // The contract has no associateId, so EDIT cannot reassign.
    const parsed = updateLeadSchema.parse({ dealStatus: 'WON' });
    expect(parsed).not.toHaveProperty('associateId');
    expect(Object.keys(parsed)).toEqual(['dealStatus']);
  });

  it('goes through the existing PATCH, adding no endpoint', () => {
    expect(codeOf(actions)).toContain('`/api/leads/${leadId}`');
    expect(codeOf(actions)).toContain("method: 'PATCH'");
  });

  it('is gated on EDIT', () => {
    expect(codeOf(controls)).toContain('canEdit');
  });
});

describe('the analytics deal status filter', () => {
  it('offers All plus the three statuses', () => {
    const code = codeOf(page);
    expect(code).toContain('name="dealStatus"');
    expect(code).toContain('DEAL_STATUSES.map');
    expect(code).toContain('<option value="">All</option>');
  });
});

// ---------------------------------------------------------------------------
//  Allocation
// ---------------------------------------------------------------------------

describe('the allocation control', () => {
  it('exists on the lead detail', () => {
    expect(codeOf(detail)).toContain('LeadControls');
    expect(codeOf(detail)).toContain('canAssign={canAssign}');
  });

  it('is gated on ASSIGN, not EDIT', () => {
    const code = codeOf(detail);
    expect(code).toContain("can(access.user, 'LEAD_DEAL', 'ASSIGN')");
    expect(code).toContain("can(access.user, 'LEAD_DEAL', 'EDIT')");
    // Two separate verdicts, not one reused for both.
    expect(code).toContain('const canAssign =');
    expect(code).toContain('const canEdit =');
  });

  it('hides the control from somebody without ASSIGN', () => {
    expect(codeOf(controls)).toContain('canAssign &&');
  });

  it('shows associate, allocated-by and the derived allocation', () => {
    const code = codeOf(controls);
    expect(code).toContain('lead.associate?.name');
    expect(code).toContain('lead.allocatedBy?.name');
    expect(code).toContain('AllocationBadge');
  });

  it('reads Unassigned and an em dash when nobody holds it', () => {
    const code = codeOf(controls);
    expect(code).toContain("?? 'Unassigned'");
    expect(code).toContain("?? '—'");
  });

  it('offers unassign as a real choice', () => {
    const code = codeOf(controls);
    expect(code).toContain('Unassign');
    expect(code).toContain('UNASSIGNED');
  });

  it('reassigns through the same control once allocated', () => {
    expect(codeOf(controls)).toContain("lead.associate ? 'Reassign to' : 'Assign to'");
  });

  it('sends null to unassign, never an empty string', () => {
    expect(codeOf(controls)).toContain('choice === UNASSIGNED ? null : choice');
  });

  it('never sends allocatedById — the server takes the actor', () => {
    const code = codeOf(actions);
    expect(code).toContain('JSON.stringify({ associateId })');
    expect(code).not.toContain('allocatedById');
  });

  it('uses the existing assign endpoint, adding no second system', () => {
    const code = codeOf(actions);
    expect(code).toContain('`/api/leads/${leadId}/assign`');
    expect(code).not.toContain('allocation/');
  });

  it('derives SELF/OTHER_USER/UNASSIGNED nowhere in the browser', () => {
    const code = codeOf(controls) + codeOf(table);
    expect(code).not.toContain("'SELF'");
    expect(code).not.toContain("'OTHER_USER'");
    expect(code).not.toContain('allocationKind(');
  });

  it('fetches the assignee list only for somebody who can allocate', () => {
    const code = codeOf(controls);
    expect(code).toContain('if (!canAssign) return;');
    expect(code).toContain('fetchAssigneesAction');
  });

  it('shows name and employee id, and no credentials', () => {
    const code = codeOf(controls);
    expect(code).toContain('user.name');
    expect(code).toContain('user.employeeId');
    for (const leak of ['password', 'passwordHash', 'email']) {
      expect(code, leak).not.toContain(leak);
    }
  });

  it('has a saving state and surfaces the API message', () => {
    const code = codeOf(controls);
    expect(code).toContain('animate-spin');
    expect(code).toContain('setError(result.message)');
    expect(code).toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
//  Scope
// ---------------------------------------------------------------------------

describe('this pass stays in its lane', () => {
  it('adds no allocation table or permission', () => {
    const code = codeOf(controls) + codeOf(actions);
    expect(code).not.toContain('LEAD_ALLOCATE');
    expect(code).not.toContain('Allocation(');
  });

  it('touches no order, stock or dispatch path', () => {
    const code = codeOf(controls) + codeOf(actions) + codeOf(badges);
    for (const absent of ['crmStockQty', 'inventoryQty', 'dispatch', 'PurchaseBill']) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('leaves the two value figures separate', () => {
    const code = codeOf(table);
    expect(code).toContain('lead.orderValue == null');
    expect(code).toContain('lead.requirementValue == null');
    expect(code).not.toContain('orderValue ?? lead.requirementValue');
  });

  it('keeps the table scrolling through the existing pattern', () => {
    // Table ships its own .scroll-x; the page bounds ContentScrollArea.
    expect(codeOf(read('components/ui/table.tsx'))).toContain('scroll-x');
    expect(codeOf(table)).toContain('ContentScrollArea');
    expect(codeOf(page)).toContain('ContentPage');
  });
});
