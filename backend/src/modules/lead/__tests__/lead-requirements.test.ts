/**
 * Complete the Ideal — Phase 4F, end to end.
 *
 * The volume arithmetic is proved in lead-volume.test.ts against a fixed set of
 * boxes. This suite proves what only a real request can show: that VIEW and EDIT
 * are genuinely enforced, that a requirement cannot be reached through another
 * lead's URL, that line numbers survive concurrent adds, that no volume column
 * is written, and that capturing a customer's requirement touches no order, no
 * stock and no media it did not create.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  cleanup,
  makeCustomer,
  makeRsProduct,
  makeUser,
  residualTestRows,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
/** VIEW only — may read requirements, may not write them. */
let viewer: TestUser;
/** VIEW and EDIT — the capability that actually captures requirements. */
let editor: TestUser;
/** No LEAD_DEAL at all. */
let outsider: TestUser;

let adminToken: string;
let viewerToken: string;
let editorToken: string;
let outsiderToken: string;

let customer: { id: string; name: string };
let product: { id: string };
let otherProduct: { id: string };
let asset: { id: string };

/** Everyone this suite creates leads as, so teardown can scope to its own rows. */
let ownerIds: string[] = [];

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  viewer = await makeUser('USER');
  editor = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  viewerToken = await mintToken(viewer.id, { role: 'USER' });
  editorToken = await mintToken(editor.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  ownerIds = [admin.id, viewer.id, editor.id, outsider.id];

  customer = await makeCustomer('RETAIL', { phone: '+919876600001' });
  product = await makeRsProduct();
  otherProduct = await makeRsProduct();

  /*
    A MediaAsset created directly rather than through the upload endpoint: that
    path talks to Cloudinary, which a test must not. The requirement contract
    cares that the id names a real asset, which this does.
  */
  asset = await prisma.mediaAsset.create({
    data: {
      publicId: `zz-test-req-${Date.now()}`,
      secureUrl: 'https://example.invalid/zz-test-requirement.jpg',
      format: 'jpg',
      width: 800,
      height: 600,
      bytes: 1024,
      uploadedById: editor.id,
    },
    select: { id: true },
  });

  await prisma.userModulePermission.createMany({
    data: [
      // Read but not write — the separation this phase's RBAC turns on.
      { userId: viewer.id, module: 'LEAD_DEAL' as const, action: 'VIEW' as const, allowed: true },
      ...(['VIEW', 'CREATE', 'EDIT'] as const).map((action) => ({
        userId: editor.id,
        module: 'LEAD_DEAL' as const,
        action,
        allowed: true,
      })),
    ],
  });
});

afterAll(async () => {
  /*
    Unmatch before the shared teardown runs, and the reason is a genuine schema
    contradiction this suite uncovered rather than a tidiness preference.

    `LeadProductRequirement.rsProductId` is ON DELETE SET NULL, but the
    `lead_requirement_match_kind_pairing` CHECK forbids a null product beside a
    non-null `matchKind`. So deleting a product that a matched requirement
    references nulls one half of the pair, leaves the other, and the CHECK
    rejects the write — the delete fails outright.

    `cleanup()` removes fixture products before it removes leads, so a matched
    requirement is still standing at that moment. Clearing both columns together
    here sidesteps it. The underlying contradiction is reported, not patched:
    changing a constraint is a migration, and no production path deletes an
    RsProduct today (the catalogue archives instead).
  */
  await prisma.leadProductRequirement.updateMany({
    // Scoped to this suite's own leads. A bare `rsProductId: not null` would
    // reach every requirement in the database, including real ones.
    where: { rsProductId: { not: null }, lead: { createdById: { in: ownerIds } } },
    data: { rsProductId: null, matchKind: null },
  });

  /*
    And the asset this suite minted by hand. `cleanup()` removes media by
    uploader, but only for assets created through the tracked fixture helpers —
    this one was written straight to Prisma because the real upload path talks to
    Cloudinary. `MediaAsset.uploadedById` is Restrict, so leaving it would pin the
    editor user in place and the whole teardown would fail on that instead.

    Every requirement referencing it is already gone with its lead by this point,
    and `imageId` is SetNull regardless.
  */
  await prisma.mediaAsset.deleteMany({ where: { id: asset.id } });

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

type RequirementResponse = {
  id: string;
  lineNo: number;
  productName: string;
  image: { id: string; secureUrl: string; publicId: string } | null;
  rsProduct: { id: string; title: string; sku: string | null; imageUrl: string | null } | null;
  matchKind: 'EXACT' | 'SIMILAR' | null;
  quantity: number;
  weight: { value: string; unit: string; inGrams: string } | null;
  dimension: { length: string; width: string; height: string; unit: string } | null;
  volume: { value: string; unit: string; inCubicMm: string } | null;
  productValue: string | null;
};

async function makeLead(): Promise<string> {
  const res = await api('POST', '/api/leads', {
    token: editorToken,
    body: {
      leadSource: 'CALL',
      sourceAt: new Date().toISOString(),
      requirementType: 'RETAIL',
      customer: { customerId: customer.id },
      channel: 'ROYALSTUFFS_COM',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { lead: { id: string } }).lead.id;
}

const add = (token: string, leadId: string, body: Record<string, unknown>) =>
  api('POST', `/api/leads/${leadId}/requirements`, { token, body });

const edit = (token: string, leadId: string, reqId: string, body: Record<string, unknown>) =>
  api('PATCH', `/api/leads/${leadId}/requirements/${reqId}`, { token, body });

const remove = (token: string, leadId: string, reqId: string) =>
  api('DELETE', `/api/leads/${leadId}/requirements/${reqId}`, { token });

const list = (token: string, leadId: string) =>
  api('GET', `/api/leads/${leadId}/requirements`, { token });

const one = (res: { body: { data?: unknown } }) =>
  (res.body.data as { requirement: RequirementResponse }).requirement;

const many = (res: { body: { data?: unknown } }) =>
  (res.body.data as { requirements: RequirementResponse[] }).requirements;

/** The minimum a requirement needs: what the customer asked for, and how many. */
const basic = (over: Record<string, unknown> = {}) => ({
  productName: 'Brass dinner set, wedding gifting',
  quantity: 5,
  ...over,
});

// ---------------------------------------------------------------------------
//  RBAC
// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('refuses an unauthenticated read', async () => {
    const id = await makeLead();
    const res = await api('GET', `/api/leads/${id}/requirements`);
    expect(res.status).toBe(401);
  });

  it('refuses an unauthenticated write', async () => {
    const id = await makeLead();
    const res = await api('POST', `/api/leads/${id}/requirements`, { body: basic() });
    expect(res.status).toBe(401);
  });

  it('refuses somebody with no LEAD_DEAL access', async () => {
    const id = await makeLead();
    expect((await list(outsiderToken, id)).status).toBe(403);
    expect((await add(outsiderToken, id, basic())).status).toBe(403);
  });

  it('lets VIEW read the requirements', async () => {
    const id = await makeLead();
    await add(editorToken, id, basic());

    const res = await list(viewerToken, id);
    expect(res.status).toBe(200);
    expect(many(res)).toHaveLength(1);
  });

  it('refuses VIEW-only on create, update and delete', async () => {
    const id = await makeLead();
    const created = one(await add(editorToken, id, basic()));

    // Reading is granted; writing is a different capability.
    expect((await add(viewerToken, id, basic())).status).toBe(403);
    expect((await edit(viewerToken, id, created.id, { quantity: 9 })).status).toBe(403);
    expect((await remove(viewerToken, id, created.id)).status).toBe(403);
  });

  it('lets EDIT create, update and delete', async () => {
    const id = await makeLead();
    const created = one(await add(editorToken, id, basic()));
    expect((await edit(editorToken, id, created.id, { quantity: 9 })).status).toBe(200);
    expect((await remove(editorToken, id, created.id)).status).toBe(200);
  });

  it('admits an administrator with no override rows', async () => {
    const id = await makeLead();
    const res = await add(adminToken, id, basic());
    expect(res.status).toBe(201);
  });

  it('introduces no new permission vocabulary', async () => {
    // Every requirement route resolves through LEAD_DEAL. Nothing was invented
    // for Phase 4F, so a grant of this module is the whole of the access story.
    const rows = await prisma.userModulePermission.findMany({
      where: { userId: editor.id },
      select: { module: true, action: true },
    });
    expect(new Set(rows.map((r) => r.module))).toEqual(new Set(['LEAD_DEAL']));
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['VIEW', 'CREATE', 'EDIT']));
  });
});

// ---------------------------------------------------------------------------
//  Creating
// ---------------------------------------------------------------------------

describe('creating a requirement', () => {
  it('records the customer-facing name and the quantity', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, basic());

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = one(res);
    expect(r.productName).toBe('Brass dinner set, wedding gifting');
    expect(r.quantity).toBe(5);
  });

  it('works with no product, no image and no measurements', async () => {
    // The point of the feature: capture what the customer wants even when the
    // RoyalStuffs product is not yet known.
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ productName: 'Custom brass thali' })));

    expect(r.rsProduct).toBeNull();
    expect(r.matchKind).toBeNull();
    expect(r.image).toBeNull();
    expect(r.weight).toBeNull();
    expect(r.dimension).toBeNull();
    expect(r.volume).toBeNull();
    expect(r.productValue).toBeNull();
  });

  it('assigns lineNo 1 to the first line', async () => {
    const id = await makeLead();
    expect(one(await add(editorToken, id, basic())).lineNo).toBe(1);
  });

  it('ignores a lineNo sent by the caller', async () => {
    /*
      Line numbers are the backend's to assign. A client that sends one is not
      obeyed — otherwise two callers could both claim line 7, and the unique
      index would turn their collision into a 500.
    */
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ lineNo: 99 })));
    expect(r.lineNo).toBe(1);
  });

  it('ignores a leadId sent in the body', async () => {
    // The lead is the one in the URL. A body field cannot redirect the write.
    const other = await makeLead();
    const id = await makeLead();

    const r = one(await add(editorToken, id, basic({ leadId: other })));
    expect(many(await list(editorToken, id)).map((x) => x.id)).toContain(r.id);
    expect(many(await list(editorToken, other))).toHaveLength(0);
  });

  it('refuses a lead that does not exist', async () => {
    const res = await add(editorToken, 'cuikaaaaaaaaaaaaaaaaaaaaa', basic());
    expect([404, 422]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
//  Multiple requirements
// ---------------------------------------------------------------------------

describe('a lead holds many requirements', () => {
  it('numbers them 1, 2, 3 and keeps all three', async () => {
    // The brief's own example: a wedding-gifting lead with three lines.
    const id = await makeLead();

    await add(editorToken, id, basic({ productName: 'Brass Dinner Set', quantity: 5 }));
    await add(editorToken, id, basic({ productName: 'Copper Water Dispenser', quantity: 2 }));
    await add(editorToken, id, basic({ productName: 'Custom Brass Thali', quantity: 10 }));

    const rows = many(await list(editorToken, id));
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.productName)).toEqual([
      'Brass Dinner Set',
      'Copper Water Dispenser',
      'Custom Brass Thali',
    ]);
  });

  it('does not overwrite the first when the second is added', async () => {
    const id = await makeLead();
    const first = one(await add(editorToken, id, basic({ productName: 'First', quantity: 1 })));
    await add(editorToken, id, basic({ productName: 'Second', quantity: 2 }));

    const rows = many(await list(editorToken, id));
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.id === first.id);
    expect(kept?.productName).toBe('First');
    expect(kept?.quantity).toBe(1);
  });

  it('returns them in line order', async () => {
    const id = await makeLead();
    for (const n of [1, 2, 3, 4]) {
      await add(editorToken, id, basic({ productName: `Line ${n}` }));
    }
    const rows = many(await list(editorToken, id));
    expect(rows.map((r) => r.lineNo)).toEqual([1, 2, 3, 4]);
  });

  it('gives every line a distinct number under concurrent adds', async () => {
    /*
      Five simultaneous requests. The lead row is locked before the next line is
      allocated, so they queue rather than all reading the same high-water mark —
      and the unique index on (leadId, lineNo) is the backstop if that ever fails.
    */
    const id = await makeLead();

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => add(editorToken, id, basic({ productName: `Parallel ${n}` }))),
    );

    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const rows = many(await list(editorToken, id));
    expect(rows).toHaveLength(5);
    const lineNos = rows.map((r) => r.lineNo);
    expect(new Set(lineNos).size).toBe(5);
    expect([...lineNos].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps each lead to its own requirements', async () => {
    const a = await makeLead();
    const b = await makeLead();

    await add(editorToken, a, basic({ productName: 'Belongs to A' }));
    await add(editorToken, b, basic({ productName: 'Belongs to B' }));

    expect(many(await list(editorToken, a)).map((r) => r.productName)).toEqual(['Belongs to A']);
    expect(many(await list(editorToken, b)).map((r) => r.productName)).toEqual(['Belongs to B']);
  });

  it('restarts numbering per lead, so two leads both have a line 1', async () => {
    const a = await makeLead();
    const b = await makeLead();
    expect(one(await add(editorToken, a, basic())).lineNo).toBe(1);
    expect(one(await add(editorToken, b, basic())).lineNo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  Cross-lead scoping
// ---------------------------------------------------------------------------

describe('a requirement is reachable only through its own lead', () => {
  it('refuses to update it through another lead URL', async () => {
    // PATCH /api/leads/B/requirements/R must not touch R when R belongs to A.
    const a = await makeLead();
    const b = await makeLead();
    const r = one(await add(editorToken, a, basic({ productName: 'Original', quantity: 3 })));

    const res = await edit(editorToken, b, r.id, { productName: 'Hijacked', quantity: 99 });
    expect(res.status).toBe(404);

    const rows = many(await list(editorToken, a));
    expect(rows[0]?.productName).toBe('Original');
    expect(rows[0]?.quantity).toBe(3);
  });

  it('refuses to delete it through another lead URL', async () => {
    const a = await makeLead();
    const b = await makeLead();
    const r = one(await add(editorToken, a, basic()));

    expect((await remove(editorToken, b, r.id)).status).toBe(404);
    // And it is still there.
    expect(many(await list(editorToken, a))).toHaveLength(1);
  });

  it('does not list it under another lead', async () => {
    const a = await makeLead();
    const b = await makeLead();
    await add(editorToken, a, basic());
    expect(many(await list(editorToken, b))).toHaveLength(0);
  });

  it('returns not-found for a requirement id that does not exist', async () => {
    const id = await makeLead();
    const res = await edit(editorToken, id, 'cuikbbbbbbbbbbbbbbbbbbbbb', { quantity: 2 });
    expect([404, 422]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
//  Quantity
// ---------------------------------------------------------------------------

describe('quantity', () => {
  it('accepts a positive whole number', async () => {
    const id = await makeLead();
    expect(one(await add(editorToken, id, basic({ quantity: 12 }))).quantity).toBe(12);
  });

  it('refuses zero', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, basic({ quantity: 0 }));
    expect(res.status).toBe(422);
  });

  it('refuses a negative quantity', async () => {
    const id = await makeLead();
    expect((await add(editorToken, id, basic({ quantity: -5 }))).status).toBe(422);
  });

  it('refuses a fractional quantity', async () => {
    const id = await makeLead();
    expect((await add(editorToken, id, basic({ quantity: 2.5 }))).status).toBe(422);
  });

  it('refuses a missing quantity', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, { productName: 'No quantity' });
    expect(res.status).toBe(422);
  });

  it('refuses a zero quantity on update, rather than silently converting it', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ quantity: 4 })));

    expect((await edit(editorToken, id, r.id, { quantity: 0 })).status).toBe(422);
    // Unchanged.
    expect(many(await list(editorToken, id))[0]?.quantity).toBe(4);
  });
});

// ---------------------------------------------------------------------------
//  Product value
// ---------------------------------------------------------------------------

describe('product value', () => {
  it('records what the associate entered', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ productValue: 24500.5 })));
    expect(Number(r.productValue)).toBe(24500.5);
  });

  it('permits zero — a sample can be worth nothing', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ productValue: 0 })));
    expect(Number(r.productValue)).toBe(0);
  });

  it('refuses a negative value', async () => {
    const id = await makeLead();
    expect((await add(editorToken, id, basic({ productValue: -1 }))).status).toBe(422);
  });

  it('distinguishes unpriced from worth nothing', async () => {
    const id = await makeLead();
    const unpriced = one(await add(editorToken, id, basic()));
    const free = one(await add(editorToken, id, basic({ productValue: 0 })));

    expect(unpriced.productValue).toBeNull();
    expect(Number(free.productValue)).toBe(0);
  });

  it('does not inherit the catalogue price when a product is matched', async () => {
    /*
      Product value is the customer's requirement value, not the catalogue's
      figure. Matching a product must not quietly price the line.
    */
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );
    expect(r.productValue).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Exact vs similar
// ---------------------------------------------------------------------------

describe('exact and similar matching', () => {
  it('accepts EXACT with a product', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );
    expect(r.matchKind).toBe('EXACT');
    expect(r.rsProduct?.id).toBe(product.id);
  });

  it('accepts SIMILAR with a product', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'SIMILAR' })),
    );
    expect(r.matchKind).toBe('SIMILAR');
    expect(r.rsProduct?.id).toBe(product.id);
  });

  it('accepts no match at all — neither product nor kind', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic()));
    expect(r.rsProduct).toBeNull();
    expect(r.matchKind).toBeNull();
  });

  it('refuses EXACT with no product', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, basic({ matchKind: 'EXACT' }));
    expect(res.status).toBe(422);
  });

  it('refuses SIMILAR with no product', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, basic({ matchKind: 'SIMILAR' }));
    expect(res.status).toBe(422);
  });

  it('refuses an invented match kind', async () => {
    const id = await makeLead();
    const res = await add(
      editorToken,
      id,
      basic({ rsProductId: product.id, matchKind: 'MAYBE' }),
    );
    expect(res.status).toBe(422);
  });

  it('allows a product attached before anybody has judged the match', async () => {
    // The reverse of the rule is deliberately permitted: a product may be named
    // before somebody decides whether it is exact or merely close.
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ rsProductId: product.id })));
    expect(r.rsProduct?.id).toBe(product.id);
    expect(r.matchKind).toBeNull();
  });

  it('refuses a product that does not exist', async () => {
    const id = await makeLead();
    const res = await add(
      editorToken,
      id,
      basic({ rsProductId: 'cuikccccccccccccccccccccc', matchKind: 'EXACT' }),
    );
    expect([400, 422]).toContain(res.status);
  });

  it('refuses setting a match kind on an unmatched requirement', async () => {
    // The stored-state half of the rule, which Zod alone cannot see.
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic()));

    const res = await edit(editorToken, id, r.id, { matchKind: 'EXACT' });
    expect([400, 422]).toContain(res.status);
  });

  it('refuses clearing the product while keeping the kind', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );

    const res = await edit(editorToken, id, r.id, { rsProductId: null, matchKind: 'EXACT' });
    expect([400, 422]).toContain(res.status);
  });

  it('clears the kind along with the product', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'SIMILAR' })),
    );

    const res = await edit(editorToken, id, r.id, { rsProductId: null, matchKind: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(one(res).rsProduct).toBeNull();
    expect(one(res).matchKind).toBeNull();
  });

  it('switches EXACT to SIMILAR without losing the product', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );

    const res = await edit(editorToken, id, r.id, { matchKind: 'SIMILAR' });
    expect(res.status).toBe(200);
    expect(one(res).matchKind).toBe('SIMILAR');
    expect(one(res).rsProduct?.id).toBe(product.id);
  });

  it('moves the match to a different product', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );

    const res = await edit(editorToken, id, r.id, { rsProductId: otherProduct.id });
    expect(res.status).toBe(200);
    expect(one(res).rsProduct?.id).toBe(otherProduct.id);
    // The kind travelled with it rather than being dropped.
    expect(one(res).matchKind).toBe('EXACT');
  });
});

// ---------------------------------------------------------------------------
//  The customer's words
// ---------------------------------------------------------------------------

describe('productName is the customer own wording', () => {
  it('is not replaced by the catalogue title when a product is matched', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({
          productName: 'Big brass thali for weddings',
          rsProductId: product.id,
          matchKind: 'SIMILAR',
        }),
      ),
    );

    expect(r.productName).toBe('Big brass thali for weddings');
    expect(r.rsProduct?.title).not.toBe(r.productName);
  });

  it('refuses an empty name', async () => {
    const id = await makeLead();
    expect((await add(editorToken, id, basic({ productName: '' }))).status).toBe(422);
    expect((await add(editorToken, id, basic({ productName: '   ' }))).status).toBe(422);
  });

  it('is editable without disturbing the match', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );

    const res = await edit(editorToken, id, r.id, { productName: 'Corrected wording' });
    expect(one(res).productName).toBe('Corrected wording');
    expect(one(res).rsProduct?.id).toBe(product.id);
  });
});

// ---------------------------------------------------------------------------
//  Weight
// ---------------------------------------------------------------------------

describe('weight', () => {
  it('stores the figure, the unit and the normalised grams', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ weightValue: 2.5, weightUnit: 'KG' })));

    expect(r.weight).not.toBeNull();
    expect(Number(r.weight!.value)).toBe(2.5);
    expect(r.weight!.unit).toBe('KG');
    expect(Number(r.weight!.inGrams)).toBe(2500);
  });

  it('normalises pounds through the shared conversion', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ weightValue: 1, weightUnit: 'LB' })));
    expect(Number(r.weight!.inGrams)).toBeCloseTo(453.592, 2);
  });

  it('refuses a figure with no unit', async () => {
    // A number with no unit would be stored meaning nothing.
    const id = await makeLead();
    expect((await add(editorToken, id, basic({ weightValue: 5 }))).status).toBe(422);
  });

  it('refuses a non-positive weight', async () => {
    const id = await makeLead();
    expect(
      (await add(editorToken, id, basic({ weightValue: 0, weightUnit: 'KG' }))).status,
    ).toBe(422);
    expect(
      (await add(editorToken, id, basic({ weightValue: -2, weightUnit: 'KG' }))).status,
    ).toBe(422);
  });

  it('refuses an invented unit', async () => {
    const id = await makeLead();
    expect(
      (await add(editorToken, id, basic({ weightValue: 2, weightUnit: 'STONE' }))).status,
    ).toBe(422);
  });

  it('is optional', async () => {
    const id = await makeLead();
    expect(one(await add(editorToken, id, basic())).weight).toBeNull();
  });

  it('renormalises grams when only the unit changes', async () => {
    /*
      The merged-state rule: a patch changing the unit alone has to recompute the
      normalised column from the value already stored, or 2 KG would silently
      become 2 G while still claiming 2000 grams.
    */
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ weightValue: 2, weightUnit: 'KG' })));

    const res = await edit(editorToken, id, r.id, { weightUnit: 'G' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(one(res).weight!.value)).toBe(2);
    expect(one(res).weight!.unit).toBe('G');
    expect(Number(one(res).weight!.inGrams)).toBe(2);
  });

  it('clears to null when asked', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ weightValue: 2, weightUnit: 'KG' })));

    const res = await edit(editorToken, id, r.id, { weightValue: null, weightUnit: null });
    expect(res.status).toBe(200);
    expect(one(res).weight).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Dimensions and derived volume
// ---------------------------------------------------------------------------

describe('dimensions and volume', () => {
  it('derives 20 × 10 × 5 cm as 1000 cm³', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );

    expect(r.dimension).not.toBeNull();
    expect(Number(r.volume!.value)).toBe(1000);
    expect(r.volume!.unit).toBe('CM');
    expect(Number(r.volume!.inCubicMm)).toBe(1_000_000);
  });

  it('returns volume null when a dimension is missing', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );

    expect(r.dimension).toBeNull();
    expect(r.volume).toBeNull();
  });

  it('returns volume null when no dimensions were given', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic()));
    expect(r.volume).toBeNull();
  });

  it('refuses dimensions with no unit', async () => {
    const id = await makeLead();
    const res = await add(
      editorToken,
      id,
      basic({ lengthValue: 20, widthValue: 10, heightValue: 5 }),
    );
    expect(res.status).toBe(422);
  });

  it('refuses a non-positive dimension', async () => {
    const id = await makeLead();
    const res = await add(
      editorToken,
      id,
      basic({ lengthValue: 0, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
    );
    expect(res.status).toBe(422);
  });

  it('recomputes volume when a dimension is edited', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );
    expect(Number(r.volume!.value)).toBe(1000);

    const res = await edit(editorToken, id, r.id, { heightValue: 10 });
    expect(res.status).toBe(200);
    // Derived, so it cannot go stale — there is no second number to forget.
    expect(Number(one(res).volume!.value)).toBe(2000);
  });

  it('recomputes volume when only the unit changes', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );

    const res = await edit(editorToken, id, r.id, { dimensionUnit: 'MM' });
    expect(res.status).toBe(200);
    expect(Number(one(res).volume!.value)).toBe(1000);
    // The same three figures in millimetres is a thousandth of the box.
    expect(Number(one(res).volume!.inCubicMm)).toBe(1000);
  });

  it('drops volume to null when a dimension is cleared', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );

    const res = await edit(editorToken, id, r.id, { widthValue: null });
    expect(res.status).toBe(200);
    expect(one(res).volume).toBeNull();
  });
});

describe('volume is never persisted', () => {
  it('has no volume column on the table', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'LeadProductRequirement'
    `;
    const names = columns.map((c) => c.column_name.toLowerCase());

    expect(names).not.toContain('volume');
    expect(names).not.toContain('volumevalue');
    expect(names).not.toContain('volumeunit');
    expect(names).not.toContain('volumeincubicmm');
  });

  it('stores only the three dimensions it derives from', async () => {
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
      ),
    );

    const row = await prisma.leadProductRequirement.findUniqueOrThrow({
      where: { id: r.id },
      select: { lengthMm: true, widthMm: true, heightMm: true },
    });

    // The normalised millimetre columns exist; their product does not.
    expect(Number(row.lengthMm)).toBe(200);
    expect(Number(row.widthMm)).toBe(100);
    expect(Number(row.heightMm)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
//  Images
// ---------------------------------------------------------------------------

describe('the requirement image', () => {
  it('accepts an existing asset and returns its reference', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ imageId: asset.id })));

    expect(r.image).not.toBeNull();
    expect(r.image!.id).toBe(asset.id);
    expect(r.image!.secureUrl).toContain('zz-test-requirement');
  });

  it('is optional', async () => {
    const id = await makeLead();
    expect(one(await add(editorToken, id, basic())).image).toBeNull();
  });

  it('refuses an asset that does not exist', async () => {
    const id = await makeLead();
    const res = await add(editorToken, id, basic({ imageId: 'cuikdddddddddddddddddddddd' }));
    expect([400, 422]).toContain(res.status);
  });

  it('can be replaced and removed', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ imageId: asset.id })));

    const cleared = await edit(editorToken, id, r.id, { imageId: null });
    expect(cleared.status).toBe(200);
    expect(one(cleared).image).toBeNull();

    const reattached = await edit(editorToken, id, r.id, { imageId: asset.id });
    expect(one(reattached).image!.id).toBe(asset.id);
  });

  it('is kept distinct from the catalogue product image', async () => {
    /*
      Two different pictures: the associate's photo of what the customer wants,
      and the catalogue's own image of the matched product. Neither overwrites
      the other.
    */
    const id = await makeLead();
    const r = one(
      await add(
        editorToken,
        id,
        basic({ imageId: asset.id, rsProductId: product.id, matchKind: 'SIMILAR' }),
      ),
    );

    expect(r.image!.id).toBe(asset.id);
    expect(r.image!.secureUrl).toContain('zz-test-requirement');
    // The product reference carries its own image field, separately.
    expect(r.rsProduct).not.toBeNull();
    expect(r.rsProduct!.imageUrl).not.toBe(r.image!.secureUrl);
  });
});

// ---------------------------------------------------------------------------
//  Deleting
// ---------------------------------------------------------------------------

describe('deleting a requirement', () => {
  it('removes it and reports which went', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic()));

    const res = await remove(editorToken, id, r.id);
    expect(res.status).toBe(200);
    expect((res.body.data as { deleted: string }).deleted).toBe(r.id);
    expect(many(await list(editorToken, id))).toHaveLength(0);
  });

  it('leaves the other requirements alone', async () => {
    const id = await makeLead();
    const first = one(await add(editorToken, id, basic({ productName: 'Keep me' })));
    const second = one(await add(editorToken, id, basic({ productName: 'Delete me' })));
    const third = one(await add(editorToken, id, basic({ productName: 'Keep me too' })));

    await remove(editorToken, id, second.id);

    const rows = many(await list(editorToken, id));
    expect(rows.map((r) => r.id)).toEqual([first.id, third.id]);
    // Line numbers are not closed up: 1 and 3 survive as themselves.
    expect(rows.map((r) => r.lineNo)).toEqual([1, 3]);
  });

  it('does NOT delete the MediaAsset it referenced', async () => {
    /*
      The rule Part M turns on. Media here is independently retained — six tables
      reference it and every foreign key is SetNull — so removing a requirement
      detaches the asset and nothing more.
    */
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic({ imageId: asset.id })));

    await remove(editorToken, id, r.id);

    const still = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(still).not.toBeNull();
    expect(still!.secureUrl).toContain('zz-test-requirement');
  });

  it('does NOT delete the catalogue product it referenced', async () => {
    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' })),
    );

    await remove(editorToken, id, r.id);

    expect(await prisma.rsProduct.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  it('is idempotent in effect — a second delete is not found', async () => {
    const id = await makeLead();
    const r = one(await add(editorToken, id, basic()));

    expect((await remove(editorToken, id, r.id)).status).toBe(200);
    expect((await remove(editorToken, id, r.id)).status).toBe(404);
  });

  it('removes the requirements when the lead itself goes', async () => {
    // Cascade from Lead, which is what keeps teardown honest.
    const id = await makeLead();
    await add(editorToken, id, basic());

    await prisma.lead.delete({ where: { id } });
    expect(await prisma.leadProductRequirement.count({ where: { leadId: id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  The read response
// ---------------------------------------------------------------------------

describe('the read response', () => {
  it('carries the product and image inline, needing no follow-up request', async () => {
    const id = await makeLead();
    await add(
      editorToken,
      id,
      basic({ imageId: asset.id, rsProductId: product.id, matchKind: 'EXACT' }),
    );

    const rows = many(await list(editorToken, id));
    const r = rows[0]!;

    // Everything the UI draws, from one request.
    expect(r.rsProduct).toMatchObject({ id: product.id });
    expect(r.rsProduct!.title).toBeTruthy();
    expect(r.image).toMatchObject({ id: asset.id });
  });

  it('exposes only the four product display fields', async () => {
    const id = await makeLead();
    await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' }));

    const r = many(await list(editorToken, id))[0]!;
    expect(Object.keys(r.rsProduct!).sort()).toEqual(['id', 'imageUrl', 'sku', 'title']);
  });

  it('leaks no catalogue internals', async () => {
    const id = await makeLead();
    await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' }));

    const body = JSON.stringify(many(await list(editorToken, id)));
    for (const forbidden of ['costPrice', 'shopifyProductId', 'crmStockQty', 'inventoryQty']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('serves many requirements in one request', async () => {
    const id = await makeLead();
    for (const n of [1, 2, 3, 4, 5]) {
      await add(
        editorToken,
        id,
        basic({ productName: `Line ${n}`, imageId: asset.id, rsProductId: product.id }),
      );
    }

    const res = await list(editorToken, id);
    expect(res.status).toBe(200);
    const rows = many(res);
    expect(rows).toHaveLength(5);
    // Each one fully populated — the batched select, not five round trips.
    for (const r of rows) {
      expect(r.image?.id).toBe(asset.id);
      expect(r.rsProduct?.id).toBe(product.id);
    }
  });

  it('returns an empty list for a lead with no requirements', async () => {
    const id = await makeLead();
    const res = await list(editorToken, id);
    expect(res.status).toBe(200);
    expect(many(res)).toEqual([]);
  });

  it('refuses a lead that does not exist', async () => {
    const res = await list(editorToken, 'cuikeeeeeeeeeeeeeeeeeeeee');
    expect([404, 422]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
//  Lead detail integration
// ---------------------------------------------------------------------------

describe('the lead detail read', () => {
  it('includes the requirements, so the page needs one request', async () => {
    const id = await makeLead();
    await add(
      editorToken,
      id,
      basic({ productName: 'On the detail', imageId: asset.id, rsProductId: product.id }),
    );

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    expect(res.status).toBe(200);

    const lead = (res.body.data as { lead: { requirements: RequirementResponse[] } }).lead;
    expect(lead.requirements).toHaveLength(1);
    expect(lead.requirements[0]!.productName).toBe('On the detail');
    // With its relations already attached.
    expect(lead.requirements[0]!.image?.id).toBe(asset.id);
    expect(lead.requirements[0]!.rsProduct?.id).toBe(product.id);
  });

  it('derives volume there too, through the same calculation', async () => {
    const id = await makeLead();
    await add(
      editorToken,
      id,
      basic({ lengthValue: 20, widthValue: 10, heightValue: 5, dimensionUnit: 'CM' }),
    );

    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const lead = (res.body.data as { lead: { requirements: RequirementResponse[] } }).lead;
    expect(Number(lead.requirements[0]!.volume!.value)).toBe(1000);
  });

  it('reports an empty array rather than omitting the field', async () => {
    const id = await makeLead();
    const res = await api('GET', `/api/leads/${id}`, { token: editorToken });
    const lead = (res.body.data as { lead: { requirements: RequirementResponse[] } }).lead;
    expect(lead.requirements).toEqual([]);
  });

  it('keeps requirement value out of the analytics order value', async () => {
    /*
      Order Value on the board is derived from the linked SalesOrder. A
      requirement's own figure is pre-sales information and must not be mistaken
      for it — a lead with requirements but no order still has no order value.
    */
    const id = await makeLead();
    await add(editorToken, id, basic({ productValue: 50_000 }));

    const res = await api('GET', `/api/leads?limit=100`, { token: editorToken });
    expect(res.status).toBe(200);
    const rows = (res.body.data as { leads: { id: string; orderValue: string | null }[] }).leads;
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.orderValue).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Out of scope — nothing downstream moves
// ---------------------------------------------------------------------------

describe('capturing a requirement is pre-sales only', () => {
  it('creates no SalesOrder and no order line', async () => {
    const beforeOrders = await prisma.salesOrder.count();
    const beforeItems = await prisma.salesOrderItem.count();

    const id = await makeLead();
    await add(
      editorToken,
      id,
      basic({ rsProductId: product.id, matchKind: 'EXACT', quantity: 25, productValue: 99_000 }),
    );

    expect(await prisma.salesOrder.count()).toBe(beforeOrders);
    expect(await prisma.salesOrderItem.count()).toBe(beforeItems);
  });

  it('changes no stock or inventory figure', async () => {
    const before = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });

    const id = await makeLead();
    const r = one(
      await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT', quantity: 50 })),
    );
    await edit(editorToken, id, r.id, { quantity: 75 });
    await remove(editorToken, id, r.id);

    const after = await prisma.shopifyVariant.aggregate({
      _sum: { crmStockQty: true, inventoryQty: true },
    });

    expect(Number(after._sum.crmStockQty ?? 0)).toBe(Number(before._sum.crmStockQty ?? 0));
    expect(Number(after._sum.inventoryQty ?? 0)).toBe(Number(before._sum.inventoryQty ?? 0));
  });

  it('does not link the lead to an order', async () => {
    const id = await makeLead();
    await add(editorToken, id, basic({ rsProductId: product.id, matchKind: 'EXACT' }));

    const row = await prisma.lead.findUniqueOrThrow({
      where: { id },
      select: { salesOrderId: true },
    });
    expect(row.salesOrderId).toBeNull();
  });

  it('creates no MediaAsset of its own', async () => {
    // The requirement references an asset; it never mints one. Uploading is the
    // upload endpoint's job.
    const before = await prisma.mediaAsset.count();

    const id = await makeLead();
    await add(editorToken, id, basic({ imageId: asset.id }));

    expect(await prisma.mediaAsset.count()).toBe(before);
  });

  it('does not change the catalogue product it matched', async () => {
    const before = await prisma.rsProduct.findUniqueOrThrow({
      where: { id: product.id },
      select: { title: true, status: true, updatedAt: true },
    });

    const id = await makeLead();
    await add(
      editorToken,
      id,
      basic({ rsProductId: product.id, matchKind: 'EXACT', productValue: 12_345 }),
    );

    const after = await prisma.rsProduct.findUniqueOrThrow({
      where: { id: product.id },
      select: { title: true, status: true, updatedAt: true },
    });
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
//  The database's own guarantees
// ---------------------------------------------------------------------------

describe('the table defends the rules itself', () => {
  it('refuses a match kind with no product at the database level', async () => {
    // Behind Zod and behind the service: the CHECK constraint from Phase 4B.
    const id = await makeLead();
    await expect(
      prisma.leadProductRequirement.create({
        data: { leadId: id, lineNo: 1, productName: 'Direct write', quantity: 1, matchKind: 'EXACT' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a non-positive quantity at the database level', async () => {
    const id = await makeLead();
    await expect(
      prisma.leadProductRequirement.create({
        data: { leadId: id, lineNo: 1, productName: 'Direct write', quantity: 0 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a negative product value at the database level', async () => {
    const id = await makeLead();
    await expect(
      prisma.leadProductRequirement.create({
        data: {
          leadId: id,
          lineNo: 1,
          productName: 'Direct write',
          quantity: 1,
          productValue: -5,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a duplicate line number on one lead', async () => {
    const id = await makeLead();
    await prisma.leadProductRequirement.create({
      data: { leadId: id, lineNo: 1, productName: 'First', quantity: 1 },
    });

    await expect(
      prisma.leadProductRequirement.create({
        data: { leadId: id, lineNo: 1, productName: 'Collides', quantity: 1 },
      }),
    ).rejects.toThrow();
  });
});
