/**
 * Product image upload.
 *
 * Cloudinary is mocked throughout: these tests exercise validation, permission
 * and the MediaAsset write, and must never reach the real service or need a
 * real credential. The mock stands in for `upload_stream`, which is the only
 * point where this module touches the provider.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const uploadStream = vi.hoisted(() => vi.fn());

vi.mock('cloudinary', () => ({
  v2: {
    config: () => ({ cloud_name: 'test-cloud' }),
    uploader: { upload_stream: uploadStream },
  },
}));

// Configured before the module graph loads, so the upload route is enabled.
process.env.CLOUDINARY_URL = 'cloudinary://key:secret@test-cloud';

const { prisma } = await import('../config/database.js');
const { api, mintToken, startTestServer, stopTestServer } = await import('./helpers/test-server.js');
const { cleanup, makeUser, residualTestRows } = await import('./helpers/fixtures.js');

let user: Awaited<ReturnType<typeof makeUser>>;
let token: string;
const createdAssets: string[] = [];

/** A minimal but genuinely valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Makes upload_stream resolve as Cloudinary would, without a network call. */
function mockCloudinarySuccess(publicId: string) {
  uploadStream.mockImplementation((_options: unknown, callback: Function) => ({
    end: () =>
      callback(null, {
        public_id: publicId,
        secure_url: `https://res.cloudinary.com/test-cloud/image/upload/${publicId}.png`,
        format: 'png',
        width: 1,
        height: 1,
        bytes: PNG.length,
      }),
  }));
}

function mockCloudinaryFailure() {
  uploadStream.mockImplementation((_options: unknown, callback: Function) => ({
    end: () => callback(new Error('Invalid API secret — account 12345'), null),
  }));
}

async function postImage(
  bytes: Buffer,
  filename: string,
  contentType: string,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename);

  const headers: Record<string, string> = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const base = await startTestServer();
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers, body: form });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await startTestServer();
  user = await makeUser('USER');
  token = await mintToken(user.id, { role: 'USER' });
});

afterEach(() => uploadStream.mockReset());

afterAll(async () => {
  if (createdAssets.length) {
    await prisma.mediaAsset.deleteMany({ where: { id: { in: createdAssets } } });
  }
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
  delete process.env.CLOUDINARY_URL;
});

describe('authorization', () => {
  it('refuses an unauthenticated upload', async () => {
    const res = await postImage(PNG, 'a.png', 'image/png');
    expect(res.status).toBe(401);
    expect(uploadStream).not.toHaveBeenCalled();
  });

  it('refuses when the permission is revoked for that person', async () => {
    await prisma.userModulePermission.create({
      data: { userId: user.id, module: 'PRODUCT_ENQUIRY', action: 'CREATE', allowed: false },
    });

    const res = await postImage(PNG, 'a.png', 'image/png', token);
    expect(res.status).toBe(403);
    expect(uploadStream).not.toHaveBeenCalled();

    await prisma.userModulePermission.deleteMany({ where: { userId: user.id } });
  });
});

describe('validation', () => {
  it('rejects a non-image file type', async () => {
    const res = await postImage(Buffer.from('not an image'), 'notes.txt', 'text/plain', token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
    expect(uploadStream).not.toHaveBeenCalled();
  });

  it('rejects a PDF disguised by extension', async () => {
    const res = await postImage(Buffer.from('%PDF-1.7'), 'invoice.pdf', 'application/pdf', token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('rejects an oversized image before contacting the provider', async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
    const res = await postImage(oversized, 'huge.png', 'image/png', token);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
    expect(uploadStream).not.toHaveBeenCalled();
  });

  it('rejects a request with no file attached', async () => {
    const base = await startTestServer();
    const res = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('NO_FILE');
  });
});

describe('successful upload', () => {
  it('stores a MediaAsset and returns only safe fields', async () => {
    mockCloudinarySuccess(`royalstuffs-crm/product-enquiry/zz-test-${Date.now()}`);

    const res = await postImage(PNG, 'bottle.png', 'image/png', token);
    expect(res.status).toBe(201);

    const asset = (res.body.data as { asset: Record<string, unknown> }).asset;
    createdAssets.push(asset.id as string);

    expect(Object.keys(asset).sort()).toEqual(
      ['bytes', 'format', 'height', 'id', 'publicId', 'secureUrl', 'width'].sort(),
    );

    // The row exists and points at Cloudinary, not at stored bytes.
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: asset.id as string },
      select: { publicId: true, secureUrl: true, bytes: true, uploadedById: true },
    });
    expect(row.secureUrl).toContain('res.cloudinary.com');
    expect(row.uploadedById).toBe(user.id);
    expect(row.bytes).toBe(PNG.length);
  });

  it('never returns the credential or provider internals', async () => {
    mockCloudinarySuccess(`royalstuffs-crm/product-enquiry/zz-test-${Date.now()}-b`);

    const res = await postImage(PNG, 'tray.png', 'image/png', token);
    createdAssets.push((res.body.data as { asset: { id: string } }).asset.id);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('cloudinary://');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('api_key');
  });

  it('records the upload in the audit trail', async () => {
    mockCloudinarySuccess(`royalstuffs-crm/product-enquiry/zz-test-${Date.now()}-c`);

    const res = await postImage(PNG, 'lamp.png', 'image/png', token);
    const assetId = (res.body.data as { asset: { id: string } }).asset.id;
    createdAssets.push(assetId);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'media.upload', entityId: assetId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(user.id);
  });
});

describe('provider failure', () => {
  it('reports a generic error and leaks nothing from the provider', async () => {
    mockCloudinaryFailure();

    const res = await postImage(PNG, 'fails.png', 'image/png', token);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPLOAD_FAILED');
    // The provider's message named the account; the response must not.
    expect(JSON.stringify(res.body)).not.toContain('12345');
    expect(JSON.stringify(res.body)).not.toContain('API secret');
  });

  it('writes no MediaAsset row when the upload fails', async () => {
    mockCloudinaryFailure();
    const before = await prisma.mediaAsset.count();

    await postImage(PNG, 'fails2.png', 'image/png', token);

    expect(await prisma.mediaAsset.count()).toBe(before);
  });
});
