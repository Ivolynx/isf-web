/**
 * Home router — public homepage with dynamic blog, fundraising, and WordPress data.
 *
 * GET / — main landing page
 *
 * Content priority:
 *   1. WordPress page content (when WORDPRESS_BASE_URL is configured and page exists)
 *   2. Static built-in content (fallback when WordPress is not available)
 *
 * The page always renders — WordPress unavailability is handled gracefully.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../shared/logger.js';
import * as cmsService from '../cms/cms.service.js';
import * as fundraisingService from '../fundraising/fundraising.service.js';
import { fetchWordPressHomePage, getWordPressConfig } from './wordpress.service.js';

export const homeRouter = Router();

homeRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Fetch all data sources in parallel — each failure is handled independently
    const [articlesResult, campaignsResult, wpPageResult] = await Promise.allSettled([
      cmsService.listPublishedArticles({ limit: 4 }),
      fundraisingService.listPublicCampaigns({ limit: 3 }),
      fetchWordPressHomePage(),
    ]);

    let articles: Awaited<ReturnType<typeof cmsService.listPublishedArticles>>['articles'] = [];
    let campaigns: Awaited<ReturnType<typeof fundraisingService.listPublicCampaigns>>['campaigns'] = [];
    let wpPage: Awaited<ReturnType<typeof fetchWordPressHomePage>> = null;

    if (articlesResult.status === 'fulfilled') {
      articles = articlesResult.value.articles;
    } else {
      logger.error(
        { err: articlesResult.reason, url: req.url },
        'Failed to load published articles for homepage',
      );
    }

    if (campaignsResult.status === 'fulfilled') {
      campaigns = campaignsResult.value.campaigns;
    } else {
      logger.error(
        { err: campaignsResult.reason, url: req.url },
        'Failed to load public campaigns for homepage',
      );
    }

    if (wpPageResult.status === 'fulfilled') {
      wpPage = wpPageResult.value;
    } else {
      // This should not happen (service catches errors internally), but log just in case
      logger.warn({ err: wpPageResult.reason }, 'WordPress fetch unexpectedly threw');
    }

    const wpConfig = getWordPressConfig();

    res.render('home/index.njk', {
      title: 'Intelligentsia Scholarship Fund — Beasiswa untuk Mahasiswa Berprestasi',
      metaDescription:
        'ISF menanggung biaya kuliah, tunjangan bulanan, dan pendampingan mentor bagi mahasiswa berprestasi di seluruh Indonesia.',
      articles,
      campaigns,
      year: new Date().getFullYear(),
      // WordPress content — null when not configured or unavailable
      wpPage,
      wpEnabled: wpConfig.isEnabled,
    });
  } catch (err) {
    logger.error({ err, url: req.url }, 'Unhandled error in home router');
    next(err);
  }
});
