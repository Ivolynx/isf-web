/**
 * Portal router — authenticated user dashboard.
 *
 * GET /portal                   — member portal dashboard
 * GET /portal/donations          — user's own donation history
 * GET /portal/content            — user's own content submissions
 * GET /portal/content/new        — new content submission form
 * POST /portal/content           — submit new content (creates article as DRAFT)
 * GET /portal/content/:id        — view single submission
 * GET /portal/content/:id/edit   — edit draft submission
 * POST /portal/content/:id/edit  — save draft edits
 * POST /portal/content/:id/submit — submit for review
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { requirePageAuth } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import { getUserDonations, getCampaignById } from '../fundraising/fundraising.service.js';
import * as cmsService from '../cms/cms.service.js';
import { slugify } from '../cms/cms.schemas.js';
import { v4 as uuidv4 } from 'uuid';

// Rate limiter: max 10 content submissions per user per 15 minutes
const contentSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request, _res: Response) => String(req.session.userId ?? req.ip ?? 'anon'),
  message: { error: 'Terlalu banyak permintaan pengajuan konten. Coba lagi nanti.' },
});

export const portalRouter = Router();

// ---------------------------------------------------------------------------
// Role guard — only USER role may use the member portal.
// OWNER, ADMIN, EDITOR, REVIEWER are redirected to their correct dashboard.
// This middleware runs before every portal route.
// ---------------------------------------------------------------------------

function portalRoleGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.session.userRole;
  if (!role) { next(); return; } // unauthenticated — let requirePageAuth handle it

  switch (role) {
    case 'OWNER':
      res.redirect(302, '/owner');
      return;
    case 'ADMIN':
      res.redirect(302, '/admin');
      return;
    case 'EDITOR':
      res.redirect(302, '/admin/editor');
      return;
    case 'REVIEWER':
      res.redirect(302, '/admin/reviewer');
      return;
    default:
      next(); // USER — allowed
  }
}

portalRouter.use(portalRoleGuard);

// ---------------------------------------------------------------------------
// Helper: load common portal context
// ---------------------------------------------------------------------------

async function loadPortalCtx(req: Request, res: Response) {
  const user = req.session.userId ? await getUserById(req.session.userId) : null;
  return {
    csrfToken: generateCsrfToken(req, res),
    year: new Date().getFullYear(),
    userEmail: req.session.userEmail,
    userRole: req.session.userRole,
    displayName: user?.displayName || req.session.userEmail,
    currentPath: req.originalUrl.split('?')[0],
  };
}

// ---------------------------------------------------------------------------
// GET /portal — member portal dashboard
// ---------------------------------------------------------------------------

portalRouter.get('/', requirePageAuth(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ctx = await loadPortalCtx(req, res);

    // Fetch user's recent donations and content submissions
    let recentDonations: Awaited<ReturnType<typeof getUserDonations>> = [];
    let recentContent: Awaited<ReturnType<typeof cmsService.listArticlesForDashboard>>['articles'] = [];
    try {
      recentDonations = await getUserDonations(req.session.userId!);
    } catch { /* DB not ready */ }
    try {
      const result = await cmsService.listArticlesForDashboard(req.session.userId!, 'USER', { limit: 5, offset: 0 });
      recentContent = result.articles;
    } catch { /* DB not ready */ }

    res.render('portal/index.njk', {
      ...ctx,
      recentDonations: recentDonations.slice(0, 3),
      recentContent: recentContent.slice(0, 3),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portal/donations — user's own donation history
// ---------------------------------------------------------------------------

portalRouter.get(
  '/donations',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const ctx = await loadPortalCtx(req, res);

      let donations: Awaited<ReturnType<typeof getUserDonations>> = [];
      let dbError: string | null = null;
      try {
        donations = await getUserDonations(userId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('relation') && msg.includes('does not exist')) {
          dbError = 'Tabel donasi belum tersedia — jalankan migration terlebih dahulu.';
        } else {
          throw err;
        }
      }

      const enriched = await Promise.all(
        donations.map(async (don) => {
          let campaignTitle = don.campaignId;
          try {
            const campaign = await getCampaignById(don.campaignId);
            if (campaign) campaignTitle = campaign.title;
          } catch { /* silently ignore */ }
          return { ...don, campaignTitle };
        }),
      );

      res.render('portal/donations.njk', {
        ...ctx,
        donations: enriched,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/content — user's content submissions
// ---------------------------------------------------------------------------

portalRouter.get(
  '/content',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const ctx = await loadPortalCtx(req, res);

      let articles: Awaited<ReturnType<typeof cmsService.listArticlesForDashboard>>['articles'] = [];
      let dbError: string | null = null;
      try {
        const result = await cmsService.listArticlesForDashboard(userId, 'USER', { limit: 50, offset: 0 });
        articles = result.articles;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('relation') && msg.includes('does not exist')) {
          dbError = 'Tabel artikel belum tersedia.';
        } else {
          throw err;
        }
      }

      res.render('portal/content.njk', {
        ...ctx,
        articles,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/content/new — new content submission form
// ---------------------------------------------------------------------------

portalRouter.get(
  '/content/new',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await loadPortalCtx(req, res);
      let categories: Awaited<ReturnType<typeof cmsService.listCategories>> = [];
      try { categories = await cmsService.listCategories(); } catch { /* ignore */ }

      res.render('portal/content-form.njk', {
        ...ctx,
        title: 'Ajukan Konten Baru — ISF',
        article: null,
        isNew: true,
        categories,
        contentTypes: [
          { value: 'Berita', label: 'Berita' },
          { value: 'Artikel', label: 'Artikel' },
          { value: 'Cerita Pengalaman', label: 'Cerita Pengalaman' },
          { value: 'Opini', label: 'Opini' },
          { value: 'Kegiatan / Dokumentasi', label: 'Kegiatan / Dokumentasi' },
          { value: 'Cerita Penerima Manfaat', label: 'Cerita Penerima Manfaat' },
        ],
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal/content — create new draft article
// ---------------------------------------------------------------------------

portalRouter.post(
  '/content',
  requirePageAuth(),
  contentSubmitLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const body = req.body as Record<string, string>;

      const title = String(body.title || '').trim();
      const summary = String(body.summary || '').trim();
      const contentType = String(body.contentType || 'Artikel').trim();
      const coverImageUrl = String(body.coverImageUrl || '').trim() || undefined;
      const authorConsent = body.authorConsent === '1' || body.authorConsent === 'on';

      if (!title) {
        res.status(422).json({ error: 'Judul wajib diisi.' });
        return;
      }
      if (!authorConsent) {
        res.status(422).json({ error: 'Persetujuan penulis wajib dicentang.' });
        return;
      }

      // Use contentType as a category-like tag in summary prefix
      const fullSummary = summary ? `[${contentType}] ${summary}` : `[${contentType}]`;

      const article = await cmsService.createArticle(
        {
          title,
          slug: slugify(title) + '-' + uuidv4().slice(0, 8),
          summary: fullSummary,
          bodyTiptap: { type: 'doc' as const, content: [] },
          coverImageUrl,
          categoryIds: [],
          tagIds: [],
        },
        userId,
        'USER',
      );

      res.json({ articleId: article.id, redirectUrl: `/portal/content/${article.id}/edit` });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/content/:id — view single submission
// ---------------------------------------------------------------------------

portalRouter.get(
  '/content/:id',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const articleId = String(req.params['id']);
      const ctx = await loadPortalCtx(req, res);

      const article = await cmsService.getArticleById(articleId);
      if (!article) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      // IDOR: users can only see their own submissions
      if (article.authorId !== userId) {
        res.status(403).render('errors/404.njk', {});
        return;
      }

      res.render('portal/content-detail.njk', {
        ...ctx,
        title: `${article.title} — Pengajuan Konten`,
        article,
        canEdit: article.status === 'DRAFT' || article.status === 'CHANGES_REQUESTED',
        canSubmit: article.status === 'DRAFT' || article.status === 'CHANGES_REQUESTED',
        canView: article.status === 'PUBLISHED',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/content/:id/edit — edit draft submission
// ---------------------------------------------------------------------------

portalRouter.get(
  '/content/:id/edit',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const articleId = String(req.params['id']);
      const ctx = await loadPortalCtx(req, res);

      const article = await cmsService.getArticleById(articleId);
      if (!article) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      // IDOR + status check
      if (article.authorId !== userId) {
        res.status(403).render('errors/404.njk', {});
        return;
      }

      if (article.status !== 'DRAFT' && article.status !== 'CHANGES_REQUESTED') {
        res.redirect(`/portal/content/${articleId}`);
        return;
      }

      let categories: Awaited<ReturnType<typeof cmsService.listCategories>> = [];
      try { categories = await cmsService.listCategories(); } catch { /* ignore */ }

      res.render('portal/content-form.njk', {
        ...ctx,
        title: `Edit: ${article.title} — ISF`,
        article,
        isNew: false,
        categories,
        contentTypes: [
          { value: 'Berita', label: 'Berita' },
          { value: 'Artikel', label: 'Artikel' },
          { value: 'Cerita Pengalaman', label: 'Cerita Pengalaman' },
          { value: 'Opini', label: 'Opini' },
          { value: 'Kegiatan / Dokumentasi', label: 'Kegiatan / Dokumentasi' },
          { value: 'Cerita Penerima Manfaat', label: 'Cerita Penerima Manfaat' },
        ],
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal/content/:id/edit — save draft changes (API)
// ---------------------------------------------------------------------------

portalRouter.post(
  '/content/:id/edit',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const articleId = String(req.params['id']);

      const article = await cmsService.getArticleById(articleId);
      if (!article) { res.status(404).json({ error: 'Artikel tidak ditemukan.' }); return; }
      if (article.authorId !== userId) { res.status(403).json({ error: 'Akses ditolak.' }); return; }
      if (article.status !== 'DRAFT' && article.status !== 'CHANGES_REQUESTED') {
        res.status(422).json({ error: 'Artikel tidak dapat diedit pada status ini.' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const title = String(body.title || '').trim();
      if (!title) { res.status(422).json({ error: 'Judul wajib diisi.' }); return; }

      await cmsService.editArticle(
        articleId,
        {
          title,
          summary: String(body.summary || '').trim(),
          bodyTiptap: (typeof body.bodyTiptap === 'object' && body.bodyTiptap !== null && (body.bodyTiptap as Record<string, unknown>)['type'] === 'doc')
            ? (body.bodyTiptap as { type: 'doc'; content: unknown[] })
            : { type: 'doc' as const, content: [] },
          coverImageUrl: String(body.coverImageUrl || '').trim() || undefined,
          categoryIds: [],
          tagIds: [],
        },
        userId,
        'USER',
      );

      res.json({ ok: true, articleId });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal/content/:id/submit — submit draft for review
// ---------------------------------------------------------------------------

portalRouter.post(
  '/content/:id/submit',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const articleId = String(req.params['id']);

      const article = await cmsService.getArticleById(articleId);
      if (!article) { res.status(404).json({ error: 'Artikel tidak ditemukan.' }); return; }
      if (article.authorId !== userId) { res.status(403).json({ error: 'Akses ditolak.' }); return; }

      await cmsService.submitForReview(articleId, userId, 'USER');

      res.json({ ok: true, status: 'IN_REVIEW', redirectUrl: `/portal/content/${articleId}` });
    } catch (err) {
      next(err);
    }
  },
);
