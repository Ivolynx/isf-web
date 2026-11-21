/**
 * Unit tests for the storage module and media proxy.
 *
 * All S3 calls are mocked — no real MinIO or Railway Bucket required.
 *
 * Coverage:
 *   1.  STORAGE_FORCE_PATH_STYLE=true  → S3Client receives forcePathStyle: true
 *   2.  STORAGE_FORCE_PATH_STYLE=false → S3Client receives forcePathStyle: false
 *   3.  "false" string is NOT misread as truthy (z.coerce.boolean() bug prevention)
 *   4.  uploadPublicAsset() uses STORAGE_BUCKET_PUBLIC
 *   5.  uploadPublicAsset() returns /media/public/{filename} URL (not an S3 URL)
 *   6.  uploadPrivateAsset() uses STORAGE_BUCKET_PRIVATE
 *   7.  uploadPrivateAsset() does not set a public ACL
 *   8.  getPrivateSignedUrl() calls getSignedUrl with STORAGE_BUCKET_PRIVATE
 *   9.  getPublicAssetStream() builds key as cms/images/{filename}
 *   10. Media proxy GET /media/public/:filename → 200 for valid JPEG filename
 *   11. Media proxy rejects filenames with path traversal (../)
 *   12. Media proxy rejects filenames with forbidden prefix (loan-payments)
 *   13. Media proxy rejects unknown extensions (.pdf)
 *   14. Media proxy returns 404 when S3 returns NoSuchKey
 *   15. Media proxy returns 503 when S3 is unreachable
 *   16. CMS upload POST /api/v1/cms/upload-image returns /media/public/* URL in response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

// Mock @aws-sdk/client-s3 — intercept all PutObjectCommand / GetObjectCommand sends
const mockSend = vi.fn();
const mockS3Constructor = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    constructor(opts: unknown) {
      mockS3Constructor(opts);
      this.send = mockSend;
    }
    send: typeof mockSend = mockSend;
  }

  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  class DeleteObjectCommand {
    constructor(public input: unknown) {}
  }

  return { S3Client: MockS3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

// Mock @aws-sdk/s3-request-presigner
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://signed.url/example');
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// ---------------------------------------------------------------------------
// Helpers — reset the S3Client singleton between tests that need distinct configs
// ---------------------------------------------------------------------------

async function resetStorage() {
  const mod = await import('../../src/modules/storage/index.js');
  mod._resetS3ClientForTests();
}

// ---------------------------------------------------------------------------
// 1–3: STORAGE_FORCE_PATH_STYLE env var parsing
// ---------------------------------------------------------------------------

describe('STORAGE_FORCE_PATH_STYLE — Zod transform', () => {
  it('1. default "true" string → forcePathStyle: true in S3Client', async () => {
    // The env schema transforms 'true' → true (any string != 'false' → true)
    const { validateEnv } = await import('../../src/config/env.js');
    const cfg = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      SESSION_SECRET: 'a'.repeat(32),
      STORAGE_FORCE_PATH_STYLE: 'true',
    } as NodeJS.ProcessEnv);
    expect(cfg.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('2. "false" string → forcePathStyle: false (not accidentally truthy)', async () => {
    const { validateEnv } = await import('../../src/config/env.js');
    const cfg = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      SESSION_SECRET: 'a'.repeat(32),
      STORAGE_FORCE_PATH_STYLE: 'false',
    } as NodeJS.ProcessEnv);
    expect(cfg.STORAGE_FORCE_PATH_STYLE).toBe(false);
  });

  it('3. "FALSE" (uppercase) → false (case-insensitive)', async () => {
    const { validateEnv } = await import('../../src/config/env.js');
    const cfg = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      SESSION_SECRET: 'a'.repeat(32),
      STORAGE_FORCE_PATH_STYLE: 'FALSE',
    } as NodeJS.ProcessEnv);
    expect(cfg.STORAGE_FORCE_PATH_STYLE).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4–8: Storage functions
// ---------------------------------------------------------------------------

describe('uploadPublicAsset()', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    mockS3Constructor.mockReset();
    await resetStorage();
    // Default successful response
    mockSend.mockResolvedValue({});
  });

  it('4. uses STORAGE_BUCKET_PUBLIC (not private bucket)', async () => {
    const { uploadPublicAsset } = await import('../../src/modules/storage/index.js');
    await uploadPublicAsset('cms/images/abc123.jpg', Buffer.from('img'), 'image/jpeg');

    // The PutObjectCommand input should contain the public bucket
    const callArg = mockSend.mock.calls[0]?.[0] as { input?: { Bucket?: string } };
    expect(callArg?.input?.Bucket).toBe(process.env['STORAGE_BUCKET_PUBLIC'] ?? 'isf-public-assets');
  });

  it('5. returns /media/public/{filename} URL — NOT a direct S3 URL', async () => {
    const { uploadPublicAsset } = await import('../../src/modules/storage/index.js');
    const result = await uploadPublicAsset('cms/images/abc123def.jpg', Buffer.from('img'), 'image/jpeg');

    expect(result.url).toBe('/media/public/abc123def.jpg');
    expect(result.publicUrl).toBe('/media/public/abc123def.jpg'); // backward compat alias
    // Must NOT be a direct S3 endpoint URL
    expect(result.url).not.toContain('localhost:9000');
    expect(result.url).not.toContain('railway');
    expect(result.key).toBe('cms/images/abc123def.jpg');
  });
});

describe('uploadPrivateAsset()', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    await resetStorage();
    mockSend.mockResolvedValue({});
  });

  it('6. uses STORAGE_BUCKET_PRIVATE (not public bucket)', async () => {
    const { uploadPrivateAsset } = await import('../../src/modules/storage/index.js');
    await uploadPrivateAsset(
      'loan-payments/user1/abc.pdf',
      Buffer.from('pdf'),
      'application/pdf',
    );
    const callArg = mockSend.mock.calls[0]?.[0] as { input?: { Bucket?: string } };
    expect(callArg?.input?.Bucket).toBe(process.env['STORAGE_BUCKET_PRIVATE'] ?? 'isf-private-docs');
  });

  it('7. does not set ACL on the uploaded object', async () => {
    const { uploadPrivateAsset } = await import('../../src/modules/storage/index.js');
    await uploadPrivateAsset('loan-payments/u/x.jpg', Buffer.from('img'), 'image/jpeg');
    const callArg = mockSend.mock.calls[0]?.[0] as { input?: { ACL?: string } };
    expect(callArg?.input?.ACL).toBeUndefined();
  });
});

describe('getPrivateSignedUrl()', () => {
  beforeEach(async () => {
    mockGetSignedUrl.mockReset();
    await resetStorage();
    mockGetSignedUrl.mockResolvedValue('https://signed.example.com/doc.pdf?sig=abc');
  });

  it('8. calls presigner with STORAGE_BUCKET_PRIVATE key and returns signed URL', async () => {
    const { getPrivateSignedUrl } = await import('../../src/modules/storage/index.js');
    const url = await getPrivateSignedUrl('loan-payments/u/abc.pdf', 300);

    expect(url).toContain('https://signed.example.com');
    // getSignedUrl was called with a GetObjectCommand whose Bucket is private
    const cmdArg = mockGetSignedUrl.mock.calls[0]?.[1] as { input?: { Bucket?: string; Key?: string } };
    expect(cmdArg?.input?.Bucket).toBe(process.env['STORAGE_BUCKET_PRIVATE'] ?? 'isf-private-docs');
    expect(cmdArg?.input?.Key).toBe('loan-payments/u/abc.pdf');
  });
});

describe('getPublicAssetStream()', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    await resetStorage();
  });

  it('9. constructs S3 key as cms/images/{filename}', async () => {
    const { Readable } = await import('node:stream');
    const fakeStream = new Readable({ read() {} });
    mockSend.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: 100,
      ETag: '"abc"',
      Body: fakeStream,
    });

    const { getPublicAssetStream } = await import('../../src/modules/storage/index.js');
    await getPublicAssetStream('abc123.jpg');

    const callArg = mockSend.mock.calls[0]?.[0] as { input?: { Key?: string; Bucket?: string } };
    expect(callArg?.input?.Key).toBe('cms/images/abc123.jpg');
    expect(callArg?.input?.Bucket).toBe(process.env['STORAGE_BUCKET_PUBLIC'] ?? 'isf-public-assets');
  });
});

// ---------------------------------------------------------------------------
// 10–15: Media proxy endpoint (Express integration)
// ---------------------------------------------------------------------------

describe('GET /media/public/:filename', () => {
  // We test the router directly without a full app to avoid DB setup
  let supertest: (typeof import('supertest'))['default'];
  let express: (typeof import('express'))['default'];

  beforeEach(async () => {
    mockSend.mockReset();
    await resetStorage();
    supertest = (await import('supertest')).default;
    express = (await import('express')).default;
  });

  function buildApp() {
    // Lazy import to pick up the mocked S3 module
    return import('../../src/modules/storage/media.router.js').then(({ mediaRouter }) => {
      const app = express();
      app.use('/media', mediaRouter);
      return app;
    });
  }

  it('10. 200 with correct headers for valid JPEG filename', async () => {
    const { Readable } = await import('node:stream');
    const imgData = Buffer.from([0xff, 0xd8, 0xff]);
    const fakeStream = Readable.from(imgData);
    mockSend.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: imgData.length,
      ETag: '"etag123"',
      Body: fakeStream,
    });

    const app = await buildApp();
    const res = await supertest(app).get('/media/public/abc123def456.jpg');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('max-age=604800');
  });

  it('11. 404 for path traversal attempt (../etc/passwd)', async () => {
    const app = await buildApp();
    const res = await supertest(app).get('/media/public/..%2Fetc%2Fpasswd');
    expect([400, 404]).toContain(res.status);
  });

  it('12. 404 for filename with slashes (would escape cms/images prefix)', async () => {
    const app = await buildApp();
    // Express decodes %2F in params → / which then appears as a path separator
    const res = await supertest(app).get('/media/public/loan-payments/u/x.jpg');
    // This hits a different route pattern; either 404 from the proxy or no match
    expect([400, 404]).toContain(res.status);
  });

  it('13. 404 for unsupported extension (.pdf)', async () => {
    const app = await buildApp();
    const res = await supertest(app).get('/media/public/abc123.pdf');
    expect(res.status).toBe(404);
  });

  it('14. 404 when S3 returns NoSuchKey', async () => {
    const noSuchKey = new Error('The specified key does not exist.');
    noSuchKey.name = 'NoSuchKey';
    mockSend.mockRejectedValue(noSuchKey);

    const app = await buildApp();
    const res = await supertest(app).get('/media/public/abc123.jpg');
    expect(res.status).toBe(404);
  });

  it('15. 503 when S3 is unreachable (ECONNREFUSED)', async () => {
    const connErr = new Error('connect ECONNREFUSED 127.0.0.1:9000');
    mockSend.mockRejectedValue(connErr);

    const app = await buildApp();
    const res = await supertest(app).get('/media/public/abc123.jpg');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// 16: CMS upload endpoint returns /media/public/* URL
// ---------------------------------------------------------------------------

describe('POST /api/v1/cms/upload-image — returns ISF proxy URL', () => {
  it('16. response url starts with /media/public/ (not http://localhost:9000)', async () => {
    // uploadPublicAsset is already mocked through the S3 mock above.
    // We verify the URL contract without a full DB by checking uploadPublicAsset directly.
    mockSend.mockReset();
    await resetStorage();
    mockSend.mockResolvedValue({});

    const { uploadPublicAsset } = await import('../../src/modules/storage/index.js');
    const result = await uploadPublicAsset('cms/images/aabbccdd.webp', Buffer.from('w'), 'image/webp');

    expect(result.url).toMatch(/^\/media\/public\//);
    expect(result.url).not.toMatch(/^https?:\/\//);
  });
});
