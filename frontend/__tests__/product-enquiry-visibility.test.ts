/**
 * Product Enquiry's UI half: a withheld customer identity, and a legible
 * placeholder.
 *
 * Static reads of component source, in the same style as the other UI suites
 * here. The rules being guarded are ones no pure-logic test could see: a
 * component rendering `null` straight into JSX (React prints nothing, so the
 * page would silently lose a row), a page bringing back copy that tells the
 * reader about their own permissions, a field that was meant to stay visible
 * quietly disappearing with the redacted ones, and a colour token drifting back
 * to the darker value.
 *
 * The server-side half — that the payload itself carries no identity without
 * Raiser access, and still carries everything else — is asserted against the
 * real API in
 * backend/src/modules/product-enquiry/__tests__/raiser-and-answerer.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const inputSource = source('../components/ui/input.tsx');
const textareaSource = source('../components/ui/textarea.tsx');
const commandSource = source('../components/ui/command.tsx');
const tableSource = source('../components/product-enquiry/enquiry-table.tsx');
const detailSource = source('../app/(app)/product-enquiry/[id]/page.tsx');
const globalsSource = source('../app/globals.css');

/**
 * A placeholder must read as a hint, not as a value somebody already entered.
 *
 * The two tokens, from globals.css:
 *   --color-muted: #6b6a64   body-copy weight
 *   --color-faint: #9a9890   lighter, for hints and absent values
 */
describe('placeholders are lighter than entered text', () => {
  it('defines faint as a lighter token than muted', () => {
    const hex = (name: string): number => {
      const m = globalsSource.match(new RegExp(`--color-${name}:\\s*#([0-9a-fA-F]{6})`));
      expect(m, `--color-${name} should be defined`).not.toBeNull();
      return parseInt(m![1]!, 16);
    };
    // A larger hex value is a lighter grey on this palette.
    expect(hex('faint')).toBeGreaterThan(hex('muted'));
  });

  it('renders the input placeholder in the faint token', () => {
    expect(inputSource).toContain('placeholder:text-faint');
    // The regression this guards: the input was the one control still on the
    // darker token, which made hints look like pre-filled values.
    expect(inputSource).not.toContain('placeholder:text-muted');
  });

  it('keeps the entered value at full contrast', () => {
    // Only the placeholder was lightened. The value stays `text-ink`, the
    // darkest text on the page.
    expect(inputSource).toContain('text-sm text-ink');
  });

  it('is consistent across every text control', () => {
    expect(textareaSource).toContain('placeholder:text-faint');
    expect(commandSource).toContain('placeholder:text-faint');
    // And the value in a textarea is dark too.
    expect(textareaSource).toContain('text-sm text-ink');
  });
});

/**
 * A withheld identity is simply absent.
 *
 * Not a placeholder, and not a sentence explaining the absence: the enquiry
 * number is what an Answerer works by, and copy saying the customer is hidden
 * would tell the reader something about their own permissions that the page has
 * no business discussing.
 */
describe('a withheld customer identity is absent, not annotated', () => {
  it('the list row branches on a null name and says nothing about why', () => {
    expect(tableSource).toContain('enquiry.customer.name !== null');
    expect(tableSource).not.toContain('Customer not shown');
    expect(tableSource).not.toContain('Not shown');
  });

  it('the detail page drops the three identity rows rather than filling them', () => {
    expect(detailSource).toContain('const identityShown = enquiry.customer.name !== null');
    // "Not recorded" must not be reused for a withheld value: it would assert
    // something untrue about data that does exist.
    expect(detailSource).not.toContain('Not shown — this enquiry is yours to answer');
    expect(detailSource).not.toContain('Not shown');
  });

  it('the detail header omits the customer subtitle when it is null', () => {
    expect(detailSource).toContain('enquiry.customer.name !== null &&');
  });

  it('gates exactly three facts on identity — customer, phone, email', () => {
    expect(detailSource).toContain("{ label: 'Customer', value: enquiry.customer.name }");
    expect(detailSource).toMatch(/identityFacts[\s\S]{0,400}label: 'Phone'/);
    expect(detailSource).toMatch(/identityFacts[\s\S]{0,900}label: 'Email'/);
  });
});

/**
 * The other half of the same rule, and the one a redaction change is most
 * likely to break by accident: these are shown to everybody.
 *
 * An Answerer is sourcing and pricing goods — where they are going and how the
 * sale is taxed is their job. Only who the buyer is, is not.
 */
describe('everything other than the identity stays visible to everyone', () => {
  const alwaysShown = [
    "{ label: 'Customer type', value: label(enquiry.customer.type) }",
    "label: 'Address'",
    "label: 'State'",
    "label: 'GST Number'",
    "label: 'Source'",
    "{ label: 'Created', value: formatDateTime(enquiry.sla.createdAt) }",
    "{ label: 'Created by', value: enquiry.createdBy.name }",
    "{ label: 'Towards', value: enquiry.assignedTo.name }",
    "{ label: 'Deadline', value: formatDateTime(enquiry.sla.slaDeadlineAt) }",
  ];

  it.each(alwaysShown)('keeps %s outside the identity branch', (fact) => {
    expect(detailSource).toContain(fact);
    // Present in the unconditional `facts` array, which is spread AFTER the
    // conditional identity rows — so it cannot have been swept up with them.
    const factsBlock = detailSource.slice(detailSource.indexOf('...identityFacts,'));
    expect(factsBlock).toContain(fact);
  });

  it('shows the customer type on list rows too', () => {
    expect(tableSource).toContain('label(enquiry.customer.type)');
  });
});

/**
 * The header says what access the person holds.
 *
 * Derived from the same permission matrix the server resolved, not from
 * anything the page decided for itself — and additive, so somebody holding both
 * reads as both rather than as whichever one happened to be checked first.
 */
describe('the list header names the capabilities held', () => {
  const listSource = source('../app/(app)/product-enquiry/page.tsx');

  it('reads both capabilities from the resolved permissions', () => {
    expect(listSource).toContain("can(user, 'PRODUCT_ENQUIRY', 'EDIT')");
    expect(listSource).toContain("'Raiser'");
    expect(listSource).toContain("'Answerer'");
  });

  it('joins them rather than choosing between them', () => {
    expect(listSource).toContain("capabilities.join(' + ')");
  });

  it('renders nothing at all when neither is held', () => {
    // A badge reading "none" would be a label for an absence.
    expect(listSource).toContain('capabilities.length > 0 &&');
  });
});

/**
 * The administrator's control over the two capabilities.
 *
 * Static reads again: what these guard is the field silently disappearing from
 * the edit dialog, turning back into a single either/or choice, or being sent
 * when the module is not granted — which would rewrite somebody's whole
 * override matrix for no reason.
 */
describe('the Edit User screen carries both enquiry capabilities', () => {
  const fieldSource = source('../components/users/enquiry-access-field.tsx');
  const dialogSource = source('../components/users/edit-user-dialog.tsx');

  it('offers the two as independent checkboxes, not as a choice', () => {
    expect(fieldSource).toContain('<Checkbox');
    expect(fieldSource).toContain('Raiser');
    expect(fieldSource).toContain('Answerer');
    // The regression that matters: radios would make the two mutually
    // exclusive, and somebody who does both jobs would need a third role
    // invented to describe them.
    expect(fieldSource).not.toContain('RadioGroup');
    // There is no "Viewer": everyone granted the module may read.
    expect(fieldSource).not.toContain('Viewer');
  });

  it('toggles each capability without touching the other', () => {
    expect(fieldSource).toContain('onChange({ ...value, [key]: next === true })');
  });

  it('says what each capability means', () => {
    expect(fieldSource).toMatch(/Can create enquiries/);
    expect(fieldSource).toMatch(/vendor responses/i);
  });

  it('says plainly what holding neither leaves', () => {
    expect(fieldSource).toMatch(/Neither selected/);
  });

  it('renders only when Product Enquiry is granted', () => {
    expect(dialogSource).toContain("modules.includes('PRODUCT_ENQUIRY') && (");
    expect(dialogSource).toContain('<EnquiryAccessField');
  });

  it('never offers it for an administrator', () => {
    // An override row on an ADMIN reads as a restriction; the API refuses it.
    expect(dialogSource).toContain("{!isAdmin && modules.includes('PRODUCT_ENQUIRY') && (");
  });

  it('sends the field only when it actually changed', () => {
    // Compared field by field: the value is an object now, so `!==` would be a
    // reference check and would send on every save.
    expect(dialogSource).toContain('enquiryAccess.raiser === user.enquiryAccess.raiser');
    expect(dialogSource).toContain('enquiryAccess.answerer === user.enquiryAccess.answerer');
    expect(dialogSource).toContain('payload.enquiryAccess = enquiryAccess;');
  });

  it('seeds the control from the user being edited', () => {
    expect(dialogSource).toContain('setEnquiryAccess(user.enquiryAccess);');
  });
});
