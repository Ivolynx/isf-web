/**
 * CMS API router — JSON API for article CRUD and workflow.
 *
 * All routes require authentication. Permission is checked in the service layer.
 *
 * POST   /api/v1/articles                 — create article (EDITOR, ADMIN, OWNER)
 * GET    /api/v1/articles                 — list articles for dashboard
 * GET    /api/v1/articles/:id             — get article by ID (with revisions)
 * PUT    /api/v1/articles/:id             — edit article
 * POST   /api/v1/articles/:id/submit      — submit for review
 * POST   /api/v1/articles/:id/approve     — approve
 * POST   /api/v1/articles/:id/request-changes — request changes
 * POST   /api/v1/articles/:id/publish     — publish
 * POST   /api/v1/articles/:id/archive     — archive
 * POST   /api/v1/articles/:id/unpublish   — unpublish
 * DELETE /api/v1/articles/:id             — soft-delete (ADMIN, OWNER)
 *
 * GET    /api/v1/categories               — list categories
 * POST   /api/v1/categories               — create category (ADMIN, OWNER)
 * GET    /api/v1/tags                     — list tags
 * POST   /api/v1/tags                     — create tag (ADMIN, OWNER)
 *
 * GET    /blog                            — public blog listing
 * GET    /blog/:slug                      — public article detail
 */

import { Router } from 'express';
import { requirePermission, requireAuth } from '../../middleware/auth.middleware.js';
import { isRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { articleCreateSchema, articleEditSchema, categoryCreateSchema, tagCreateSchema } from './cms.schemas.js';
import * as cmsService from './cms.service.js';
import { BadRequestError, ForbiddenError } from '../../shared/errors.js';
import type { Request, Response, NextFunction } from 'express';

export const cmsApiRouter = Router();

// ---------------------------------------------------------------------------
// Helper: extract validated role from session
// ---------------------------------------------------------------------------

function getActorRole(req: Request): Role {
  const role = req.session.userRole;
  if (!role || !isRole(role)) throw new ForbiddenError('Invalid session role');
  return role;
}

function getActorId(req: Request): string {
  const id = req.session.userId;
  if (!id) throw new ForbiddenError('Authentication required');
  return id;
}

// ---------------------------------------------------------------------------
// POST /api/v1/articles — create
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles',
  requirePermission('article:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // USER role may create articles only via the portal (/portal/content), not the CMS API
      const role = getActorRole(req);
      if (role === 'USER') {
        res.status(403).json({ error: 'USER role must use the member portal to submit content.' });
        return;
      }

      const parsed = articleCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }

      const article = await cmsService.createArticle(
        parsed.data,
        getActorId(req),
        getActorRole(req),
      );

      res.status(201).json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/articles — dashboard list
// ---------------------------------------------------------------------------

cmsApiRouter.get(
  '/articles',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const actorId = getActorId(req);

      // Only CMS roles can see the dashboard list
      if (role === 'USER') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;
      const status = req.query['status'] as string | undefined;

      const result = await cmsService.listArticlesForDashboard(actorId, role, {
        limit,
        offset,
        status: status as never,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/articles/:id — single article
// ---------------------------------------------------------------------------

cmsApiRouter.get(
  '/articles/:id',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const actorId = getActorId(req);

      if (role === 'USER') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      const article = await cmsService.getArticleById(String(req.params['id']));
      if (!article) {
        res.status(404).json({ error: 'Article not found' });
        return;
      }

      // EDITOR can only see their own articles
      if (role === 'EDITOR' && article.authorId !== actorId) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/v1/articles/:id — edit
// ---------------------------------------------------------------------------

cmsApiRouter.put(
  '/articles/:id',
  requirePermission('article:edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // USER role edits via portal, not CMS API
      if (getActorRole(req) === 'USER') {
        res.status(403).json({ error: 'USER role must use the member portal to edit content.' });
        return;
      }

      const parsed = articleEditSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }

      const article = await cmsService.editArticle(
        String(req.params['id']),
        parsed.data,
        getActorId(req),
        getActorRole(req),
      );

      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/submit
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/submit',
  requirePermission('article:submit_review'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // USER role submits via portal, not CMS API
      if (getActorRole(req) === 'USER') {
        res.status(403).json({ error: 'USER role must use the member portal to submit content.' });
        return;
      }

      const article = await cmsService.submitForReview(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/approve
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/approve',
  requirePermission('article:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;
      const article = await cmsService.approveArticle(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
        notes,
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/request-changes
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/request-changes',
  requirePermission('article:review'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
      if (!notes.trim()) {
        res.status(422).json({ error: 'Review notes are required when requesting changes' });
        return;
      }
      const article = await cmsService.requestChanges(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
        notes,
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/publish
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/publish',
  requirePermission('article:publish'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const article = await cmsService.publishArticle(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/archive
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/archive',
  requirePermission('article:archive'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const article = await cmsService.archiveArticle(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/articles/:id/unpublish
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/articles/:id/unpublish',
  requirePermission('article:publish'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const article = await cmsService.unpublishArticle(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
      );
      res.json({ article });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/v1/articles/:id
// ---------------------------------------------------------------------------

cmsApiRouter.delete(
  '/articles/:id',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can delete articles' });
        return;
      }

      await cmsService.deleteArticle(String(req.params['id']), getActorId(req), role);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/categories
// ---------------------------------------------------------------------------

cmsApiRouter.get(
  '/categories',
  requireAuth(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const categories = await cmsService.listCategories();
      res.json({ categories });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/categories
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/categories',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const parsed = categoryCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }
      const category = await cmsService.createCategory(parsed.data, role);
      res.status(201).json({ category });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/tags
// ---------------------------------------------------------------------------

cmsApiRouter.get(
  '/tags',
  requireAuth(),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tags = await cmsService.listTags();
      res.json({ tags });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/tags
// ---------------------------------------------------------------------------

cmsApiRouter.post(
  '/tags',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const parsed = tagCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }
      const tag = await cmsService.createTag(parsed.data, role);
      res.status(201).json({ tag });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Unused import guard
// ---------------------------------------------------------------------------
void BadRequestError;
