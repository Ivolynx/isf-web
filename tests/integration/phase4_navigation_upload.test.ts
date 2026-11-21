/**
 * Phase 4 integration tests — Navigation consistency, image upload, article workflow visibility.
 *
 * Test coverage:
 *   Navigation & RBAC:
 *   1.  GET /owner      → 302 for unauthenticated
 *   2.  GET /owner      → 403 for non-OWNER (ADMIN)
 *   3.  GET /owner      → 200 for OWNER
 *   4.  GET /admin      → 200 for OWNER (OWNER can access admin)
 *   5.  GET /portal     → 200 for any authenticated user
 *   6.  GET /admin/cms  → 200 for OWNER
 *
 *   Article visibility on public pages:
 *   7.  GET /        → does NOT contain a DRAFT article title
 *   8.  GET /blog    → does NOT contain a DRAFT article title
 *   9.  GET /blog/:slug (PUBLISHED) → 200 with article title
 *   10. GET /blog/:slug (DRAFT)     → 404
 *
 *   Article workflow transitions (via API):
 *   11. DRAFT → submit → IN_REVIEW
 *   12. IN_REVIEW → approve → APPROVED (reviewer != author)
 *   13. APPROVED → publish → PUBLISHED (ADMIN)
 *
 *   Image upload endpoint:
 *   14. POST /api/v1/cms/upload-image → 401 without auth
 *   15. POST /api/v1/cms/upload-image → 403 for USER role
 *   16. POST /api/v1/cms/upload-image → 422 for unsupported file type (PDF)
 *   17. POST /api/v1/cms/upload-image → 422 for file too large (> 3 MB)
 *   18. POST /api/v1/cms/upload-image → 422 for missing file field
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app/index.js';
import { getDb, closeDatabase } from '../../src/db/client.js';
import {
  usersTable,
  articlesTable,
  articleRevisionsTable,
  articleCategoriesTable,
  articleTagsTable,
} from '../../src/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../../src/shared/password.js';
import { isDatabaseAvailable } from '../setup.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: Express;
let dbAvailable = false;
let cmsTablesExist = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  app = createApp();

  if (dbAvailable) {
    try {
      const db = getDb();
      await db.select({ id: articlesTable.id }).from(articlesTable).limit(1);
      cmsTablesExist = true;
    } catch {
      cmsTablesExist = false;
    }
  }
}, 15_000);

afterAll(async () => {
  await closeDatabase();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_PASSWORD = 'NavTest1!';
const VALID_TIPTAP_DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test content.' }] }],
};

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanupUser(email: string): Promise<void> {
  if (!dbAvailable) return;
  try {
    const db = getDb();
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()))
      .limit(1);
    if (!user) return;
    const articles = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(eq(articlesTable.authorId, user.id));
    for (const article of articles) {
      await db.delete(articleRevisionsTable).where(eq(articleRevisionsTable.articleId, article.id));
      await db.delete(articleCategoriesTable).where(eq(articleCategoriesTable.articleId, article.id));
      await db.delete(articleTagsTable).where(eq(articleTagsTable.articleId, article.id));
    }
    await db.delete(articlesTable).where(eq(articlesTable.authorId, user.id));
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
  } catch { /* ignore */ }
}

async function cleanupArticleBySlug(slug: string): Promise<void> {
  if (!dbAvailable) return;
  try {
    const db = getDb();
    const [article] = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(eq(articlesTable.slug, slug))
      .limit(1);
    if (article) {
      await db.delete(articleRevisionsTable).where(eq(articleRevisionsTable.articleId, article.id));
      await db.delete(articleCategoriesTable).where(eq(articleCategoriesTable.articleId, article.id));
      await db.delete(articleTagsTable).where(eq(articleTagsTable.articleId, article.id));
      await db.delete(articlesTable).where(eq(articlesTable.id, article.id));
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Session helpers (mirrors pattern from phase2_cms.test.ts)
// ---------------------------------------------------------------------------

interface CsrfPair { token: string; cookie: string; }

async function getCsrf(): Promise<CsrfPair> {
  const res = await request(app).get('/auth/csrf-token');
  const token = (res.body as { csrfToken?: string }).csrfToken ?? '';
  const cookie = res.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  return { token, cookie };
}

async function loginAs(email: string, password: string, csrf: CsrfPair): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .set('Cookie', csrf.cookie)
    .set('X-CSRF-Token', csrf.token)
    .send({ email, password });
  const header = res.headers['set-cookie'];
  const sessionCookie = Array.isArray(header)
    ? header.find((c: string) => c.startsWith('isf.sid'))?.split(';')[0] ?? ''
    : (header as unknown as string)?.split(';')[0] ?? '';
  return sessionCookie;
}

async function createTestUser(
  email: string,
  role: 'EDITOR' | 'REVIEWER' | 'ADMIN' | 'OWNER' | 'USER',
  password: string,
): Promise<string> {
  const db = getDb();
  const hash = await hashPassword(password);
  const [user] = await db.insert(usersTable).values({
    email: email.toLowerCase(),
    passwordHash: hash,
    role,
    emailVerifiedAt: new Date(),
    displayName: `Test ${role}`,
  }).returning({ id: usersTable.id });
  return user!.id;
}

// ---------------------------------------------------------------------------
// Navigation & RBAC
// ---------------------------------------------------------------------------

describe('Navigation — RBAC route protection', () => {
  const ownerEmail = 'nav-owner@test.isf';
  const adminEmail = 'nav-admin@test.isf';
  const userEmail = 'nav-user@test.isf';

  beforeAll(async () => {
    if (!dbAvailable) return;
    await cleanupUser(ownerEmail);
    await cleanupUser(adminEmail);
    await cleanupUser(userEmail);
    await createTestUser(ownerEmail, 'OWNER', TEST_PASSWORD);
    await createTestUser(adminEmail, 'ADMIN', TEST_PASSWORD);
    await createTestUser(userEmail, 'USER', TEST_PASSWORD);
  });

  afterAll(async () => {
    await cleanupUser(ownerEmail);
    await cleanupUser(adminEmail);
    await cleanupUser(userEmail);
  });

  it('1. GET /owner → 302 redirect for unauthenticated', async () => {
    const res = await request(app).get('/owner');
    expect(res.status).toBe(302);
  });

  it('2. GET /owner → 403 for ADMIN role (OWNER only)', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(adminEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .get('/owner')
      .set('Cookie', `${csrf.cookie}; ${session}`);
    // ADMIN should not have access to owner routes
    expect([403, 302]).toContain(res.status);
  });

  it('3. GET /owner → 200 for OWNER role', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(ownerEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .get('/owner')
      .set('Cookie', `${csrf.cookie}; ${session}`);
    expect(res.status).toBe(200);
  });

  it('4. GET /admin → 200 for OWNER (OWNER has all permissions)', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(ownerEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .get('/admin')
      .set('Cookie', `${csrf.cookie}; ${session}`);
    expect(res.status).toBe(200);
  });

  it('5. GET /portal → 200 for any authenticated user', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(userEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .get('/portal')
      .set('Cookie', `${csrf.cookie}; ${session}`);
    expect(res.status).toBe(200);
  });

  it('6. GET /admin/cms → 200 for OWNER', async () => {
    if (!dbAvailable || !cmsTablesExist) return;
    const csrf = await getCsrf();
    const session = await loginAs(ownerEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .get('/admin/cms')
      .set('Cookie', `${csrf.cookie}; ${session}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Article visibility on public pages
// ---------------------------------------------------------------------------

describe('Article visibility — only PUBLISHED shown publicly', () => {
  const editorEmail = 'vis-editor@test.isf';
  const reviewerEmail = 'vis-reviewer@test.isf';
  const adminEmail = 'vis-admin@test.isf';
  const DRAFT_TITLE = 'ISF Nav Test Draft Article 99a';
  const PUB_TITLE = 'ISF Nav Test Published Article 99b';
  const DRAFT_SLUG = 'isf-nav-test-draft-article-99a';
  const PUB_SLUG = 'isf-nav-test-published-article-99b';

  beforeAll(async () => {
    if (!dbAvailable || !cmsTablesExist) return;
    await cleanupUser(editorEmail);
    await cleanupUser(reviewerEmail);
    await cleanupUser(adminEmail);
    await cleanupArticleBySlug(DRAFT_SLUG);
    await cleanupArticleBySlug(PUB_SLUG);
    await createTestUser(editorEmail, 'EDITOR', TEST_PASSWORD);
    await createTestUser(reviewerEmail, 'REVIEWER', TEST_PASSWORD);
    await createTestUser(adminEmail, 'ADMIN', TEST_PASSWORD);
  });

  afterAll(async () => {
    await cleanupArticleBySlug(DRAFT_SLUG);
    await cleanupArticleBySlug(PUB_SLUG);
    await cleanupUser(editorEmail);
    await cleanupUser(reviewerEmail);
    await cleanupUser(adminEmail);
  });

  it('7. GET / → DRAFT article title does NOT appear on homepage', async () => {
    if (!dbAvailable || !cmsTablesExist) return;
    const csrf = await getCsrf();
    const session = await loginAs(editorEmail, TEST_PASSWORD, csrf);

    // Create a DRAFT article
    const createRes = await request(app)
      .post('/api/v1/articles')
      .set('Cookie', `${csrf.cookie}; ${session}`)
      .set('X-CSRF-Token', csrf.token)
      .send({ title: DRAFT_TITLE, bodyTiptap: VALID_TIPTAP_DOC, slug: DRAFT_SLUG });
    expect(createRes.status).toBe(201);

    const homeRes = await request(app).get('/');
    expect(homeRes.text).not.toContain(DRAFT_TITLE);
  });

  it('8. GET /blog → DRAFT article does NOT appear in blog listing', async () => {
    if (!dbAvailable || !cmsTablesExist) return;
    const blogRes = await request(app).get('/blog');
    expect(blogRes.status).toBe(200);
    expect(blogRes.text).not.toContain(DRAFT_TITLE);
  });

  it('9. GET /blog/:slug → 404 for DRAFT article', async () => {
    if (!dbAvailable || !cmsTablesExist) return;
    const res = await request(app).get(`/blog/${DRAFT_SLUG}`);
    expect(res.status).toBe(404);
  });

  it('10–13. Full workflow: DRAFT → IN_REVIEW → APPROVED → PUBLISHED; article appears on /blog', async () => {
    if (!dbAvailable || !cmsTablesExist) return;

    const editorCsrf = await getCsrf();
    const editorSession = await loginAs(editorEmail, TEST_PASSWORD, editorCsrf);
    const reviewerCsrf = await getCsrf();
    const reviewerSession = await loginAs(reviewerEmail, TEST_PASSWORD, reviewerCsrf);
    const adminCsrf = await getCsrf();
    const adminSession = await loginAs(adminEmail, TEST_PASSWORD, adminCsrf);

    // Create article
    const createRes = await request(app)
      .post('/api/v1/articles')
      .set('Cookie', `${editorCsrf.cookie}; ${editorSession}`)
      .set('X-CSRF-Token', editorCsrf.token)
      .send({ title: PUB_TITLE, bodyTiptap: VALID_TIPTAP_DOC, slug: PUB_SLUG });
    expect(createRes.status).toBe(201);
    const articleId = (createRes.body as { article: { id: string } }).article.id;

    // Submit for review
    const submitRes = await request(app)
      .post(`/api/v1/articles/${articleId}/submit`)
      .set('Cookie', `${editorCsrf.cookie}; ${editorSession}`)
      .set('X-CSRF-Token', editorCsrf.token)
      .send({});
    expect(submitRes.status).toBe(200);
    expect((submitRes.body as { article: { status: string } }).article.status).toBe('IN_REVIEW');

    // Approve (reviewer != author)
    const approveRes = await request(app)
      .post(`/api/v1/articles/${articleId}/approve`)
      .set('Cookie', `${reviewerCsrf.cookie}; ${reviewerSession}`)
      .set('X-CSRF-Token', reviewerCsrf.token)
      .send({});
    expect(approveRes.status).toBe(200);
    expect((approveRes.body as { article: { status: string } }).article.status).toBe('APPROVED');

    // Publish (ADMIN)
    const publishRes = await request(app)
      .post(`/api/v1/articles/${articleId}/publish`)
      .set('Cookie', `${adminCsrf.cookie}; ${adminSession}`)
      .set('X-CSRF-Token', adminCsrf.token)
      .send({});
    expect(publishRes.status).toBe(200);
    expect((publishRes.body as { article: { status: string } }).article.status).toBe('PUBLISHED');

    // Article now appears on /blog
    const blogRes = await request(app).get('/blog');
    expect(blogRes.status).toBe(200);
    expect(blogRes.text).toContain(PUB_TITLE);

    // Article detail accessible via slug
    const slugRes = await request(app).get(`/blog/${PUB_SLUG}`);
    expect(slugRes.status).toBe(200);
    expect(slugRes.text).toContain(PUB_TITLE);
  });
});

// ---------------------------------------------------------------------------
// Image upload endpoint
// ---------------------------------------------------------------------------

describe('POST /api/v1/cms/upload-image — authentication & validation', () => {
  const editorEmail = 'upload-editor@test.isf';
  const userEmail = 'upload-user@test.isf';

  beforeAll(async () => {
    if (!dbAvailable) return;
    await cleanupUser(editorEmail);
    await cleanupUser(userEmail);
    await createTestUser(editorEmail, 'EDITOR', TEST_PASSWORD);
    await createTestUser(userEmail, 'USER', TEST_PASSWORD);
  });

  afterAll(async () => {
    await cleanupUser(editorEmail);
    await cleanupUser(userEmail);
  });

  it('14. POST /api/v1/cms/upload-image → 401 without authentication', async () => {
    const csrf = await getCsrf();
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const res = await request(app)
      .post('/api/v1/cms/upload-image')
      .set('Cookie', csrf.cookie)
      .set('x-csrf-token', csrf.token)
      .attach('image', fakeJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect([401, 302]).toContain(res.status);
  });

  it('15. POST /api/v1/cms/upload-image → 403 for USER role', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(userEmail, TEST_PASSWORD, csrf);
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const res = await request(app)
      .post('/api/v1/cms/upload-image')
      .set('Cookie', `${csrf.cookie}; ${session}`)
      .set('x-csrf-token', csrf.token)
      .attach('image', fakeJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' });
    expect([403, 401]).toContain(res.status);
  });

  it('16. POST /api/v1/cms/upload-image → 422 for unsupported type (PDF magic bytes)', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(editorEmail, TEST_PASSWORD, csrf);
    // PDF magic bytes: %PDF
    const fakePdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]);
    const res = await request(app)
      .post('/api/v1/cms/upload-image')
      .set('Cookie', `${csrf.cookie}; ${session}`)
      .set('x-csrf-token', csrf.token)
      .attach('image', fakePdf, { filename: 'test.pdf', contentType: 'application/pdf' });
    // Multer's fileFilter or magic byte check should reject
    expect([400, 422]).toContain(res.status);
  });

  it('17. POST /api/v1/cms/upload-image → 400 for file exceeding 3 MB', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(editorEmail, TEST_PASSWORD, csrf);
    // Create a buffer with JPEG header but 4 MB total
    const bigBuffer = Buffer.alloc(4 * 1024 * 1024, 0x00);
    bigBuffer[0] = 0xff; bigBuffer[1] = 0xd8; bigBuffer[2] = 0xff;
    const res = await request(app)
      .post('/api/v1/cms/upload-image')
      .set('Cookie', `${csrf.cookie}; ${session}`)
      .set('x-csrf-token', csrf.token)
      .attach('image', bigBuffer, { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect([400, 413, 422]).toContain(res.status);
  });

  it('18. POST /api/v1/cms/upload-image → 422 for missing file field', async () => {
    if (!dbAvailable) return;
    const csrf = await getCsrf();
    const session = await loginAs(editorEmail, TEST_PASSWORD, csrf);
    const res = await request(app)
      .post('/api/v1/cms/upload-image')
      .set('Cookie', `${csrf.cookie}; ${session}`)
      .set('x-csrf-token', csrf.token)
      .set('Content-Type', 'multipart/form-data');
    expect([400, 422]).toContain(res.status);
  });
});
