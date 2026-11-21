/**
 * Fundraising API router — JSON endpoints for campaign and donation management.
 *
 * POST   /api/v1/campaigns                    — create campaign (EDITOR, ADMIN, OWNER)
 * GET    /api/v1/campaigns                    — list campaigns (dashboard, role-filtered)
 * GET    /api/v1/campaigns/public             — list public (ACTIVE/COMPLETED) campaigns
 * GET    /api/v1/campaigns/:id                — get single campaign
 * PUT    /api/v1/campaigns/:id                — edit campaign
 * POST   /api/v1/campaigns/:id/submit         — submit for review
 * POST   /api/v1/campaigns/:id/approve        — approve (ADMIN, OWNER)
 * POST   /api/v1/campaigns/:id/request-changes — request changes (REVIEWER, ADMIN, OWNER)
 * POST   /api/v1/campaigns/:id/activate       — activate (ADMIN, OWNER)
 * POST   /api/v1/campaigns/:id/complete       — complete (ADMIN, OWNER)
 * GET    /api/v1/campaigns/:id/donations      — list donations for campaign (ADMIN, OWNER)
 *
 * POST   /api/v1/donations                    — initiate donation
 * GET    /api/v1/donations/mine               — user's own donation history (auth)
 * GET    /api/v1/donations/:id                — get single donation (owner or admin)
 *
 * SECURITY:
 * - Amount, status, campaignId are validated server-side.
 * - Campaign status transitions are enforced in the service.
 * - IDOR: users can only read their own donations unless ADMIN/OWNER.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, requirePermission } from '../../middleware/auth.middleware.js';
import { isRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { ForbiddenError } from '../../shared/errors.js';
import { campaignCreateSchema, campaignEditSchema, donationCreateSchema } from './fundraising.schemas.js';
import * as fundraisingService from './fundraising.service.js';

export const fundraisingApiRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
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
// POST /api/v1/campaigns
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns',
  requirePermission('campaign:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = campaignCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }
      const campaign = await fundraisingService.createCampaign(
        parsed.data,
        getActorId(req),
        getActorRole(req),
      );
      res.status(201).json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/campaigns/public — public listing (no auth required)
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/campaigns/public',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '10'), 10) || 10, 50);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;
      const result = await fundraisingService.listPublicCampaigns({ limit, offset });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/campaigns — dashboard list (authenticated)
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/campaigns',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const actorId = getActorId(req);

      if (role === 'USER') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;
      const status = req.query['status'] as string | undefined;

      const result = await fundraisingService.listCampaignsForDashboard(actorId, role, {
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
// GET /api/v1/campaigns/:id
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/campaigns/:id',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role === 'USER') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      const campaign = await fundraisingService.getCampaignById(String(req.params['id']));
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/v1/campaigns/:id
// ---------------------------------------------------------------------------

fundraisingApiRouter.put(
  '/campaigns/:id',
  requirePermission('campaign:edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = campaignEditSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }
      const campaign = await fundraisingService.editCampaign(
        String(req.params['id']),
        parsed.data,
        getActorId(req),
        getActorRole(req),
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/submit
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/submit',
  requirePermission('campaign:edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await fundraisingService.submitCampaignForReview(
        String(req.params['id']),
        getActorId(req),
        getActorRole(req),
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/approve
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/approve',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can approve campaigns' });
        return;
      }
      const campaign = await fundraisingService.approveCampaign(
        String(req.params['id']),
        getActorId(req),
        role,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/request-changes
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/request-changes',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER' && role !== 'REVIEWER') {
        res.status(403).json({ error: 'Insufficient permissions to review campaigns' });
        return;
      }
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : '';
      if (!notes.trim()) {
        res.status(422).json({ error: 'Notes are required when requesting changes' });
        return;
      }
      const campaign = await fundraisingService.requestCampaignChanges(
        String(req.params['id']),
        getActorId(req),
        role,
        notes,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/activate
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/activate',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can activate campaigns' });
        return;
      }
      const campaign = await fundraisingService.activateCampaign(
        String(req.params['id']),
        getActorId(req),
        role,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/complete
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/pause
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/pause',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can pause campaigns' });
        return;
      }
      const campaign = await fundraisingService.pauseCampaign(
        String(req.params['id']),
        getActorId(req),
        role,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/resume
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/resume',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can resume campaigns' });
        return;
      }
      const campaign = await fundraisingService.resumeCampaign(
        String(req.params['id']),
        getActorId(req),
        role,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/campaigns/:id/complete
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/campaigns/:id/complete',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      if (role !== 'ADMIN' && role !== 'OWNER') {
        res.status(403).json({ error: 'Only admins and owners can complete campaigns' });
        return;
      }
      const campaign = await fundraisingService.completeCampaign(
        String(req.params['id']),
        getActorId(req),
        role,
      );
      res.json({ campaign });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/campaigns/:id/donations — admin only
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/campaigns/:id/donations',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;
      const result = await fundraisingService.listCampaignDonations(
        String(req.params['id']),
        role,
        { limit, offset },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/v1/donations — initiate donation (public, but rate-limited in app)
// ---------------------------------------------------------------------------

fundraisingApiRouter.post(
  '/donations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = donationCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const details = parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        res.status(422).json({ error: 'Validation failed', details });
        return;
      }

      // Authenticated user ID if logged in; null for guests
      const userId = req.session.userId ?? null;

      const { donation, paymentRecord } = await fundraisingService.initiateDonation(
        parsed.data,
        userId,
      );

      res.status(201).json({
        donationId: donation.id,
        status: donation.status,
        paymentUrl: paymentRecord.paymentUrl,
        expiresAt: null, // mock gateway; real gateway sets expiry
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/donations/mine — authenticated user's donation history
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/donations/mine',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getActorId(req);
      const donations = await fundraisingService.getUserDonations(userId);
      res.json({ donations });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/donations/:id — single donation (IDOR-protected)
// ---------------------------------------------------------------------------

fundraisingApiRouter.get(
  '/donations/:id',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getActorRole(req);
      const actorId = getActorId(req);

      const donation = await fundraisingService.getDonationById(String(req.params['id']));
      if (!donation) {
        res.status(404).json({ error: 'Donation not found' });
        return;
      }

      // IDOR protection: users can only see their own donations
      if (role === 'USER' && donation.userId !== actorId) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      res.json({ donation });
    } catch (err) {
      next(err);
    }
  },
);
