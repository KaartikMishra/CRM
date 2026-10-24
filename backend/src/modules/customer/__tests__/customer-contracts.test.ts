/**
 * All Customers — route wiring, permissions and contract preservation.
 *
 * These assert what can be proven without a database. That boundary is real and
 * worth naming: executing `requirePermission` calls `resolvePermission`, which
 * reads `UserModulePermission`, so a request-level authorization test needs a
 * database. What is checked here instead is the *wiring* — that every route
 * declares the gate, that the gate is the right module and action, and that the
 * role defaults resolve as intended.
 *
 * `roleDefault` is the exception: it is pure, taking a role and returning the
 * matrix, so the ADMIN/USER decision is tested directly rather than inferred.
 *
 * The tests that remain unverified are listed at the bottom of this file so the
 * gap is recorded in the suite rather than only in a report somebody has to
 * find.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_MODULES, APP_MODULE_LABELS, PERMISSION_ACTIONS } from '@rs/shared';
import { roleDefault } from '../../../services/permission.service.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const routes = (): string => read('../customer.routes.ts');

describe('the CUSTOMERS module is registered everywhere it must be', () => {
  it('exists as an AppModule', () => {
    expect(APP_MODULES).toContain('CUSTOMERS');
  });

  it('carries a label, which is a compile requirement and a UI one', () => {
    /*
      APP_MODULE_LABELS is `satisfies Record<AppModule, string>`, so a missing
      label fails the build — but the admin permission grid also renders the
      label for every module, and an absent one would be a checkbox reading
      "undefined".
    */
    expect(APP_MODULE_LABELS.CUSTOMERS).toBe('All Customers');
  });

  it('gives ADMIN view and export, because they are different acts', () => {
    /*
      Mandatory rather than conventional: `effectivePermissions` derives the
      whole module list from Object.keys(ROLE_DEFAULTS.ADMIN), so a module
      missing there is invisible to /api/auth/me — and therefore to the sidebar,
      hasModule and requireModule — even for an administrator.
    */
    expect(roleDefault('ADMIN', 'CUSTOMERS', 'VIEW')).toBe(true);
    expect(roleDefault('ADMIN', 'CUSTOMERS', 'EXPORT')).toBe(true);
  });

  it('denies USER by default, including export', () => {
    // Downloading a CSV of every customer's phone, email and GSTIN is not
    // something a module gains by default.
    for (const action of PERMISSION_ACTIONS) {
      expect(roleDefault('USER', 'CUSTOMERS', action)).toBe(false);
    }
  });
});

describe('every All Customers route declares its gate', () => {
  /*
    Source assertions, not request assertions. They cannot prove the middleware
    refuses a request — that needs a database — but they do prove no route was
    added without a gate, which is the mistake that would actually happen.
  */
  const A2_PATHS = ['/:id/profile', '/:id/enquiries', '/:id/leads', '/:id/orders', '/:id/timeline'];
  const A1_PATHS = ['/directory', '/analytics'];

  it('registers all seven paths', () => {
    const src = routes();
    for (const path of [...A1_PATHS, ...A2_PATHS]) {
      expect(src, `${path} is not registered`).toContain(`'${path}'`);
    }
  });

  it('puts CUSTOMERS VIEW on each of them', () => {
    /*
      Counted per path rather than in total. A single total was brittle: adding
      the three duplicate-review read routes changed it without anything being
      wrong, and a test that has to be edited whenever a route is added stops
      being evidence. Each path is now checked for a gate in its own block.
    */
    const src = routes();
    for (const path of [...A1_PATHS, ...A2_PATHS]) {
      const start = src.indexOf(`'${path}'`);
      const block = src.slice(start, start + 320);
      expect(block, `${path} has no CUSTOMERS VIEW gate`).toContain(
        "requirePermission('CUSTOMERS', 'VIEW')",
      );
    }
  });

  it('declares the literal paths before the parameterised ones', () => {
    /*
      Express matches in registration order. With `/:id/profile` first,
      "/directory" would arrive as an id and be rejected by cuidSchema with a
      422 — a failure that looks like a validation bug rather than a routing one.
    */
    const src = routes();
    const lastLiteral = Math.max(...A1_PATHS.map((p) => src.indexOf(`'${p}'`)));
    const firstParam = Math.min(...A2_PATHS.map((p) => src.indexOf(`'${p}'`)));
    expect(lastLiteral).toBeGreaterThan(-1);
    expect(firstParam).toBeGreaterThan(lastLiteral);
  });

  it('validates the id on every parameterised route', () => {
    // An unvalidated id would reach Prisma as arbitrary text.
    const src = routes();
    const validated = src.match(/customerIdParamSchema/g) ?? [];
    expect(validated.length).toBeGreaterThanOrEqual(A2_PATHS.length);
  });
});

describe('the customer picker contract is untouched', () => {
  /*
    The picker is submitted to by Product Enquiry, Create Lead, Sales and Post
    Sales. Changing what it accepts, returns or requires would change four
    working modules, so these assert it is still gated as it was.
  */
  it('still gates the search on CREATE in the calling module, not on CUSTOMERS', () => {
    const src = routes();
    expect(src).toContain("requireAnyPermission(");
    expect(src).toContain("['PRODUCT_ENQUIRY', 'CREATE']");
    expect(src).toContain("['SALES', 'CREATE']");
    expect(src).toContain("['POST_SALES', 'CREATE']");
  });

  it('still gates creation on PRODUCT_ENQUIRY CREATE', () => {
    expect(routes()).toContain("requirePermission('PRODUCT_ENQUIRY', 'CREATE')");
  });

  it('has not moved the picker onto the CUSTOMERS module', () => {
    /*
      The directory's own gate must not have leaked onto the picker: that would
      lock the customer lookup out of the enquiry and order flows for anybody
      without the new module.
    */
    const src = routes();
    const searchBlock = src.slice(0, src.indexOf("'/directory'"));
    expect(searchBlock).not.toContain("requirePermission('CUSTOMERS'");
  });
});

describe('a missing customer is a 404, not an empty page', () => {
  /*
    Asserted at the source, because proving the response needs a database. The
    distinction matters: a list endpoint that returned an empty array for an
    unknown id would tell the reader that customer has no enquiries, when in
    fact no such customer exists.
  */
  const service = (): string => read('../customer-profile.service.ts');

  it('raises CUSTOMER_NOT_FOUND rather than returning null', () => {
    expect(service()).toContain(
      "AppError.notFound('CUSTOMER_NOT_FOUND', 'That customer could not be found.')",
    );
  });

  it('checks the customer exists in every history endpoint, not just the profile', () => {
    const src = service();
    // One guard per exported reader: profile, enquiries, leads, orders, timeline.
    const guards = src.match(/await requireCustomer\(id\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });
});

describe('history is scoped to the customer asked for', () => {
  /*
    The defect this guards against is a query that forgets its filter and
    returns another customer's orders. Source-level, for the database reason
    above — but the filter is the thing that would be dropped, so the filter is
    what is asserted.
  */
  const repo = (): string => read('../customer.repository.ts');

  it('filters every per-customer query on customerId', () => {
    const src = repo();
    for (const fn of [
      'enquiriesForCustomer',
      'leadsForCustomer',
      'ordersForCustomer',
      'allOrdersForCustomerMoney',
      'allLeadsForCustomerConversion',
    ]) {
      const start = src.indexOf(`export async function ${fn}`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const body = src.slice(start, start + 900);
      expect(body, `${fn} does not filter on customerId`).toContain('customerId');
    }
  });

  it('reaches nested relations through their owning customer', () => {
    /*
      Timeline sources live on other tables — an EnquiryEvent belongs to an
      enquiry, a payment to an order — so each is filtered through its parent's
      customer rather than by a column it does not have.
    */
    const src = repo();
    expect(src).toContain('enquiry: { customerId }');
    expect(src).toContain('lead: { customerId }');
    expect(src).toContain('order: { customerId }');
  });
});

describe('the timeline never implies it is complete when it is not', () => {
  const service = (): string => read('../customer-profile.service.ts');

  it('caps each source and reports which hit the cap', () => {
    const src = service();
    expect(src).toContain('TIMELINE_PER_SOURCE');
    expect(src).toContain('truncated');
  });

  it('returns the truncation list on every response, empty or not', () => {
    // An absent field would be indistinguishable from "nothing was truncated".
    expect(service()).toContain('return { entries: ordered, truncated }');
  });

  it('surfaces truncation through the controller rather than dropping it', () => {
    const controller = read('../customer.controller.ts');
    expect(controller).toContain('truncated: page.truncated');
  });
});

/*
  ## Still unverified, and why

  These need HTTP against a database, which this phase is not authorised to
  touch. They are listed here so the gap lives beside the code:

    1. GET /api/customers/:id/profile with an unknown id returns 404
       CUSTOMER_NOT_FOUND — asserted at the source above, not over the wire.
    2. A user without CUSTOMERS:VIEW receives 403 from each of the seven
       routes; an unauthenticated request receives 401.
    3. Customer A's profile never contains customer B's enquiries, leads or
       orders — the filters are asserted above, their effect is not.
    4. Paginated history returns a correct nextCursor and no duplicate rows
       across pages.
    5. A customer with no history returns empty arrays rather than an error.
    6. The profile's verifiedPurchaseValue equals the figure the Sales order
       detail page shows for the same orders. The aggregation rules are tested
       pure; the agreement between the two endpoints is not.
    7. Duplicate-review decisions persist, and a dismissed pair reopens when
       its identifiers change. The decision logic is pure-tested; the write and
       the rescan are not.

  Each becomes testable the moment an isolated test database is approved.
*/

describe('duplicate review and export are gated on the right actions', () => {
  /*
    The permission on each of these is a decision, not a formality:

      - the queue is VIEW, because reading it changes nothing;
      - a decision is EDIT, because it writes — though what it writes is a
        review record, never a customer change;
      - the export is EXPORT, because it produces a file of every matching
        customer's contact details that then lives outside the CRM's access
        controls. VIEW would have been the easy choice and the wrong one.
  */
  it('reads the queue on VIEW', () => {
    const src = routes();
    const block = src.slice(src.indexOf("'/duplicates'"), src.indexOf("'/duplicates/scan-plan'"));
    expect(block).toContain("requirePermission('CUSTOMERS', 'VIEW')");
  });

  it('records a decision on EDIT', () => {
    const src = routes();
    const block = src.slice(src.indexOf('customerRoutes.patch'));
    expect(block).toContain("requirePermission('CUSTOMERS', 'EDIT')");
    expect(block).toContain('customerDuplicateDecisionSchema');
  });

  it('requires EXPORT for the CSV, not VIEW', () => {
    const src = routes();
    const start = src.indexOf("'/export'");
    // Bounded to this registration. Slicing to end-of-file swept up the later
    // /:id routes and their VIEW gates, which is a test reading the wrong code.
    const block = src.slice(start, src.indexOf(');', start));
    expect(block).toContain("requirePermission('CUSTOMERS', 'EXPORT')");
    expect(block).not.toContain("requirePermission('CUSTOMERS', 'VIEW')");
  });

  it('declares scan-plan before the /duplicates/:id route', () => {
    // Otherwise "scan-plan" is parsed as a candidate id and rejected by
    // cuidSchema with a 422 that reads as a validation bug.
    const src = routes();
    expect(src.indexOf("'/duplicates/scan-plan'")).toBeLessThan(src.indexOf("'/duplicates/:id'"));
  });

  it('declares every literal path before the /:id routes', () => {
    const src = routes();
    const lastLiteral = Math.max(
      ...["'/duplicates'", "'/export'", "'/directory'", "'/analytics'"].map((p) => src.indexOf(p)),
    );
    expect(src.indexOf("'/:id/profile'")).toBeGreaterThan(lastLiteral);
  });

  it('exposes no merge endpoint at all', () => {
    /*
      The safety property, asserted rather than trusted. A merge route added
      later would fail here, which is the point: merging has rules nobody has
      approved, and a reviewer must not be able to trigger one by accident.
    */
    const src = routes();
    /*
      Registrations only. The word itself appears in a comment explaining that
      no such endpoint exists, and a test that forbade the word would forbid
      documenting the decision.
    */
    const registrations = src.match(/customerRoutes\.(get|post|patch|put|delete)\(\s*'[^']+'/g) ?? [];
    expect(registrations.some((line) => /merge/i.test(line))).toBe(false);
    expect(src).not.toContain('customerRoutes.delete');
  });
});

describe('a decision never edits customer data', () => {
  const service = (): string => read('../customer-duplicate.service.ts');

  it('writes only to the candidate table', () => {
    const src = read('../customer.repository.ts');
    const start = src.indexOf('export async function decideDuplicateCandidate');
    const body = src.slice(start, start + 700);
    expect(body).toContain('prisma.customerDuplicateCandidate.update');
    // No customer write anywhere in that function.
    expect(body).not.toContain('prisma.customer.update');
  });

  it('takes the reviewer from the session, not the request body', () => {
    // A client that could name the decider could attribute its decision to a
    // colleague who never made it.
    const controller = read('../customer.controller.ts');
    const start = controller.indexOf('export async function decideDuplicate');
    const body = controller.slice(start, start + 600);
    expect(body).toContain('currentUser(req)');
  });

  it('cannot set a pair back to SUGGESTED by hand', () => {
    // Reopening happens one way only: a rescan finding the identifiers changed.
    const schemas = readFileSync(
      new URL('../../../../../shared/src/schemas/customer.ts', import.meta.url),
      'utf8',
    );
    const start = schemas.indexOf('customerDuplicateDecisionSchema');
    const body = schemas.slice(start, start + 200);
    expect(body).toContain("z.enum(['CONFIRMED', 'DISMISSED'])");
  });

  it('reports how much of the scan the missing phone normalisation hides', () => {
    /*
      The scan reads phoneNormalized, which existing rows do not have. Returning
      the coverage figures is what stops a caller reading an incomplete scan as
      a complete one.
    */
    const src = service();
    expect(src).toContain('phonePendingNormalization');
    expect(src).toContain('customersScanned');
  });
});
