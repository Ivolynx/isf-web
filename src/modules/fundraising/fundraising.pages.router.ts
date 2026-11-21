/**
 * Fundraising pages router — server-rendered campaign and donation pages.
 *
 * GET  /fundraising                          — public campaigns list
 * GET  /fundraising/mock-pay/:ref            — mock payment simulation page (dev only)
 * POST /fundraising/mock-pay/confirm         — trigger mock webhook from UI
 * GET  /fundraising/donate/result            — post-payment result page
 * GET  /fundraising/donate/receipt/:id       — donation receipt (auth or token)
 * GET  /fundraising/:slug                    — public campaign detail + donation form
 *
 * GET /admin/fundraising                     — dashboard: campaign list
 * GET /admin/fundraising/new                 — create campaign form
 * GET /admin/fundraising/:id                 — campaign detail/management
 * GET /admin/fundraising/:id/edit            — edit campaign form
 * GET /admin/fundraising/review              — review queue (REVIEWER, ADMIN, OWNER)
 * GET /admin/fundraising/reports             — donation reports (ADMIN, OWNER)
 * GET /admin/fundraising/ledger              — buku kas / donation ledger (ADMIN, OWNER)
 *
 * All /admin/* routes are role-protected server-side.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { requirePageRole } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import * as fundraisingService from './fundraising.service.js';
import type { Role } from '../../shared/rbac.js';
import { env } from '../../config/index.js';
import { logger } from '../../shared/logger.js';

export const fundraisingPublicRouter = Router();
export const fundraisingDashboardRouter = Router();

// ---------------------------------------------------------------------------
// Helper
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

// ===========================================================================
// PUBLIC ROUTES — no authentication required
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /fundraising/mock-pay/:ref — mock payment simulation page (dev/test only)
//
// This route serves a simple UI allowing developers to simulate a successful,
// failed, or expired payment for testing purposes.
//
// SECURITY:
// - Only active when PAYMENT_PROVIDER=mock (default for dev/test).
// - Clearly labelled as a development-only simulation.
// - Does NOT process real money under any circumstances.
// - The actual payment confirmation is done via POST /fundraising/mock-pay/confirm
//   which fires a self-webhook to confirm the payment server-side.
// ---------------------------------------------------------------------------

fundraisingPublicRouter.get(
  '/mock-pay/:ref',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Only serve if using mock provider
      if (env.PAYMENT_PROVIDER !== 'mock') {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      const txRef     = String(req.params['ref']);
      const donationId = String(req.query['donation_id'] ?? '');
      const amount    = String(req.query['amount'] ?? '0');
      const currency  = String(req.query['currency'] ?? 'IDR');
      const successUrl = String(req.query['success_url'] ?? '');

      let csrfToken: string | undefined;
      try {
        csrfToken = generateCsrfToken(req, res);
      } catch {
        csrfToken = undefined;
      }

      res.render('fundraising/mock-pay.njk', {
        title: 'Mock Payment — ISF Dev',
        txRef,
        donationId,
        amount,
        currency,
        successUrl,
        csrfToken,
        year: new Date().getFullYear(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /fundraising/mock-pay/confirm — fire internal mock webhook
//
// Called by the mock payment UI to simulate a payment result.
// Sends a self-request to /webhooks/payment with a signed mock payload,
// then redirects to the result page.
// ---------------------------------------------------------------------------

fundraisingPublicRouter.post(
  '/mock-pay/confirm',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (env.PAYMENT_PROVIDER !== 'mock') {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const { txRef, donationId, status } = req.body as {
        txRef?: string;
        donationId?: string;
        status?: string;
      };

      if (!txRef || !donationId || !status) {
        res.status(422).json({ error: 'txRef, donationId, and status are required' });
        return;
      }

      const validStatuses = ['paid', 'failed', 'expired', 'refunded'];
      if (!validStatuses.includes(status)) {
        res.status(422).json({ error: `Invalid status: ${status}` });
        return;
      }

      // Build mock webhook payload
      const eventId = uuidv4();
      const payload = JSON.stringify({
        event_id: eventId,
        event_type: 'payment.update',
        transaction_ref: txRef,
        status,
        amount: 0, // Not used authoritatively — donation amount comes from DB
        currency: 'IDR',
        occurred_at: new Date().toISOString(),
      });

      // Sign with WEBHOOK_SECRET if set
      const webhookSecret = env.WEBHOOK_SECRET;
      const signature = webhookSecret
        ? createHmac('sha256', webhookSecret).update(payload).digest('hex')
        : 'unsigned';

      // Fire self-webhook
      const webhookUrl = `http://127.0.0.1:${process.env['PORT'] ?? '3000'}/webhooks/payment`;
      try {
        const webhookRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-mock-signature': signature,
            'x-gateway-provider': 'mock',
          },
          body: payload,
        });
        if (!webhookRes.ok) {
          logger.warn({ status: webhookRes.status, txRef }, 'Mock payment: webhook self-call returned non-200');
        }
      } catch (fetchErr) {
        // If webhook self-call fails (e.g. wrong port), log and continue.
        // The payment UI will still redirect but status may not be updated yet.
        logger.warn({ err: fetchErr, txRef }, 'Mock payment: webhook self-call failed');
      }

      res.json({ ok: true, eventId, donationId });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /fundraising — public campaign list
// ---------------------------------------------------------------------------

fundraisingPublicRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = 9;
      const offset = (page - 1) * limit;

      let campaigns: Awaited<ReturnType<typeof fundraisingService.listPublicCampaigns>>['campaigns'] = [];
      let total = 0;

      try {
        const result = await fundraisingService.listPublicCampaigns({ limit, offset });
        campaigns = result.campaigns;
        total = result.total;
      } catch {
        // Gracefully handle any DB error (missing tables etc.)
      }

      const totalPages = Math.ceil(total / limit) || 1;

      res.render('fundraising/campaigns.njk', {
        title: 'Kampanye Donasi — ISF',
        campaigns,
        total,
        page,
        totalPages,
        year: new Date().getFullYear(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /fundraising/donate/result — post-payment result page
// NOTE: Must be registered BEFORE /:slug to avoid wildcard match on "donate".
// ---------------------------------------------------------------------------

fundraisingPublicRouter.get(
  '/donate/result',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donationId = String(req.query['donation_id'] ?? '');
      const resultStatus = String(req.query['status'] ?? 'pending');

      // NOTE: status from query string is NOT authoritative.
      // It's only used for display text. The real status comes from the DB.
      let donation = null;
      if (donationId) {
        try {
        donation = await fundraisingService.getDonationById(donationId);
        } catch { /* DB not ready */ }
        // IDOR: only show if it's the current user's donation, or anonymous
        const userId = req.session.userId;
        if (donation && donation.userId && userId && donation.userId !== userId) {
          donation = null;
        }
      }

      const displayStatus = donation?.status ?? resultStatus;

      res.render('fundraising/donate-result.njk', {
        title: 'Hasil Donasi — ISF',
        donation,
        displayStatus,
        year: new Date().getFullYear(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /fundraising/donate/receipt/:id — donation receipt
// NOTE: Must be registered BEFORE /:slug to avoid wildcard match on "donate".
// ---------------------------------------------------------------------------

fundraisingPublicRouter.get(
  '/donate/receipt/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donationId = String(req.params['id']);
      let donation = null;
      try { donation = await fundraisingService.getDonationById(donationId); } catch { /* DB not ready */ }

      if (!donation) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      // IDOR: allow if donation belongs to current user, or if anonymous/guest
      const userId = req.session.userId;
      const role = req.session.userRole as Role | undefined;
      const isAdmin = role === 'ADMIN' || role === 'OWNER';

      if (!isAdmin && donation.userId && userId !== donation.userId) {
        res.status(403).render('errors/404.njk', {}); // Deliberately ambiguous
        return;
      }

      // Get campaign info
      const campaign = await fundraisingService.getCampaignById(donation.campaignId);

      res.render('fundraising/donate-receipt.njk', {
        title: 'Bukti Donasi — ISF',
        donation,
        campaign,
        year: new Date().getFullYear(),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /fundraising/:slug — public campaign detail
// NOTE: Wildcard — must be last among public routes.
// ---------------------------------------------------------------------------

fundraisingPublicRouter.get(
  '/:slug',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let campaign: Awaited<ReturnType<typeof fundraisingService.getPublicCampaignBySlug>> = null;
      try {
        campaign = await fundraisingService.getPublicCampaignBySlug(String(req.params['slug']));
      } catch {
        // Gracefully handle DB errors (missing tables etc.) — show 404
      }
      if (!campaign) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      // Calculate progress percentage
      const goalAmount = parseFloat(campaign.goalAmount) || 0;
      const totalRaised = parseFloat(campaign.totalRaised) || 0;
      const progressPct = goalAmount > 0 ? Math.min(100, Math.round((totalRaised / goalAmount) * 100)) : 0;

      // CSRF token for donation form (session may or may not exist)
      let csrfToken: string | undefined;
      try {
        csrfToken = generateCsrfToken(req, res);
      } catch {
        csrfToken = undefined;
      }

      res.render('fundraising/campaign-detail.njk', {
        title: `${campaign.title} — ISF`,
        campaign,
        progressPct,
        csrfToken,
        year: new Date().getFullYear(),
        isActive: campaign.status === 'ACTIVE',
        isCompleted: campaign.status === 'COMPLETED',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ===========================================================================
// DASHBOARD ROUTES — authenticated, role-protected
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /admin/fundraising — campaign dashboard
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;
      const ctx = await loadCurrentUser(req, res);

      const statusFilter = req.query['status'] as string | undefined;
      let campaigns: Awaited<ReturnType<typeof fundraisingService.listCampaignsForDashboard>>['campaigns'] = [];
      let migrationPending = false;

      try {
        const result = await fundraisingService.listCampaignsForDashboard(actorId, role, {
          limit: 20,
          offset: 0,
          status: statusFilter as never,
        });
        campaigns = result.campaigns;
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        if (msg.includes('relation') && msg.includes('does not exist')) {
          migrationPending = true;
          logger.warn({ dbErr }, 'Fundraising tables not found — migration may be pending');
        } else {
          throw dbErr;
        }
      }

      res.render('fundraising/dashboard.njk', {
        ...ctx,
        title: 'Kampanye — ISF Dashboard',
        campaigns,
        statusFilter,
        migrationPending,
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
// GET /admin/fundraising/review — reviewer queue
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/review',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;
      const ctx = await loadCurrentUser(req, res);

      const { campaigns } = await fundraisingService.listCampaignsForDashboard(actorId, role, {
        limit: 50,
        offset: 0,
        status: 'IN_REVIEW',
      });

      res.render('fundraising/review-queue.njk', {
        ...ctx,
        title: 'Antrean Tinjauan Kampanye — ISF',
        campaigns,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/fundraising/reports — donation reports (ADMIN, OWNER)
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/reports',
  requirePageRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;
      const ctx = await loadCurrentUser(req, res);

      const campaignFilter = req.query['campaign'] as string | undefined;

      const analyticsOpts: Parameters<typeof fundraisingService.getDonationAnalytics>[0] = {};
      if (campaignFilter) analyticsOpts.campaignId = campaignFilter;

      let campaigns: Awaited<ReturnType<typeof fundraisingService.listCampaignsForDashboard>>['campaigns'] = [];
      let analytics: Awaited<ReturnType<typeof fundraisingService.getDonationAnalytics>> | null = null;
      let migrationPending = false;

      try {
        const results = await Promise.all([
          fundraisingService.listCampaignsForDashboard(actorId, role, { limit: 100, offset: 0 }),
          fundraisingService.getDonationAnalytics(analyticsOpts),
        ]);
        campaigns = results[0].campaigns;
        analytics = results[1];
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        if (msg.includes('relation') && msg.includes('does not exist')) {
          migrationPending = true;
          logger.warn({ dbErr }, 'Fundraising tables not found — migration may be pending');
        } else {
          throw dbErr;
        }
      }

      res.render('fundraising/reports.njk', {
        ...ctx,
        title: 'Laporan & Analitik Donasi — ISF',
        campaigns,
        analytics,
        campaignFilter,
        migrationPending,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/fundraising/new — create campaign form
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/new',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await loadCurrentUser(req, res);
      res.render('fundraising/campaign-edit.njk', {
        ...ctx,
        title: 'Kampanye Baru — ISF',
        campaign: null,
        isNew: true,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/fundraising/:id/edit — edit campaign form
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/:id/edit',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await fundraisingService.getCampaignById(String(req.params['id']));
      if (!campaign) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      // EDITOR can only edit their own campaigns
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;
      if (role === 'EDITOR' && campaign.createdBy !== actorId) {
        res.status(403).render('errors/404.njk', {});
        return;
      }

      const ctx = await loadCurrentUser(req, res);
      res.render('fundraising/campaign-edit.njk', {
        ...ctx,
        title: `Edit: ${campaign.title} — ISF`,
        campaign,
        isNew: false,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/fundraising/ledger — Buku Kas (donation ledger for ADMIN/OWNER)
// NOTE: Must be registered BEFORE /:id to avoid wildcard match on "ledger".
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/ledger',
  requirePageRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;
      const ctx = await loadCurrentUser(req, res);

      const campaignFilter = req.query['campaign'] as string | undefined;
      const statusFilter = req.query['status'] as string | undefined;
      const dateFrom = req.query['dateFrom'] as string | undefined;
      const dateTo = req.query['dateTo'] as string | undefined;
      const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
      const limit = 50;
      const offset = (page - 1) * limit;

      const ledgerOpts: Parameters<typeof fundraisingService.listAllDonationsForLedger>[1] = { limit, offset };
      if (campaignFilter) ledgerOpts.campaignId = campaignFilter;
      if (statusFilter) ledgerOpts.status = statusFilter;
      if (dateFrom) ledgerOpts.dateFrom = dateFrom;
      if (dateTo) ledgerOpts.dateTo = dateTo;

      let campaigns: Awaited<ReturnType<typeof fundraisingService.listCampaignsForDashboard>>['campaigns'] = [];
      let ledger: Awaited<ReturnType<typeof fundraisingService.listAllDonationsForLedger>> = { donations: [], total: 0 };
      let migrationPending = false;

      try {
        const results = await Promise.all([
          fundraisingService.listCampaignsForDashboard(actorId, role, { limit: 100, offset: 0 }),
          fundraisingService.listAllDonationsForLedger(role, ledgerOpts),
        ]);
        campaigns = results[0].campaigns;
        ledger = results[1];
      } catch (dbErr) {
        // If the fundraising tables haven't been migrated yet, surface a clear admin message
        // rather than a raw 500. Does NOT swallow real query errors.
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        if (msg.includes('relation') && msg.includes('does not exist')) {
          migrationPending = true;
          logger.warn({ dbErr }, 'Fundraising tables not found — migration may be pending');
        } else {
          throw dbErr; // re-throw unexpected DB errors
        }
      }

      // CSV export
      if (req.query['_csv'] === '1') {
        const rows = [
          ['ID Donasi', 'Kampanye', 'Donatur', 'Email', 'Nominal', 'Mata Uang', 'Status', 'Tanggal'].join(','),
          ...ledger.donations.map((d) => [
            d.id,
            campaigns.find((c) => c.id === d.campaignId)?.title ?? d.campaignId,
            d.isAnonymous ? 'Anonim' : (d.donorName ?? ''),
            d.isAnonymous ? '' : (d.donorEmail ?? ''),
            d.amount,
            d.currency,
            d.status,
            d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : '',
          ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="buku-kas-isf-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send('\uFEFF' + rows); // BOM for Excel compatibility
        return;
      }

      const totalPages = Math.ceil(ledger.total / limit);

      res.render('fundraising/ledger.njk', {
        ...ctx,
        title: 'Buku Kas — ISF',
        campaigns,
        donations: ledger.donations,
        total: ledger.total,
        page,
        totalPages,
        campaignFilter,
        statusFilter,
        dateFrom,
        dateTo,
        migrationPending,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/fundraising/:id — campaign detail
// ---------------------------------------------------------------------------

fundraisingDashboardRouter.get(
  '/:id',
  requirePageRole('OWNER', 'ADMIN', 'EDITOR', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await fundraisingService.getCampaignById(String(req.params['id']));
      if (!campaign) {
        res.status(404).render('errors/404.njk', {});
        return;
      }

      const role = req.session.userRole as Role;
      const actorId = req.session.userId!;

      // EDITOR can only see their own campaigns
      if (role === 'EDITOR' && campaign.createdBy !== actorId) {
        res.status(403).render('errors/404.njk', {});
        return;
      }

      // Get donations for ADMIN/OWNER
      let donations: Awaited<ReturnType<typeof fundraisingService.listCampaignDonations>>['donations'] = [];
      if (role === 'ADMIN' || role === 'OWNER') {
        const result = await fundraisingService.listCampaignDonations(campaign.id, role, { limit: 20 });
        donations = result.donations;
      }

      const goalAmount = parseFloat(campaign.goalAmount) || 0;
      const totalRaised = parseFloat(campaign.totalRaised) || 0;
      const progressPct = goalAmount > 0 ? Math.min(100, Math.round((totalRaised / goalAmount) * 100)) : 0;

      const ctx = await loadCurrentUser(req, res);
      res.render('fundraising/campaign-detail-admin.njk', {
        ...ctx,
        title: `${campaign.title} — ISF Dashboard`,
        campaign,
        progressPct,
        donations,
        isEditor: role === 'EDITOR',
        isReviewer: role === 'REVIEWER',
        isAdmin: role === 'ADMIN' || role === 'OWNER',
        canEdit: (role === 'EDITOR' && campaign.createdBy === actorId &&
          (campaign.status === 'DRAFT' || campaign.status === 'CHANGES_REQUESTED')) ||
          role === 'ADMIN' || role === 'OWNER',
        canSubmit: (campaign.status === 'DRAFT' || campaign.status === 'CHANGES_REQUESTED') &&
          (role === 'EDITOR' ? campaign.createdBy === actorId : true),
        canApprove: (role === 'ADMIN' || role === 'OWNER') && campaign.status === 'IN_REVIEW' &&
          campaign.createdBy !== actorId,
        canActivate: (role === 'ADMIN' || role === 'OWNER') &&
          (campaign.status === 'APPROVED' || campaign.status === 'SCHEDULED'),
        canPause: (role === 'ADMIN' || role === 'OWNER') && campaign.status === 'ACTIVE',
        canResume: (role === 'ADMIN' || role === 'OWNER') && campaign.status === 'PAUSED',
        canComplete: (role === 'ADMIN' || role === 'OWNER') &&
          (campaign.status === 'ACTIVE' || campaign.status === 'PAUSED'),
        canRequestChanges: (role === 'REVIEWER' || role === 'ADMIN' || role === 'OWNER') &&
          campaign.status === 'IN_REVIEW',
      });
    } catch (err) {
      next(err);
    }
  },
);