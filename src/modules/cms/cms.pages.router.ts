/**
 * CMS pages router — server-rendered dashboard pages for editors/reviewers/admins.
 *
 * GET /admin/cms                          — CMS dashboard (ADMIN, EDITOR, REVIEWER, OWNER)
 * GET /admin/cms/articles/new             — new article form (EDITOR, ADMIN, OWNER)
 * GET /admin/cms/articles/:id/edit        — edit article form (EDITOR, ADMIN, OWNER)
 * GET /admin/cms/articles/:id/preview     — article preview
 * GET /admin/cms/articles/:id             — article detail/review
 * GET /admin/cms/review                   — review queue (REVIEWER, ADMIN, OWNER)
 * GET /admin/cms/categories               — categories list (ADMIN, OWNER)
 * GET /admin/cms/tags                     — tags list (ADMIN, OWNER)
 *
 * All page routes verify auth server-side via requirePageRole/requirePagePermission.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requirePageRole, requirePagePermission } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import * as cmsService from './cms.service.js';
import type { Role } from '../../shared/rbac.js';
import { isRole } from '../../shared/rbac.js';

export const cmsPagesRouter = Router();

// ---------------------------------------------------------------------------
// Helper: load current user context
// ---------------------------------------------------------------------------

async function loadCurrentUser(req: Request, res: Response) {
  const user = req.session.userId ? await getUserById(req.session.userId) : null;
  const { getWordPressConfig } = await import('../home/wordpress.service.js');
  const wpConfig = getWordPressConfig();
  return {
    csrfToken: generateCsrfToken(req, res),
    year: new Date().getFullYear(),
    userEmail: req.session.userEmail,
    userRole: req.session.userRole,
    displayName: user?.displayName || req.session.userEmail,
    currentPath: req.originalUrl.split('?')[0],
    wpAdminUrl: wpConfig.adminUrl,
  };
}

// ---------------------------------------------------------------------------
// GET /admin/cms — CMS dashboard
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;

      const { articles } = await cmsService.listArticlesForDashboard(actorId, role, {
        limit: 10,
        offset: 0,
      });

      const ctx = await loadCurrentUser(req, res);

      res.render('cms/dashboard.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: 'CMS Dashboard — ISF',
        articles,
        isEditor: role === 'EDITOR' || role === 'ADMIN' || role === 'OWNER',
        isReviewer: role === 'REVIEWER' || role === 'ADMIN' || role === 'OWNER',
        isAdmin: role === 'ADMIN' || role === 'OWNER',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/review — reviewer queue
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/review',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;

      const { articles } = await cmsService.listArticlesForDashboard(actorId, role, {
        limit: 50,
        offset: 0,
        status: 'IN_REVIEW',
      });

      const ctx = await loadCurrentUser(req, res);

      res.render('cms/review-queue.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: 'Review Queue — ISF',
        articles,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/articles/new — new article form
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/articles/new',
  requirePagePermission('article:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const categories = await cmsService.listCategories();
      const tags = await cmsService.listTags();
      const ctx = await loadCurrentUser(req, res);

      res.render('cms/article-edit.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: 'New Article — ISF',
        article: null,
        categories,
        tags,
        mode: 'create',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/articles/:id/edit — edit article form
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/articles/:id/edit',
  requirePagePermission('article:edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole;
      const actorId = req.session.userId!;
      const article = await cmsService.getArticleById(String(req.params['id']));

      if (!article) {
        res.status(404).render('errors/404.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      // Ownership check: EDITOR can only edit their own articles
      if (isRole(role) && role === 'EDITOR' && article.authorId !== actorId) {
        res.status(403).render('errors/403.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      const categories = await cmsService.listCategories();
      const tags = await cmsService.listTags();
      const ctx = await loadCurrentUser(req, res);

      res.render('cms/article-edit.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: `Edit: ${article.title} — ISF`,
        article,
        categories,
        tags,
        mode: 'edit',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/articles/:id — article detail
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/articles/:id',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole;
      const actorId = req.session.userId!;
      const article = await cmsService.getArticleById(String(req.params['id']));

      if (!article) {
        res.status(404).render('errors/404.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      // Ownership check for EDITORs
      if (isRole(role) && role === 'EDITOR' && article.authorId !== actorId) {
        res.status(403).render('errors/403.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      const ctx = await loadCurrentUser(req, res);
      const actorRole = isRole(role) ? role : 'USER';

      res.render('cms/article-detail.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: `${article.title} — ISF`,
        article,
        canEdit:
          (actorRole === 'EDITOR' && article.authorId === actorId) ||
          actorRole === 'ADMIN' ||
          actorRole === 'OWNER',
        canReview: actorRole === 'REVIEWER' || actorRole === 'ADMIN' || actorRole === 'OWNER',
        canPublish: actorRole === 'ADMIN' || actorRole === 'OWNER',
        isOwnArticle: article.authorId === actorId,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/articles/:id/preview — article preview
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/articles/:id/preview',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const article = await cmsService.getArticleById(String(req.params['id']));

      if (!article) {
        res.status(404).render('errors/404.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      const role = req.session.userRole;
      const actorId = req.session.userId!;

      // EDITOR can only preview their own articles
      if (isRole(role) && role === 'EDITOR' && article.authorId !== actorId) {
        res.status(403).render('errors/403.njk', {
          requestId: res.locals['requestId'],
        });
        return;
      }

      const ctx = await loadCurrentUser(req, res);

      res.render('cms/article-preview.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: `Preview: ${article.title} — ISF`,
        article,
        isPreview: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/categories
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/categories',
  requirePageRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const categories = await cmsService.listCategories();
      const ctx = await loadCurrentUser(req, res);

      res.render('cms/categories.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: 'Categories — ISF',
        categories,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/cms/tags
// ---------------------------------------------------------------------------

cmsPagesRouter.get(
  '/tags',
  requirePageRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tags = await cmsService.listTags();
      const ctx = await loadCurrentUser(req, res);

      res.render('cms/tags.njk', {
        ...ctx,
        csrfToken: generateCsrfToken(req, res),
        title: 'Tags — ISF',
        tags,
      });
    } catch (err) {
      next(err);
    }
  },
);
