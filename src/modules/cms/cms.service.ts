/**
 * CMS article service — CRUD and workflow transitions.
 *
 * SECURITY RULES enforced here:
 *   1. Authors can only edit their own DRAFT/CHANGES_REQUESTED articles (unless ADMIN/OWNER).
 *   2. Status transitions are validated server-side — clients cannot jump to PUBLISHED directly.
 *   3. PUBLISHED articles are only accessible on public routes after this service returns them.
 *   4. HTML is always regenerated from Tiptap JSON (never trusted from client).
 *   5. Slugs are auto-generated if not provided; uniqueness is enforced.
 *   6. Article ownership is checked before any mutation (IDOR prevention).
 *
 * Workflow transitions:
 *   DRAFT → IN_REVIEW          (EDITOR, ADMIN, OWNER — submit)
 *   IN_REVIEW → CHANGES_REQUESTED (REVIEWER, ADMIN, OWNER — request_changes)
 *   IN_REVIEW → APPROVED       (REVIEWER, ADMIN, OWNER — approve)
 *   CHANGES_REQUESTED → IN_REVIEW (EDITOR, ADMIN, OWNER — resubmit)
 *   APPROVED → PUBLISHED       (ADMIN, OWNER — publish)
 *   PUBLISHED → ARCHIVED       (ADMIN, OWNER — archive)
 *   PUBLISHED → DRAFT          (ADMIN, OWNER — unpublish)
 *
 * See docs/adr/007-cms.md for the full design.
 */

import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  articlesTable,
  categoriesTable,
  tagsTable,
  articleCategoriesTable,
  articleTagsTable,
  articleRevisionsTable,
  type Article,
  type ArticleStatus,
  type Category,
  type Tag,
  type ArticleRevision,
} from '../../db/schema/index.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../shared/errors.js';
import { hasPermission } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { recordAuditEvent } from '../../shared/audit.js';
import { slugify, type ArticleCreateInput, type ArticleEditInput } from './cms.schemas.js';
import { tiptapToHtml } from './cms.sanitizer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  coverImageUrl: string | null;
  status: ArticleStatus;
  authorId: string;
  authorName: string;
  /** Free-text display name for article attribution on public pages. Falls back to authorName. */
  authorDisplayName: string | null;
  reviewerNotes: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  categories: Pick<Category, 'id' | 'slug' | 'name'>[];
  tags: Pick<Tag, 'id' | 'slug' | 'name'>[];
}

export interface ArticleDetail extends ArticleSummary {
  bodyTiptap: unknown;
  bodyHtml: string;
  reviewerId: string | null;
  reviewerNotes: string | null;
  archivedAt: Date | null;
  revisions?: ArticleRevision[];
}

// ---------------------------------------------------------------------------
// Slug uniqueness
// ---------------------------------------------------------------------------

async function ensureUniqueSlug(baseSlug: string, excludeId?: string): Promise<string> {
  const db = getDb();
  let slug = baseSlug;
  let attempt = 0;

  while (true) {
    const conditions = [
      eq(articlesTable.slug, slug),
      sql`${articlesTable.deletedAt} IS NULL`,
    ];
    if (excludeId) {
      conditions.push(sql`${articlesTable.id} != ${excludeId}`);
    }

    const existing = await db
      .select({ id: articlesTable.id })
      .from(articlesTable)
      .where(and(...conditions))
      .limit(1);

    if (existing.length === 0) break;

    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  return slug;
}

// ---------------------------------------------------------------------------
// Create article
// ---------------------------------------------------------------------------

export async function createArticle(
  input: ArticleCreateInput,
  authorId: string,
  authorRole: Role,
): Promise<Article> {
  if (!hasPermission(authorRole, 'article:create')) {
    throw new ForbiddenError('Insufficient permissions to create articles');
  }

  const db = getDb();

  // Generate slug if not provided
  const baseSlug = input.slug ? slugify(input.slug) : slugify(input.title);
  if (!baseSlug) throw new BadRequestError('Could not generate a valid slug from the title');

  const slug = await ensureUniqueSlug(baseSlug);

  // Render HTML from Tiptap JSON (server-side, never from client)
  const bodyHtml = tiptapToHtml(input.bodyTiptap);

  const [article] = await db
    .insert(articlesTable)
    .values({
      slug,
      title: input.title,
      summary: input.summary,
      authorDisplayName: input.authorDisplayName ?? null,
      bodyTiptap: input.bodyTiptap as Record<string, unknown>,
      bodyHtml,
      coverImageUrl: input.coverImageUrl || null,
      status: 'DRAFT',
      authorId,
    })
    .returning();

  if (!article) throw new Error('Article insert returned no rows');

  // Set categories and tags
  await _syncCategories(article.id, input.categoryIds ?? []);
  await _syncTags(article.id, input.tagIds ?? []);

  // Create initial revision snapshot
  await _createRevision(article, authorId, input.revisionNote ?? 'Initial draft');

  recordAuditEvent({
    actorId: authorId,
    action: 'article.created',
    entityType: 'article',
    entityId: article.id,
    metadata: { slug, title: input.title },
  });

  return article;
}

// ---------------------------------------------------------------------------
// Edit article
// ---------------------------------------------------------------------------

export async function editArticle(
  articleId: string,
  input: ArticleEditInput,
  editorId: string,
  editorRole: Role,
): Promise<Article> {
  if (!hasPermission(editorRole, 'article:edit')) {
    throw new ForbiddenError('Insufficient permissions to edit articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  // Ownership check: non-ADMIN/OWNER can only edit their own articles
  if (editorRole !== 'ADMIN' && editorRole !== 'OWNER') {
    if (article.authorId !== editorId) {
      throw new ForbiddenError('You can only edit your own articles');
    }
    // Can only edit DRAFT or CHANGES_REQUESTED
    if (article.status !== 'DRAFT' && article.status !== 'CHANGES_REQUESTED') {
      throw new ForbiddenError(
        'Article cannot be edited in its current status. Withdraw the review submission first.',
      );
    }
  }

  // Compute new slug
  const rawSlug = input.slug ? slugify(input.slug) : slugify(input.title);
  const slug =
    rawSlug !== article.slug
      ? await ensureUniqueSlug(rawSlug, articleId)
      : article.slug;

  const bodyHtml = tiptapToHtml(input.bodyTiptap);

  const [updated] = await db
    .update(articlesTable)
    .set({
      slug,
      title: input.title,
      summary: input.summary,
      authorDisplayName: input.authorDisplayName ?? null,
      bodyTiptap: input.bodyTiptap as Record<string, unknown>,
      bodyHtml,
      coverImageUrl: input.coverImageUrl || null,
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  await _syncCategories(articleId, input.categoryIds ?? []);
  await _syncTags(articleId, input.tagIds ?? []);

  await _createRevision(updated, editorId, input.revisionNote ?? 'Edited');

  recordAuditEvent({
    actorId: editorId,
    action: 'article.edited',
    entityType: 'article',
    entityId: articleId,
    metadata: { slug, title: input.title },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

/**
 * EDITOR/ADMIN/OWNER: Submit DRAFT → IN_REVIEW (or CHANGES_REQUESTED → IN_REVIEW)
 */
export async function submitForReview(
  articleId: string,
  actorId: string,
  actorRole: Role,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:submit_review')) {
    throw new ForbiddenError('Insufficient permissions to submit articles for review');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  // Ownership check for non-admins
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    if (article.authorId !== actorId) {
      throw new ForbiddenError('You can only submit your own articles for review');
    }
  }

  if (article.status !== 'DRAFT' && article.status !== 'CHANGES_REQUESTED') {
    throw new BadRequestError(
      `Cannot submit article with status '${article.status}' for review`,
    );
  }

  const [updated] = await db
    .update(articlesTable)
    .set({ status: 'IN_REVIEW', updatedAt: new Date() })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.submitted_for_review',
    entityType: 'article',
    entityId: articleId,
    metadata: { previousStatus: article.status },
  });

  return updated;
}

/**
 * REVIEWER/ADMIN/OWNER: Approve IN_REVIEW → APPROVED
 */
export async function approveArticle(
  articleId: string,
  actorId: string,
  actorRole: Role,
  notes?: string,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:approve')) {
    throw new ForbiddenError('Insufficient permissions to approve articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  if (article.status !== 'IN_REVIEW') {
    throw new BadRequestError(`Cannot approve article with status '${article.status}'`);
  }

  // Conflict of interest: authors cannot approve their own articles
  if (article.authorId === actorId) {
    throw new ForbiddenError('Authors cannot approve their own articles');
  }

  const [updated] = await db
    .update(articlesTable)
    .set({
      status: 'APPROVED',
      reviewerId: actorId,
      reviewerNotes: notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.approved',
    entityType: 'article',
    entityId: articleId,
    metadata: { notes: notes ?? null },
  });

  return updated;
}

/**
 * REVIEWER/ADMIN/OWNER: Request changes IN_REVIEW → CHANGES_REQUESTED
 */
export async function requestChanges(
  articleId: string,
  actorId: string,
  actorRole: Role,
  notes: string,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:review')) {
    throw new ForbiddenError('Insufficient permissions to review articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  if (article.status !== 'IN_REVIEW') {
    throw new BadRequestError(
      `Cannot request changes on article with status '${article.status}'`,
    );
  }

  if (!notes || notes.trim().length === 0) {
    throw new BadRequestError('Review notes are required when requesting changes');
  }

  // Conflict of interest check
  if (article.authorId === actorId) {
    throw new ForbiddenError('Authors cannot review their own articles');
  }

  const [updated] = await db
    .update(articlesTable)
    .set({
      status: 'CHANGES_REQUESTED',
      reviewerId: actorId,
      reviewerNotes: notes,
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.changes_requested',
    entityType: 'article',
    entityId: articleId,
    metadata: { notes },
  });

  return updated;
}

/**
 * ADMIN/OWNER: Publish APPROVED → PUBLISHED
 */
export async function publishArticle(
  articleId: string,
  actorId: string,
  actorRole: Role,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:publish')) {
    throw new ForbiddenError('Insufficient permissions to publish articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  if (article.status !== 'APPROVED') {
    throw new BadRequestError(
      `Cannot publish article with status '${article.status}'. Article must be APPROVED first.`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(articlesTable)
    .set({ status: 'PUBLISHED', publishedAt: now, updatedAt: now })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.published',
    entityType: 'article',
    entityId: articleId,
    metadata: { publishedAt: now.toISOString() },
  });

  return updated;
}

/**
 * ADMIN/OWNER: Archive PUBLISHED → ARCHIVED
 */
export async function archiveArticle(
  articleId: string,
  actorId: string,
  actorRole: Role,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:archive')) {
    throw new ForbiddenError('Insufficient permissions to archive articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  if (article.status !== 'PUBLISHED') {
    throw new BadRequestError(
      `Cannot archive article with status '${article.status}'`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(articlesTable)
    .set({ status: 'ARCHIVED', archivedAt: now, updatedAt: now })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.archived',
    entityType: 'article',
    entityId: articleId,
  });

  return updated;
}

/**
 * ADMIN/OWNER: Unpublish PUBLISHED → DRAFT
 */
export async function unpublishArticle(
  articleId: string,
  actorId: string,
  actorRole: Role,
): Promise<Article> {
  if (!hasPermission(actorRole, 'article:publish')) {
    throw new ForbiddenError('Insufficient permissions to unpublish articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  if (article.status !== 'PUBLISHED') {
    throw new BadRequestError(
      `Cannot unpublish article with status '${article.status}'`,
    );
  }

  const [updated] = await db
    .update(articlesTable)
    .set({ status: 'DRAFT', publishedAt: null, updatedAt: new Date() })
    .where(eq(articlesTable.id, articleId))
    .returning();

  if (!updated) throw new Error('Article update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'article.unpublished',
    entityType: 'article',
    entityId: articleId,
  });

  return updated;
}

/**
 * Soft-delete an article (ADMIN/OWNER only).
 */
export async function deleteArticle(
  articleId: string,
  actorId: string,
  actorRole: Role,
): Promise<void> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can delete articles');
  }

  const db = getDb();
  const article = await _getArticleOrThrow(articleId);

  await db
    .update(articlesTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(articlesTable.id, article.id));

  recordAuditEvent({
    actorId,
    action: 'article.deleted',
    entityType: 'article',
    entityId: articleId,
  });
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * List published articles (public blog).
 */
export async function listPublishedArticles(opts: {
  limit?: number;
  offset?: number;
  categorySlug?: string;
  tagSlug?: string;
}): Promise<{ articles: ArticleSummary[]; total: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 10, 50);
  const offset = opts.offset ?? 0;

  // Base query: only PUBLISHED, non-deleted
  const baseWhere = and(
    eq(articlesTable.status, 'PUBLISHED'),
    sql`${articlesTable.deletedAt} IS NULL`,
  );

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(articlesTable)
    .where(baseWhere);

  const total = countResult?.count ?? 0;

  const rows = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      summary: articlesTable.summary,
      authorDisplayName: articlesTable.authorDisplayName,
      coverImageUrl: articlesTable.coverImageUrl,
      status: articlesTable.status,
      authorId: articlesTable.authorId,
      reviewerNotes: articlesTable.reviewerNotes,
      publishedAt: articlesTable.publishedAt,
      createdAt: articlesTable.createdAt,
      updatedAt: articlesTable.updatedAt,
    })
    .from(articlesTable)
    .where(baseWhere)
    .orderBy(desc(articlesTable.publishedAt))
    .limit(limit)
    .offset(offset);

  const articles = await _enrichArticleSummaries(rows);
  return { articles, total };
}

/**
 * Get a single published article by slug (public).
 */
export async function getPublishedArticleBySlug(slug: string): Promise<ArticleDetail | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.slug, slug),
        eq(articlesTable.status, 'PUBLISHED'),
        sql`${articlesTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!row) return null;

  return _toArticleDetail(row);
}

/**
 * Get any article by ID (CMS dashboard — checks auth separately).
 */
export async function getArticleById(articleId: string): Promise<ArticleDetail | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.id, articleId),
        sql`${articlesTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!row) return null;

  const detail = await _toArticleDetail(row);

  // Attach recent revisions
  const revisions = await db
    .select()
    .from(articleRevisionsTable)
    .where(eq(articleRevisionsTable.articleId, articleId))
    .orderBy(desc(articleRevisionsTable.createdAt))
    .limit(20);

  detail.revisions = revisions;
  return detail;
}

/**
 * List articles for CMS dashboard (filtered by actor's access).
 * ADMIN/OWNER: all articles.
 * EDITOR: only their own articles.
 * REVIEWER: all articles in IN_REVIEW + approved state.
 */
export async function listArticlesForDashboard(
  actorId: string,
  actorRole: Role,
  opts: { limit?: number; offset?: number; status?: ArticleStatus },
): Promise<{ articles: ArticleSummary[]; total: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  let whereCondition;
  const baseDeleted = sql`${articlesTable.deletedAt} IS NULL`;

  if (actorRole === 'OWNER' || actorRole === 'ADMIN') {
    whereCondition = opts.status
      ? and(eq(articlesTable.status, opts.status), baseDeleted)
      : baseDeleted;
  } else if (actorRole === 'REVIEWER') {
    const reviewerStatuses = ['IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'CHANGES_REQUESTED'];
    whereCondition = opts.status
      ? and(eq(articlesTable.status, opts.status), baseDeleted)
      : and(inArray(articlesTable.status, reviewerStatuses), baseDeleted);
  } else if (actorRole === 'EDITOR' || actorRole === 'USER') {
    // EDITOR and USER can only see their own articles
    const authorCondition = eq(articlesTable.authorId, actorId);
    whereCondition = opts.status
      ? and(eq(articlesTable.status, opts.status), authorCondition, baseDeleted)
      : and(authorCondition, baseDeleted);
  } else {
    return { articles: [], total: 0 };
  }

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(articlesTable)
    .where(whereCondition);

  const total = countResult?.count ?? 0;

  const rows = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      summary: articlesTable.summary,
      authorDisplayName: articlesTable.authorDisplayName,
      coverImageUrl: articlesTable.coverImageUrl,
      status: articlesTable.status,
      authorId: articlesTable.authorId,
      reviewerNotes: articlesTable.reviewerNotes,
      publishedAt: articlesTable.publishedAt,
      createdAt: articlesTable.createdAt,
      updatedAt: articlesTable.updatedAt,
    })
    .from(articlesTable)
    .where(whereCondition)
    .orderBy(desc(articlesTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const articles = await _enrichArticleSummaries(rows);
  return { articles, total };
}

// ---------------------------------------------------------------------------
// Category and tag management
// ---------------------------------------------------------------------------

export async function listCategories(): Promise<Category[]> {
  const db = getDb();
  return db.select().from(categoriesTable).orderBy(categoriesTable.name);
}

export async function listTags(): Promise<Tag[]> {
  const db = getDb();
  return db.select().from(tagsTable).orderBy(tagsTable.name);
}

export async function createCategory(
  input: { name: string; slug?: string | undefined; description?: string | undefined },
  actorRole: Role,
): Promise<Category> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can create categories');
  }

  const db = getDb();
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);

  const existing = await db
    .select({ id: categoriesTable.id })
    .from(categoriesTable)
    .where(eq(categoriesTable.slug, slug))
    .limit(1);

  if (existing.length > 0) throw new ConflictError(`Category slug '${slug}' already exists`);

  const [cat] = await db
    .insert(categoriesTable)
    .values({ name: input.name, slug, description: input.description })
    .returning();

  if (!cat) throw new Error('Category insert returned no rows');
  return cat;
}

export async function createTag(
  input: { name: string; slug?: string | undefined },
  actorRole: Role,
): Promise<Tag> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can create tags');
  }

  const db = getDb();
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);

  const existing = await db
    .select({ id: tagsTable.id })
    .from(tagsTable)
    .where(eq(tagsTable.slug, slug))
    .limit(1);

  if (existing.length > 0) throw new ConflictError(`Tag slug '${slug}' already exists`);

  const [tag] = await db
    .insert(tagsTable)
    .values({ name: input.name, slug })
    .returning();

  if (!tag) throw new Error('Tag insert returned no rows');
  return tag;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _getArticleOrThrow(articleId: string): Promise<Article> {
  const db = getDb();
  const [article] = await db
    .select()
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.id, articleId),
        sql`${articlesTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!article) throw new NotFoundError('Article not found');
  return article;
}

async function _syncCategories(articleId: string, categoryIds: string[]): Promise<void> {
  const db = getDb();
  // Delete all existing, then insert new ones
  await db
    .delete(articleCategoriesTable)
    .where(eq(articleCategoriesTable.articleId, articleId));

  if (categoryIds.length > 0) {
    await db
      .insert(articleCategoriesTable)
      .values(categoryIds.map((cid) => ({ articleId, categoryId: cid })));
  }
}

async function _syncTags(articleId: string, tagIds: string[]): Promise<void> {
  const db = getDb();
  await db
    .delete(articleTagsTable)
    .where(eq(articleTagsTable.articleId, articleId));

  if (tagIds.length > 0) {
    await db
      .insert(articleTagsTable)
      .values(tagIds.map((tid) => ({ articleId, tagId: tid })));
  }
}

async function _createRevision(
  article: Article,
  revisedBy: string,
  revisionNote?: string,
): Promise<void> {
  const db = getDb();
  await db.insert(articleRevisionsTable).values({
    articleId: article.id,
    snapshot: {
      title: article.title,
      slug: article.slug,
      summary: article.summary,
      bodyTiptap: article.bodyTiptap,
      bodyHtml: article.bodyHtml,
      status: article.status,
    } as unknown as Record<string, unknown>,
    revisedBy,
    revisionNote: revisionNote ?? null,
  });
}

async function _getArticleCategoriesAndTags(
  articleId: string,
): Promise<{ categories: Pick<Category, 'id' | 'slug' | 'name'>[]; tags: Pick<Tag, 'id' | 'slug' | 'name'>[] }> {
  const db = getDb();

  const catRows = await db
    .select({
      id: categoriesTable.id,
      slug: categoriesTable.slug,
      name: categoriesTable.name,
    })
    .from(articleCategoriesTable)
    .innerJoin(
      categoriesTable,
      eq(articleCategoriesTable.categoryId, categoriesTable.id),
    )
    .where(eq(articleCategoriesTable.articleId, articleId));

  const tagRows = await db
    .select({
      id: tagsTable.id,
      slug: tagsTable.slug,
      name: tagsTable.name,
    })
    .from(articleTagsTable)
    .innerJoin(tagsTable, eq(articleTagsTable.tagId, tagsTable.id))
    .where(eq(articleTagsTable.articleId, articleId));

  return { categories: catRows, tags: tagRows };
}

type ArticleRow = Pick<
  Article,
  'id' | 'slug' | 'title' | 'summary' | 'authorDisplayName' | 'coverImageUrl' | 'status' | 'authorId' | 'reviewerNotes' | 'publishedAt' | 'createdAt' | 'updatedAt'
>;

async function _enrichArticleSummaries(rows: ArticleRow[]): Promise<ArticleSummary[]> {
  if (rows.length === 0) return [];

  const results: ArticleSummary[] = [];

  for (const row of rows) {
    const { categories, tags } = await _getArticleCategoriesAndTags(row.id);
    results.push({
      ...row,
      status: row.status as ArticleStatus,
      authorName: '', // Populated by router if needed
      authorDisplayName: row.authorDisplayName ?? null,
      reviewerNotes: row.reviewerNotes,
      categories,
      tags,
    });
  }

  return results;
}

async function _toArticleDetail(row: Article): Promise<ArticleDetail> {
  const { categories, tags } = await _getArticleCategoriesAndTags(row.id);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    authorDisplayName: row.authorDisplayName ?? null,
    bodyTiptap: row.bodyTiptap,
    bodyHtml: row.bodyHtml,
    coverImageUrl: row.coverImageUrl,
    status: row.status as ArticleStatus,
    authorId: row.authorId,
    authorName: '',
    reviewerId: row.reviewerId,
    reviewerNotes: row.reviewerNotes,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    categories,
    tags,
  };
}
