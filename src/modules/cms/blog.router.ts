/**
 * Blog router — public-facing blog pages.
 *
 * GET /blog           — public blog listing (PUBLISHED articles only)
 * GET /blog/:slug     — public article detail (PUBLISHED only)
 *
 * No authentication required. Only PUBLISHED, non-deleted articles are shown.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../shared/logger.js';
import * as cmsService from './cms.service.js';

export const blogRouter = Router();

// ---------------------------------------------------------------------------
// GET /blog
// ---------------------------------------------------------------------------

blogRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(parseInt(String(req.query['page'] ?? '1'), 10) || 1, 1);
    const limit = 10;
    const offset = (page - 1) * limit;

    const result = await cmsService.listPublishedArticles({ limit, offset });
    const { articles, total } = result;
    const totalPages = Math.ceil(total / limit) || 1;

    res.render('blog/index.njk', {
      title: 'Blog — ISF',
      metaDescription: 'Baca artikel terbaru dari Intelligentsia Scholarship Fund',
      articles,
      page,
      totalPages,
      total,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      prevPage: page - 1,
      nextPage: page + 1,
      year: new Date().getFullYear(),
    });
  } catch (err) {
    logger.error({ err, url: req.url }, 'Failed to load blog listing');
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /blog/:slug
// ---------------------------------------------------------------------------

blogRouter.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const article = await cmsService.getPublishedArticleBySlug(String(req.params['slug']));

    if (!article) {
      if (req.accepts('html')) {
        const requestId = res.locals['requestId'] as string | undefined;
        res.status(404).render('errors/404.njk', { requestId });
      } else {
        res.status(404).json({ error: 'Article not found' });
      }
      return;
    }

    res.render('blog/article.njk', {
      title: `${article.title} — ISF`,
      metaDescription: article.summary || article.title,
      article,
      year: new Date().getFullYear(),
    });
  } catch (err) {
    logger.error({ err, url: req.url }, 'Failed to load blog article');
    next(err);
  }
});
