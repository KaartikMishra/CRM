/**
 * The secure document foundation.
 *
 * ### What these tests do and do not cover
 *
 * No file is uploaded to Cloudinary here. That would make the suite depend on a
 * third party being reachable and on a real account accumulating test objects, and
 * it would test Cloudinary rather than this code. What is tested instead is
 * everything that decides whether a document is safe:
 *
 *   - **No URL is stored.** Asserted against `information_schema`, not against the
 *     Prisma file, because the column's absence in the database is the actual
 *     guarantee. This is the single most important property here.
 *   - **The delivery type cannot be public.** Asserted by trying to write a public
 *     row and being refused by the CHECK.
 *   - **A signed URL is signed, scoped and expiring.** Asserted on the minted URL
 *     itself; `private_download_url` signs locally and makes no network call.
 *   - **MediaAsset is untouched**, so the six shipped modules that use it keep the
 *     public delivery they are built on.
 *
 * The upload path itself — `storeSecureDocument` — is exercised by its guards
 * (type and size) rather than by a round trip, and the belt-and-braces check that
 * refuses a non-authenticated Cloudinary response is reachable only when the
 * provider misbehaves, which is why it logs and deletes rather than being asserted
 * here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../config/database.js';
import {
  SECURE_DOCUMENT_MIME_TYPES,
  assertAcceptableDocument,
  signedUrlFor,
} from '../secure-document.service.js';
import { isCloudinaryConfigured } from '../../config/cloudinary.js';
import { ALLOWED_MIME_TYPES } from '../../modules/upload/upload.service.js';
import { cleanup, makeUser, type TestUser } from '../../__tests__/helpers/fixtures.js';
import { AppError } from '../../utils/AppError.js';

let owner: TestUser;
const createdIds: string[] = [];

/** A row written directly, since no bytes are uploaded in these tests. */
async function storeRow(
  overrides: Partial<{
    kind: 'PAYSLIP' | 'IDENTITY_PROOF';
    module: 'HR_PAYROLL' | 'HR_EMPLOYEE';
    deliveryType: string;
    mimeType: string;
    bytes: number | null;
  }> = {},
): Promise<{ id: string; publicId: string; mimeType: string | null }> {
  const row = await prisma.secureDocument.create({
    data: {
      publicId: `royalstuffs-crm/secure/zz-test-${Math.random().toString(36).slice(2, 14)}`,
      deliveryType: overrides.deliveryType ?? 'authenticated',
      kind: overrides.kind ?? 'PAYSLIP',
      module: overrides.module ?? 'HR_PAYROLL',
      ownerType: 'User',
      ownerId: owner.id,
      fileName: 'payslip-october.pdf',
      mimeType: overrides.mimeType ?? 'application/pdf',
      bytes: overrides.bytes === undefined ? 48_000 : overrides.bytes,
      uploadedById: owner.id,
    },
    select: { id: true, publicId: true, mimeType: true },
  });
  createdIds.push(row.id);
  return row;
}

beforeAll(async () => {
  owner = await makeUser('ADMIN');
});

afterAll(async () => {
  await prisma.secureDocument.deleteMany({ where: { id: { in: createdIds } } });
  await cleanup();
});

describe('no URL is ever stored — the central property', () => {
  it('has no secureUrl column, unlike MediaAsset', async () => {
    /*
      Asserted against the database rather than the schema file, because the
      column's absence in Postgres is the guarantee — a schema that merely omits
      it while the table has it would pass a Prisma-level check.

      The reasoning, restated because it is the whole design: a stored URL
      outlives every access check. Once written to a row it can be read by any
      future query, logged by any future handler and serialised into any future
      response, and nothing downstream can tell it should not have been. Revoking
      it is impossible short of deleting the object. MediaAsset.secureUrl is
      exactly how its files became world-readable.
    */
    const columns = (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'SecureDocument'
    `).map((c) => c.column_name);

    expect(columns).not.toContain('secureUrl');
    expect(columns).not.toContain('url');
    // publicId is the only durable identifier, and it is useless without a
    // signature — so a leaked database row does not leak the documents.
    expect(columns).toContain('publicId');
  });

  it('leaves MediaAsset still carrying its own secureUrl', async () => {
    /*
      The companion assertion, and the reason SecureDocument is a second table.
      Six shipped modules — product, enquiry, sales, purchase, lead, post-sales —
      depend on MediaAsset delivering public URLs. If this ever fails, product
      images have been made private as a side effect of an HR feature.
    */
    const columns = (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'MediaAsset'
    `).map((c) => c.column_name);

    expect(columns).toContain('secureUrl');
  });

  it('returns no URL when a document is read back', async () => {
    const stored = await storeRow();

    const row = await prisma.secureDocument.findUniqueOrThrow({ where: { id: stored.id } });

    // Nothing URL-shaped anywhere on the row, so a list endpoint cannot hand out
    // fetchable links to every document it mentions.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') {
        expect(value.startsWith('http')).toBe(false);
      }
    }
  });
});

describe('a document cannot be stored with public delivery', () => {
  it('refuses Cloudinary’s public default', async () => {
    /*
      'upload' is Cloudinary's public type and what every MediaAsset uses. A
      SecureDocument delivered that way is the one failure this table exists to
      prevent — the row would promise confidentiality while the file was fetchable
      by anybody with the link — so the database refuses it rather than trusting
      every future caller to pass the right parameter.
    */
    await expect(storeRow({ deliveryType: 'upload' })).rejects.toThrow();
  });

  it('refuses an empty delivery type', async () => {
    await expect(storeRow({ deliveryType: '' })).rejects.toThrow();
  });

  it('accepts authenticated and private, and nothing else', async () => {
    const authenticated = await storeRow({ deliveryType: 'authenticated' });
    expect(authenticated.id).toBeTruthy();

    const privateRow = await storeRow({ deliveryType: 'private' });
    expect(privateRow.id).toBeTruthy();

    await expect(storeRow({ deliveryType: 'public' })).rejects.toThrow();
  });
});

describe('the other constraints', () => {
  it('refuses a zero-byte file', async () => {
    await expect(storeRow({ bytes: 0 })).rejects.toThrow();
  });

  it('allows an unknown size', async () => {
    // Null is "not recorded", which is different from zero and is legitimate.
    const row = await storeRow({ bytes: null });
    expect(row.id).toBeTruthy();
  });

  it('refuses a blank owner reference', async () => {
    await expect(
      prisma.secureDocument.create({
        data: {
          publicId: `zz-test-${Math.random().toString(36).slice(2, 10)}`,
          kind: 'PAYSLIP',
          module: 'HR_PAYROLL',
          ownerType: '  ',
          ownerId: owner.id,
          uploadedById: owner.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses two rows for the same stored object', async () => {
    const first = await storeRow();

    // One stored object is one row; a second would mean two access decisions for
    // the same bytes.
    await expect(
      prisma.secureDocument.create({
        data: {
          publicId: first.publicId,
          kind: 'PAYSLIP',
          module: 'HR_PAYROLL',
          ownerType: 'User',
          ownerId: owner.id,
          uploadedById: owner.id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('what a confidential document may be', () => {
  it('accepts PDFs, which the image uploader does not', async () => {
    expect(SECURE_DOCUMENT_MIME_TYPES).toContain('application/pdf');
    /*
      The reason this list is separate rather than a widened ALLOWED_MIME_TYPES:
      HR documents are overwhelmingly PDFs and scans, and an identity proof that
      cannot be a PDF is not a usable feature — but widening the shared image
      uploader would let PDFs into product, enquiry, sales, purchase, lead and
      post-sales attachments as a side effect.
    */
    expect(ALLOWED_MIME_TYPES as readonly string[]).not.toContain('application/pdf');
  });

  it('excludes office formats, which carry macros', () => {
    for (const type of [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'text/html',
    ]) {
      expect(SECURE_DOCUMENT_MIME_TYPES as readonly string[]).not.toContain(type);
    }
  });

  it('rejects an unsupported type before anything is stored', () => {
    expect(() =>
      assertAcceptableDocument({ mimetype: 'application/zip', size: 1000 }, 5_000_000),
    ).toThrow(AppError);
  });

  it('rejects a file over the cap', () => {
    expect(() =>
      assertAcceptableDocument({ mimetype: 'application/pdf', size: 9_000_000 }, 5_000_000),
    ).toThrow(AppError);
  });

  it('accepts a PDF within the cap', () => {
    expect(() =>
      assertAcceptableDocument({ mimetype: 'application/pdf', size: 1_000_000 }, 5_000_000),
    ).not.toThrow();
  });
});

describe('signed delivery', () => {
  // Signing is local — private_download_url makes no network call — but it needs
  // the credential to sign with, so these are skipped on a machine without one
  // rather than asserted falsely.
  const configured = isCloudinaryConfigured();

  it.skipIf(!configured)('mints a signed, expiring URL for a stored document', () => {
    const { url, expiresAt } = signedUrlFor(
      { publicId: 'royalstuffs-crm/secure/example', mimeType: 'application/pdf' },
      600,
    );

    expect(url.startsWith('https://')).toBe(true);
    // The signature and the expiry are what make the URL work at all; an
    // authenticated object is unreachable without both.
    expect(url).toContain('signature=');
    expect(url).toContain('expires_at=');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);
  });

  it.skipIf(!configured)('honours the requested lifetime', () => {
    const brief = signedUrlFor(
      { publicId: 'royalstuffs-crm/secure/example', mimeType: 'application/pdf' },
      60,
    );
    const longer = signedUrlFor(
      { publicId: 'royalstuffs-crm/secure/example', mimeType: 'application/pdf' },
      3600,
    );

    expect(brief.expiresAt.getTime()).toBeLessThan(longer.expiresAt.getTime());
  });

  it.skipIf(!configured)('mints different URLs for the same object at different expiries', () => {
    /*
      A URL is a bearer token once minted — there is no way to bind it to a
      session, and that is the residual risk this design accepts rather than hides.
      The mitigation is that it is short-lived and minted only after permission has
      been resolved, so two mints are genuinely different grants.
    */
    const a = signedUrlFor({ publicId: 'royalstuffs-crm/secure/x', mimeType: 'image/png' }, 60);
    const b = signedUrlFor({ publicId: 'royalstuffs-crm/secure/x', mimeType: 'image/png' }, 120);

    expect(a.url).not.toBe(b.url);
  });
});

describe('no Employee model is implied', () => {
  it('has no employeeId column', async () => {
    /*
      Employee arrives in Phase 1. Inventing a placeholder table to hang a foreign
      key on would create exactly the duplicate identity this phase forbids, so
      ownership is polymorphic for now and the typed relation is added additively
      later — against an abstraction that already works and is already tested.
    */
    const columns = (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'SecureDocument'
    `).map((c) => c.column_name);

    expect(columns).not.toContain('employeeId');
    expect(columns).toContain('ownerType');
    expect(columns).toContain('ownerId');
  });

  it('still has no second user or authentication table', async () => {
    /*
      Updated in Phase 1, which added Employee, Department and EmployeeDocument —
      the anticipated change this file's docblock described. What must never appear
      is a second identity: `HRUser`, `EmployeeAccount` or anything else holding
      credentials beside `User`.

      Employee is the HR record; User is the authenticated account; they are joined
      by an optional 1:1 and no password, role or permission lives on the HR side.
    */
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('HRUser', 'EmployeeAccount', 'HRAuditLog', 'HRNotification')
    `;
    expect(tables).toEqual([]);

    // And the HR record carries no credential column.
    const columns = (await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'Employee'
    `).map((c) => c.column_name);
    for (const forbidden of ['passwordHash', 'password', 'role', 'sessionToken']) {
      expect(columns, forbidden).not.toContain(forbidden);
    }
  });
});
