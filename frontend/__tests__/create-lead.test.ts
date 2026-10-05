/**
 * Create Lead / Deal — Phase 1, frontend.
 *
 * Two kinds of assertion, matching the rest of this suite: the pure functions in
 * lead-logic.ts are called directly, and the components are read as source to
 * prove structural facts a pure test cannot reach — that the form offers every
 * option the business named, that OTHER reveals its free-text partner, and that
 * a duplicate phone number is never resolved by the form choosing for somebody.
 *
 * Comments are stripped before any source assertion. Without that, a test can
 * pass because this file's own prose mentions the thing it is looking for.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEAD_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  REQUIREMENT_TYPES,
  REQUIREMENT_TYPE_LABELS,
  createLeadSchema,
  leadCustomerLookupSchema,
  normalizePhone,
  samePhone,
  type CustomerView,
} from '@rs/shared';
import {
  autoLinkedCustomerId,
  customerLabel,
  lookupState,
  shouldLookup,
  MIN_LOOKUP_DIGITS,
} from '@/components/lead/lead-logic';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const codeOf = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const page = read('app/(app)/create-lead/page.tsx');
const form = read('components/lead/create-lead-form.tsx');
const actions = read('app/(app)/create-lead/actions.ts');
const nav = read('components/layout/nav-items.ts');

const CUID = 'clx0000000000000000000000';
const AT = '2026-09-30T09:15:00.000Z';

const lead = (over: Record<string, unknown> = {}) => ({
  leadSource: 'CALL',
  sourceAt: AT,
  requirementType: 'RETAIL',
  customer: { customerId: CUID },
  channel: 'ROYALSTUFFS_COM',
  ...over,
});

const customer = (over: Partial<CustomerView> = {}): CustomerView => ({
  id: 'c1',
  name: 'Abhay',
  companyName: null,
  type: 'RETAIL',
  phone: '+919812345678',
  email: null,
  address: null,
  state: null,
  country: null,
  gstNumber: null,
  createdAt: AT,
  ...over,
});

// ---------------------------------------------------------------------------
//  The vocabularies the business named
// ---------------------------------------------------------------------------

describe('the option lists', () => {
  it('offer exactly the six lead sources', () => {
    expect([...LEAD_SOURCES]).toEqual([
      'CALL',
      'WHATSAPP',
      'EMAIL',
      'ABANDONED_CART',
      'SOCIAL_MEDIA',
      'OTHER',
    ]);
    expect(LEAD_SOURCE_LABELS.ABANDONED_CART).toBe('Abandoned Cart');
    expect(LEAD_SOURCE_LABELS.WHATSAPP).toBe('WhatsApp');
  });

  it('offer exactly the six requirement types', () => {
    expect([...REQUIREMENT_TYPES]).toEqual([
      'RETAIL',
      'WHOLESALE',
      'EXPORT_RETAIL',
      'EXPORT_WHOLESALE',
      'CORPORATE_GIFTING',
      'PERSONAL_GIFTING',
    ]);
    expect(REQUIREMENT_TYPE_LABELS.EXPORT_WHOLESALE).toBe('Export Wholesale');
  });

  it('offer exactly the six channels, spelled as the business writes them', () => {
    expect([...LEAD_CHANNELS]).toEqual([
      'ROYALSTUFFS_COM',
      'ROYALSTUFFS_STORE',
      'INDIAMART',
      'AMAZON',
      'FLIPKART',
      'OTHER',
    ]);
    expect(LEAD_CHANNEL_LABELS.ROYALSTUFFS_COM).toBe('RoyalStuffs.com');
    expect(LEAD_CHANNEL_LABELS.ROYALSTUFFS_STORE).toBe('RoyalStuffs.store');
    expect(LEAD_CHANNEL_LABELS.INDIAMART).toBe('IndiaMART');
  });

  it('are rendered from the contract rather than retyped in the form', () => {
    const code = codeOf(form);
    expect(code).toContain('LEAD_SOURCES.map');
    expect(code).toContain('REQUIREMENT_TYPES.map');
    expect(code).toContain('LEAD_CHANNELS.map');
    // A hand-typed label would drift from the list the API validates against.
    expect(code).not.toContain("'Abandoned Cart'");
    expect(code).not.toContain("'IndiaMART'");
  });
});

// ---------------------------------------------------------------------------
//  Validation — the contract the API enforces
// ---------------------------------------------------------------------------

describe('creating a lead', () => {
  it('accepts a complete one', () => {
    expect(createLeadSchema.safeParse(lead()).success).toBe(true);
  });

  it('requires the source, the moment, the requirement and the channel', () => {
    for (const field of ['leadSource', 'sourceAt', 'requirementType', 'channel']) {
      const body = lead();
      delete (body as Record<string, unknown>)[field];
      expect(createLeadSchema.safeParse(body).success, field).toBe(false);
    }
  });

  it('treats source details as optional', () => {
    expect(createLeadSchema.safeParse(lead({ sourceDetails: undefined })).success).toBe(true);
    expect(createLeadSchema.safeParse(lead({ sourceDetails: 'Rang about thalis' })).success).toBe(
      true,
    );
  });

  it('refuses a source date that is not a real instant', () => {
    expect(createLeadSchema.safeParse(lead({ sourceAt: 'last Tuesday' })).success).toBe(false);
  });
});

describe('the OTHER pairing', () => {
  it('requires a written name when the source is Other', () => {
    expect(createLeadSchema.safeParse(lead({ leadSource: 'OTHER' })).success).toBe(false);
    expect(
      createLeadSchema.safeParse(lead({ leadSource: 'OTHER', leadSourceOther: 'Trade fair' }))
        .success,
    ).toBe(true);
  });

  it('refuses a written name beside a listed source', () => {
    // The other direction: two contradictory statements about one answer.
    expect(
      createLeadSchema.safeParse(lead({ leadSource: 'CALL', leadSourceOther: 'Trade fair' }))
        .success,
    ).toBe(false);
  });

  it('applies the same rule to the channel', () => {
    expect(createLeadSchema.safeParse(lead({ channel: 'OTHER' })).success).toBe(false);
    expect(
      createLeadSchema.safeParse(lead({ channel: 'OTHER', channelOther: 'Walk-in' })).success,
    ).toBe(true);
    expect(
      createLeadSchema.safeParse(lead({ channel: 'AMAZON', channelOther: 'Walk-in' })).success,
    ).toBe(false);
  });

  it('is revealed in the form only when Other is chosen', () => {
    const code = codeOf(form);
    expect(code).toContain("leadSource === 'OTHER'");
    expect(code).toContain("channel === 'OTHER'");
    expect(code).toContain('needsSourceOther');
    expect(code).toContain('needsChannelOther');
  });
});

describe('the customer on a lead', () => {
  it('takes an existing customer or a new one, never both', () => {
    expect(createLeadSchema.safeParse(lead({ customer: { customerId: CUID } })).success).toBe(true);

    const both = lead({
      customer: {
        customerId: CUID,
        newCustomer: { name: 'A', type: 'RETAIL', phone: '+919812345678' },
      },
    });
    expect(createLeadSchema.safeParse(both).success).toBe(false);
  });

  it('refuses neither', () => {
    expect(createLeadSchema.safeParse(lead({ customer: {} })).success).toBe(false);
  });

  it('validates a new customer through the existing Customer contract', () => {
    const made = lead({
      customer: {
        newCustomer: { name: 'Abhay', type: 'RETAIL', phone: '+919812345678' },
      },
    });
    expect(createLeadSchema.safeParse(made).success).toBe(true);

    // A name is required by that contract, so a lead cannot dodge it.
    const nameless = lead({
      customer: { newCustomer: { type: 'RETAIL', phone: '+919812345678' } },
    });
    expect(createLeadSchema.safeParse(nameless).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Phone normalization
// ---------------------------------------------------------------------------

describe('normalizing a phone number', () => {
  it('reduces every spelling of one number to the same digits', () => {
    for (const spelling of [
      '+919812345678',
      '+91 98123 45678',
      '+91-98123-45678',
      '(91) 98123.45678',
      '  +91 (98123) 45678  ',
    ]) {
      expect(normalizePhone(spelling), spelling).toBe('919812345678');
    }
  });

  it('returns nothing for input with no digits', () => {
    expect(normalizePhone('abc')).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });

  it('never matches an empty number against anything', () => {
    expect(samePhone('', '')).toBe(false);
    expect(samePhone(null, null)).toBe(false);
  });

  it('matches two spellings of one number', () => {
    expect(samePhone('+91 98123 45678', '(91) 98123.45678')).toBe(true);
  });

  it('does NOT infer a country code — a Phase 1 limitation, stated', () => {
    // The CRM holds no dialling-code data, so a bare local number and one with
    // a code are different values. Asserted so the limit is visible.
    expect(samePhone('9812345678', '+919812345678')).toBe(false);
  });
});

describe('the lookup query', () => {
  it('accepts punctuation the stored-phone rule would reject', () => {
    // Somebody pastes a number out of an email; the matcher discards the dots
    // anyway, so refusing the search over them would be refusing a findable
    // customer.
    expect(leadCustomerLookupSchema.safeParse({ phone: '(91) 98123.45678' }).success).toBe(true);
  });

  it('still needs enough digits to be a phone number', () => {
    expect(leadCustomerLookupSchema.safeParse({ phone: '123' }).success).toBe(false);
    expect(leadCustomerLookupSchema.safeParse({ phone: 'abc' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  The five lookup states
// ---------------------------------------------------------------------------

describe('what the lookup shows', () => {
  const base = { searching: false, searched: true, matchCount: 0 };

  it('says nothing until there are enough digits', () => {
    expect(lookupState({ ...base, phone: '' })).toBe('IDLE');
    expect(lookupState({ ...base, phone: '123' })).toBe('IDLE');
    expect(MIN_LOOKUP_DIGITS).toBe(7);
  });

  it('shows a loading state while searching', () => {
    expect(lookupState({ ...base, phone: '+919812345678', searching: true })).toBe('SEARCHING');
  });

  it('says nothing before the first answer arrives', () => {
    expect(lookupState({ ...base, phone: '+919812345678', searched: false })).toBe('IDLE');
  });

  it('reports no customer found', () => {
    expect(lookupState({ ...base, phone: '+919812345678', matchCount: 0 })).toBe('NOT_FOUND');
  });

  it('reports exactly one', () => {
    expect(lookupState({ ...base, phone: '+919812345678', matchCount: 1 })).toBe('ONE_MATCH');
  });

  it('reports several, which the live data actually contains', () => {
    expect(lookupState({ ...base, phone: '+919812345678', matchCount: 2 })).toBe('MANY_MATCHES');
    expect(lookupState({ ...base, phone: '+919812345678', matchCount: 8 })).toBe('MANY_MATCHES');
  });

  it('only spends a request once the number is long enough', () => {
    expect(shouldLookup('123')).toBe(false);
    expect(shouldLookup('abc')).toBe(false);
    expect(shouldLookup('+919812345678')).toBe(true);
  });
});

describe('linking a customer automatically', () => {
  it('links the only match', () => {
    expect(autoLinkedCustomerId([customer({ id: 'only' })])).toBe('only');
  });

  it('links nothing when several share the number', () => {
    // The rule the whole duplicate case exists for: the form must not choose.
    expect(autoLinkedCustomerId([customer({ id: 'a' }), customer({ id: 'b' })])).toBeNull();
  });

  it('links nothing when there are none', () => {
    expect(autoLinkedCustomerId([])).toBeNull();
  });
});

describe('telling two customers apart', () => {
  it('shows enough to distinguish duplicates', () => {
    const label = customerLabel(
      customer({ name: 'Abhay', companyName: 'Royal Metals', state: 'Uttar Pradesh', country: 'India' }),
    );
    expect(label).toContain('Abhay');
    expect(label).toContain('Royal Metals');
    expect(label).toContain('Uttar Pradesh');
  });

  it('leaves absent parts out rather than printing null', () => {
    const label = customerLabel(customer({ companyName: null, state: null, country: null }));
    expect(label).toBe('Abhay');
    expect(label).not.toContain('null');
  });

  it('does not expose the GSTIN in a picker', () => {
    const label = customerLabel(customer({ gstNumber: '09AAACH7409R1ZZ' }));
    expect(label).not.toContain('09AAACH7409R1ZZ');
  });
});

// ---------------------------------------------------------------------------
//  The form and the route
// ---------------------------------------------------------------------------

describe('the page', () => {
  it('gates on LEAD_DEAL, its own module', () => {
    const code = codeOf(page);
    expect(code).toContain("requireModule('LEAD_DEAL')");
    expect(code).toContain('NoModuleAccess');
    // Not borrowed from another module as a workaround.
    expect(code).not.toContain('SALES');
    expect(code).not.toContain('PRODUCT_ENQUIRY');
  });

  it('separates viewing from recording', () => {
    expect(codeOf(page)).toContain("can(access.user, 'LEAD_DEAL', 'CREATE')");
  });

  it('has a navigation entry of its own', () => {
    const code = codeOf(nav);
    expect(code).toContain("href: '/create-lead'");
    expect(code).toContain("module: 'LEAD_DEAL'");
  });
});

describe('the form', () => {
  it('debounces the lookup instead of calling on every keystroke', () => {
    const code = codeOf(form);
    expect(code).toContain('setTimeout');
    expect(code).toContain('clearTimeout');
  });

  it('ignores a stale response that arrives after a newer one', () => {
    const code = codeOf(form);
    expect(code).toContain('requestToken');
    expect(code).toContain('token !== requestToken.current');
  });

  it('links a single match without asking, and never links several', () => {
    const code = codeOf(form);
    expect(code).toContain('found.length === 1 ? found[0]!.id : null');
  });

  it('reuses the existing customer fields rather than restating them', () => {
    const code = codeOf(form);
    expect(code).toContain('CountryStateFields');
    expect(code).toContain('customerStateOk');
  });

  it('goes through server actions, so the token never reaches the browser', () => {
    expect(codeOf(actions)).toContain("'use server'");
    expect(codeOf(form)).not.toContain('fetch(');
  });

  it('disables the button while saving and until the form is complete', () => {
    expect(codeOf(form)).toContain('disabled={saving || incomplete}');
  });

  it('reports success and failure through the existing toast', () => {
    expect(codeOf(form)).toContain("from 'sonner'");
  });

  it('adds none of the workflow Phase 1 excludes', () => {
    const code = codeOf(form) + codeOf(actions) + codeOf(page);
    for (const absent of ['assignee', 'followUp', 'pipeline', 'leadScore', 'quotation']) {
      expect(code, absent).not.toContain(absent);
    }
  });
});
