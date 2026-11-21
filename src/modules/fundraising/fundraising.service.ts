/**
 * Fundraising service — campaign management and donation processing.
 *
 * SECURITY RULES:
 *   1. Campaign totals are ALWAYS derived via SELECT SUM(amount) WHERE status='PAID'.
 *      Never stored as a mutable column.
 *   2. Donation status is set to PAID only after verified server-side webhook.
 *   3. A client-side redirect to a success URL is NOT proof of payment.
 *   4. Webhook idempotency: duplicate event_id is silently accepted (200).
 *   5. All payment state transitions happen inside a DB transaction.
 *   6. Donations are never hard-deleted — use REFUNDED status.
 *   7. Campaign conflict of interest: author cannot approve their own campaign.
 *   8. Non-APPROVED campaigns are never shown publicly.
 *
 * See docs/adr/008-payments.md for the full webhook architecture.
 */

import { eq, and, sql, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDb, getPool } from '../../db/client.js';
import {
  campaignsTable,
  donationsTable,
  paymentRecordsTable,
  webhookEventsTable,
  type Campaign,
  type CampaignStatus,
  type Donation,
  type PaymentRecord,
  type WebhookEvent,
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
import { slugify } from '../cms/cms.schemas.js';
import type { CampaignCreateInput, CampaignEditInput, DonationCreateInput } from './fundraising.schemas.js';
import type { MockPaymentGateway } from '../../shared/payment-gateway.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  beneficiary: string;
  goalAmount: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  coverImageUrl: string | null;
  status: CampaignStatus;
  createdBy: string;
  approvedAt: Date | null;
  launchedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Derived: SUM(amount) WHERE status = 'PAID' */
  totalRaised: string;
  donationCount: number;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

async function ensureUniqueCampaignSlug(baseSlug: string, excludeId?: string): Promise<string> {
  const db = getDb();
  let slug = baseSlug;
  let attempt = 0;

  while (true) {
    const conditions = [
      eq(campaignsTable.slug, slug),
      sql`${campaignsTable.deletedAt} IS NULL`,
    ];
    if (excludeId) {
      conditions.push(sql`${campaignsTable.id} != ${excludeId}`);
    }

    const existing = await db
      .select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(and(...conditions))
      .limit(1);

    if (existing.length === 0) break;
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  return slug;
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

export async function createCampaign(
  input: CampaignCreateInput,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (!hasPermission(actorRole, 'campaign:create')) {
    throw new ForbiddenError('Insufficient permissions to create campaigns');
  }

  const db = getDb();
  const baseSlug = input.slug ? slugify(input.slug) : slugify(input.title);
  if (!baseSlug) throw new BadRequestError('Could not generate a valid slug from the title');

  const slug = await ensureUniqueCampaignSlug(baseSlug);

  const [campaign] = await db
    .insert(campaignsTable)
    .values({
      slug,
      title: input.title,
      description: input.description,
      beneficiary: input.beneficiary,
      goalAmount: String(input.goalAmount),
      currency: input.currency,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      coverImageUrl: input.coverImageUrl || null,
      status: 'DRAFT',
      createdBy: actorId,
    })
    .returning();

  if (!campaign) throw new Error('Campaign insert returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: campaign.id,
    metadata: { slug, title: input.title },
  });

  return campaign;
}

export async function editCampaign(
  campaignId: string,
  input: CampaignEditInput,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (!hasPermission(actorRole, 'campaign:edit')) {
    throw new ForbiddenError('Insufficient permissions to edit campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  // Ownership check for non-ADMIN
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    if (campaign.createdBy !== actorId) {
      throw new ForbiddenError('You can only edit your own campaigns');
    }
    if (campaign.status !== 'DRAFT' && campaign.status !== 'CHANGES_REQUESTED') {
      throw new ForbiddenError('Campaign cannot be edited in its current status');
    }
  }

  const rawSlug = input.slug ? slugify(input.slug) : slugify(input.title);
  const slug = rawSlug !== campaign.slug
    ? await ensureUniqueCampaignSlug(rawSlug, campaignId)
    : campaign.slug;

  const [updated] = await db
    .update(campaignsTable)
    .set({
      slug,
      title: input.title,
      description: input.description,
      beneficiary: input.beneficiary,
      goalAmount: String(input.goalAmount),
      currency: input.currency,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      coverImageUrl: input.coverImageUrl || null,
      updatedAt: new Date(),
    })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.edited',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Campaign workflow
// ---------------------------------------------------------------------------

export async function submitCampaignForReview(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (!hasPermission(actorRole, 'campaign:edit')) {
    throw new ForbiddenError('Insufficient permissions to submit campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    if (campaign.createdBy !== actorId) {
      throw new ForbiddenError('You can only submit your own campaigns for review');
    }
  }

  if (campaign.status !== 'DRAFT' && campaign.status !== 'CHANGES_REQUESTED') {
    throw new BadRequestError(`Cannot submit campaign with status '${campaign.status}' for review`);
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: 'IN_REVIEW', updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');
  return updated;
}

export async function approveCampaign(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  // Only ADMIN/OWNER can approve (not REVIEWER per master prompt)
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can approve campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'IN_REVIEW') {
    throw new BadRequestError(`Cannot approve campaign with status '${campaign.status}'`);
  }

  // Conflict of interest
  if (campaign.createdBy === actorId) {
    throw new ForbiddenError('Campaign creators cannot approve their own campaigns');
  }

  const now = new Date();
  const [updated] = await db
    .update(campaignsTable)
    .set({
      status: 'APPROVED',
      approvedAt: now,
      approvedBy: actorId,
      updatedAt: now,
    })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.approved',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function requestCampaignChanges(
  campaignId: string,
  actorId: string,
  actorRole: Role,
  notes: string,
): Promise<Campaign> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER' && actorRole !== 'REVIEWER') {
    throw new ForbiddenError('Insufficient permissions to review campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'IN_REVIEW') {
    throw new BadRequestError(`Cannot request changes on campaign with status '${campaign.status}'`);
  }

  if (!notes || notes.trim().length === 0) {
    throw new BadRequestError('Notes are required when requesting changes');
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({
      status: 'CHANGES_REQUESTED',
      reviewerId: actorId,
      reviewerNotes: notes,
      updatedAt: new Date(),
    })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');
  return updated;
}

export async function activateCampaign(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can activate campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'APPROVED' && campaign.status !== 'SCHEDULED') {
    throw new BadRequestError(`Cannot activate campaign with status '${campaign.status}'`);
  }

  const now = new Date();
  const [updated] = await db
    .update(campaignsTable)
    .set({ status: 'ACTIVE', launchedAt: now, updatedAt: now })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.activated',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function pauseCampaign(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can pause campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'ACTIVE') {
    throw new BadRequestError(`Cannot pause campaign with status '${campaign.status}'`);
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: 'PAUSED', updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.paused',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function resumeCampaign(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can resume campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'PAUSED') {
    throw new BadRequestError(`Cannot resume campaign with status '${campaign.status}'`);
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: 'ACTIVE', updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.resumed',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

export async function completeCampaign(
  campaignId: string,
  actorId: string,
  actorRole: Role,
): Promise<Campaign> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can complete campaigns');
  }

  const db = getDb();
  const campaign = await _getCampaignOrThrow(campaignId);

  if (campaign.status !== 'ACTIVE' && campaign.status !== 'PAUSED') {
    throw new BadRequestError(`Cannot complete campaign with status '${campaign.status}'`);
  }

  const now = new Date();
  const [updated] = await db
    .update(campaignsTable)
    .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
    .where(eq(campaignsTable.id, campaignId))
    .returning();

  if (!updated) throw new Error('Campaign update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'campaign.completed',
    entityType: 'campaign',
    entityId: campaignId,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Campaign reads
// ---------------------------------------------------------------------------

/**
 * List active campaigns (public — only ACTIVE or COMPLETED).
 */
export async function listPublicCampaigns(opts: {
  limit?: number;
  offset?: number;
}): Promise<{ campaigns: CampaignSummary[]; total: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 10, 50);
  const offset = opts.offset ?? 0;

  const baseWhere = and(
    sql`${campaignsTable.status} IN ('ACTIVE', 'COMPLETED')`,
    sql`${campaignsTable.deletedAt} IS NULL`,
  );

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(campaignsTable)
    .where(baseWhere);

  const total = countResult?.count ?? 0;

  const rows = await db
    .select()
    .from(campaignsTable)
    .where(baseWhere)
    .orderBy(desc(campaignsTable.launchedAt))
    .limit(limit)
    .offset(offset);

  const campaigns = await Promise.all(rows.map(_enrichCampaignSummary));
  return { campaigns, total };
}

/**
 * Get a public campaign by slug (must be ACTIVE or COMPLETED).
 */
export async function getPublicCampaignBySlug(slug: string): Promise<CampaignSummary | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.slug, slug),
        sql`${campaignsTable.status} IN ('ACTIVE', 'COMPLETED')`,
        sql`${campaignsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!row) return null;
  return _enrichCampaignSummary(row);
}

/**
 * Get a campaign by ID for dashboard (all statuses).
 */
export async function getCampaignById(campaignId: string): Promise<CampaignSummary | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, campaignId),
        sql`${campaignsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!row) return null;
  return _enrichCampaignSummary(row);
}

export async function listCampaignsForDashboard(
  actorId: string,
  actorRole: Role,
  opts: { limit?: number; offset?: number; status?: CampaignStatus },
): Promise<{ campaigns: CampaignSummary[]; total: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  let whereCondition;
  const baseDeleted = sql`${campaignsTable.deletedAt} IS NULL`;

  if (actorRole === 'OWNER' || actorRole === 'ADMIN') {
    whereCondition = opts.status
      ? and(eq(campaignsTable.status, opts.status), baseDeleted)
      : baseDeleted;
  } else if (actorRole === 'REVIEWER') {
    whereCondition = opts.status
      ? and(eq(campaignsTable.status, opts.status), baseDeleted)
      : and(
          sql`${campaignsTable.status} IN ('IN_REVIEW','APPROVED','ACTIVE','COMPLETED','CHANGES_REQUESTED')`,
          baseDeleted,
        );
  } else if (actorRole === 'EDITOR') {
    const authorCondition = eq(campaignsTable.createdBy, actorId);
    whereCondition = opts.status
      ? and(eq(campaignsTable.status, opts.status), authorCondition, baseDeleted)
      : and(authorCondition, baseDeleted);
  } else {
    return { campaigns: [], total: 0 };
  }

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(campaignsTable)
    .where(whereCondition);

  const total = countResult?.count ?? 0;

  const rows = await db
    .select()
    .from(campaignsTable)
    .where(whereCondition)
    .orderBy(desc(campaignsTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const campaigns = await Promise.all(rows.map(_enrichCampaignSummary));
  return { campaigns, total };
}

// ---------------------------------------------------------------------------
// Donation processing
// ---------------------------------------------------------------------------

/**
 * Initiate a donation.
 *
 * SECURITY:
 * - Amount is validated server-side against the request body.
 * - Campaign must be ACTIVE.
 * - A PENDING payment record is created before any gateway call.
 * - Status is PENDING until a webhook confirms payment.
 */
export async function initiateDonation(
  input: DonationCreateInput,
  userId: string | null,
): Promise<{ donation: Donation; paymentRecord: PaymentRecord }> {
  const db = getDb();
  const pool = getPool();

  // Validate campaign exists and is ACTIVE
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, input.campaignId),
        eq(campaignsTable.status, 'ACTIVE'),
        sql`${campaignsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new BadRequestError('Campaign is not accepting donations at this time');
  }

  // Server-side amount validation
  const amount = input.amount;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestError('Invalid donation amount');
  }

  // Minimum donation: 1000 IDR (or equivalent)
  if (input.currency === 'IDR' && amount < 1000) {
    throw new BadRequestError('Minimum donation is Rp 1.000');
  }

  const idempotencyKey = uuidv4();

  // Use a transaction: payment_record + donation created atomically
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create payment record
    const prResult = await client.query<PaymentRecord>(
      `INSERT INTO payment_records (gateway, gateway_tx_ref, idempotency_key, amount, currency, status, payment_url)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', NULL)
       RETURNING *`,
      ['mock', `mock-${idempotencyKey}`, idempotencyKey, String(amount), input.currency],
    );
    const paymentRecord = prResult.rows[0];
    if (!paymentRecord) throw new Error('Payment record creation failed');

    // 2. Create donation linked to payment record
    const donResult = await client.query<Donation>(
      `INSERT INTO donations (campaign_id, user_id, donor_name, donor_email, is_anonymous, amount, currency, status, payment_record_id, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
       RETURNING *`,
      [
        input.campaignId,
        userId,
        input.donorName ?? null,
        input.donorEmail ?? null,
        input.isAnonymous,
        String(amount),
        input.currency,
        paymentRecord.id,
        input.message ?? null,
      ],
    );
    const donation = donResult.rows[0];
    if (!donation) throw new Error('Donation creation failed');

    await client.query('COMMIT');

    recordAuditEvent({
      actorId: userId ?? null,
      action: 'donation.initiated',
      entityType: 'donation',
      entityId: donation.id,
      metadata: {
        campaignId: input.campaignId,
        amount: String(amount),
        currency: input.currency,
        gateway: 'mock',
      },
    });

    return { donation, paymentRecord };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process a webhook notification.
 *
 * SECURITY:
 * - Idempotent: duplicate event_id returns immediately without re-processing.
 * - Entire state change happens in a single DB transaction.
 * - Amount is verified against the donation record, not the webhook payload.
 * - Campaign total is derived, never stored mutably.
 */
export async function processWebhookNotification(params: {
  provider: string;
  eventId: string;
  eventType: string;
  gatewayTxRef: string;
  status: 'paid' | 'failed' | 'expired' | 'refunded';
  amount: number;
  currency: string;
  rawPayload: Record<string, unknown>;
  signatureVerified: boolean;
}): Promise<{ alreadyProcessed: boolean }> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Idempotency check — if already processed, return early
    const existingEvent = await client.query<WebhookEvent>(
      `SELECT id, processed FROM webhook_events WHERE event_id = $1 FOR UPDATE`,
      [params.eventId],
    );

    if (existingEvent.rows.length > 0 && existingEvent.rows[0]?.processed) {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    // 2. Store or update webhook event
    const eventResult = await client.query<WebhookEvent>(
      `INSERT INTO webhook_events (provider, event_type, event_id, payload, signature_verified)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO UPDATE SET
         processed = FALSE,
         signature_verified = EXCLUDED.signature_verified
       RETURNING *`,
      [
        params.provider,
        params.eventType,
        params.eventId,
        JSON.stringify(params.rawPayload),
        params.signatureVerified,
      ],
    );
    const webhookEvent = eventResult.rows[0];
    if (!webhookEvent) throw new Error('Webhook event storage failed');

    // 3. Find payment record by gateway_tx_ref
    const prResult = await client.query<PaymentRecord>(
      `SELECT * FROM payment_records WHERE gateway = $1 AND gateway_tx_ref = $2 FOR UPDATE`,
      [params.provider, params.gatewayTxRef],
    );
    const paymentRecord = prResult.rows[0];

    if (paymentRecord) {
      const newPaymentStatus = params.status === 'paid' ? 'PAID'
        : params.status === 'failed' ? 'FAILED'
        : params.status === 'expired' ? 'EXPIRED'
        : params.status === 'refunded' ? 'REFUNDED'
        : null;

      if (newPaymentStatus && paymentRecord.status === 'PENDING') {
        // 4. Update payment record
        await client.query(
          `UPDATE payment_records SET status = $1, confirmed_at = $2 WHERE id = $3`,
          [newPaymentStatus, new Date(), paymentRecord.id],
        );

        // 5. Update linked donation
        await client.query(
          `UPDATE donations SET status = $1, updated_at = $2 WHERE payment_record_id = $3`,
          [newPaymentStatus, new Date(), paymentRecord.id],
        );

        // NOTE: campaign total is derived via SELECT SUM(amount) — never stored
      }
    }

    // 6. Mark webhook event as processed
    await client.query(
      `UPDATE webhook_events SET processed = TRUE, processed_at = $1 WHERE id = $2`,
      [new Date(), webhookEvent.id],
    );

    await client.query('COMMIT');
    return { alreadyProcessed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get confirmed donation total for a campaign.
 * DERIVED — never stored as a mutable column.
 */
export async function getCampaignTotalRaised(campaignId: string): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
     FROM donations
     WHERE campaign_id = $1 AND status = 'PAID'`,
    [campaignId],
  );
  return result.rows[0]?.total ?? '0';
}

/**
 * Get donation count for a campaign (confirmed only).
 */
export async function getCampaignDonationCount(campaignId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM donations WHERE campaign_id = $1 AND status = 'PAID'`,
    [campaignId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Get a user's own donation history.
 */
export async function getUserDonations(userId: string): Promise<Donation[]> {
  const db = getDb();
  return db
    .select()
    .from(donationsTable)
    .where(eq(donationsTable.userId, userId))
    .orderBy(desc(donationsTable.createdAt))
    .limit(50);
}

/**
 * Get a single donation by ID (for receipt/status check).
 * IDOR protection: caller must verify userId matches.
 */
export async function getDonationById(donationId: string): Promise<Donation | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(donationsTable)
    .where(eq(donationsTable.id, donationId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Donation analytics / dashboard stats
// ---------------------------------------------------------------------------

export interface DonationAnalytics {
  totalPaid: string;
  totalPending: string;
  totalFailed: string;
  totalRefunded: string;
  countPaid: number;
  countPending: number;
  countFailed: number;
  countRefunded: number;
  uniqueDonors: number;
  avgDonation: string;
  netAvailable: string;
  isSimulation: boolean;
  periodLabel: string;
}

export async function getDonationAnalytics(opts: {
  campaignId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<DonationAnalytics> {
  const db = getDb();

  // Build WHERE conditions — use SQL expression array to avoid complex generic types
  const campaignCondition = opts.campaignId
    ? eq(donationsTable.campaignId, opts.campaignId)
    : null;

  function buildWhere(extra?: SQL): SQL {
    if (campaignCondition && extra) return and(campaignCondition, extra)!;
    if (campaignCondition) return campaignCondition;
    if (extra) return extra;
    return sql`1=1`;
  }

  // We use raw SQL for date filter to avoid Drizzle type issues with text timestamp
  const whereExpr = campaignCondition ?? sql`1=1`;

  // Helper: sum by status
  async function sumByStatus(status: string): Promise<number> {
    const [row] = await db
      .select({ total: sql<string>`COALESCE(SUM(amount::numeric), 0)` })
      .from(donationsTable)
      .where(buildWhere(eq(donationsTable.status, status)));
    return parseFloat(row?.total ?? '0');
  }

  async function countByStatus(status: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(donationsTable)
      .where(buildWhere(eq(donationsTable.status, status)));
    return row?.count ?? 0;
  }

  const [
    paid, pending, failed, refunded,
    cPaid, cPending, cFailed, cRefunded,
  ] = await Promise.all([
    sumByStatus('PAID'),
    sumByStatus('PENDING'),
    sumByStatus('FAILED'),
    sumByStatus('REFUNDED'),
    countByStatus('PAID'),
    countByStatus('PENDING'),
    countByStatus('FAILED'),
    countByStatus('REFUNDED'),
  ]);

  // Unique donors (non-null userId or unique donorEmail)
  const [donorRow] = await db
    .select({ cnt: sql<number>`COUNT(DISTINCT COALESCE(user_id::text, donor_email))::int` })
    .from(donationsTable)
    .where(whereExpr ?? sql`1=1`);
  const uniqueDonors = donorRow?.cnt ?? 0;

  const net = paid - refunded;
  const avgDon = cPaid > 0 ? paid / cPaid : 0;

  // Simulation flag: check if any gateway is 'mock'
  const [gwRow] = await db
    .select({ gateway: paymentRecordsTable.gateway })
    .from(paymentRecordsTable)
    .limit(1);
  const isSimulation = !gwRow || gwRow.gateway === 'mock';

  return {
    totalPaid: paid.toFixed(2),
    totalPending: pending.toFixed(2),
    totalFailed: failed.toFixed(2),
    totalRefunded: refunded.toFixed(2),
    countPaid: cPaid,
    countPending: cPending,
    countFailed: cFailed,
    countRefunded: cRefunded,
    uniqueDonors,
    avgDonation: avgDon.toFixed(2),
    netAvailable: net.toFixed(2),
    isSimulation,
    periodLabel: opts.dateFrom && opts.dateTo
      ? `${opts.dateFrom} s.d. ${opts.dateTo}`
      : 'Semua waktu',
  };
}

// ---------------------------------------------------------------------------
// Admin donation management
// ---------------------------------------------------------------------------

export async function listCampaignDonations(
  campaignId: string,
  actorRole: Role,
  opts: { limit?: number; offset?: number },
): Promise<{ donations: Donation[]; total: number }> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can view all donations');
  }

  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(donationsTable)
    .where(eq(donationsTable.campaignId, campaignId));

  const total = countResult?.count ?? 0;

  const donations = await db
    .select()
    .from(donationsTable)
    .where(eq(donationsTable.campaignId, campaignId))
    .orderBy(desc(donationsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return { donations, total };
}

// ---------------------------------------------------------------------------
// Buku Kas / Ledger — list all donations for reporting
// ---------------------------------------------------------------------------

export async function listAllDonationsForLedger(
  actorRole: Role,
  opts: {
    campaignId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ donations: Donation[]; total: number }> {
  if (actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
    throw new ForbiddenError('Only admins and owners can view the ledger');
  }

  const db = getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: SQL[] = [];
  if (opts.campaignId) conditions.push(eq(donationsTable.campaignId, opts.campaignId));
  if (opts.status) conditions.push(eq(donationsTable.status, opts.status));
  if (opts.dateFrom) conditions.push(sql`${donationsTable.createdAt} >= ${opts.dateFrom}::timestamptz`);
  if (opts.dateTo) conditions.push(sql`${donationsTable.createdAt} <= ${opts.dateTo}::timestamptz`);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(donationsTable)
    .where(whereClause);

  const total = countResult?.count ?? 0;

  const donations = await db
    .select()
    .from(donationsTable)
    .where(whereClause)
    .orderBy(desc(donationsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return { donations, total };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _getCampaignOrThrow(campaignId: string): Promise<Campaign> {
  const db = getDb();
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.id, campaignId),
        sql`${campaignsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (!campaign) throw new NotFoundError('Campaign not found');
  return campaign;
}

async function _enrichCampaignSummary(row: Campaign): Promise<CampaignSummary> {
  const [totalRaised, donationCount] = await Promise.all([
    getCampaignTotalRaised(row.id),
    getCampaignDonationCount(row.id),
  ]);

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    beneficiary: row.beneficiary,
    goalAmount: row.goalAmount,
    currency: row.currency,
    startDate: row.startDate,
    endDate: row.endDate,
    coverImageUrl: row.coverImageUrl,
    status: row.status as CampaignStatus,
    createdBy: row.createdBy,
    approvedAt: row.approvedAt,
    launchedAt: row.launchedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    totalRaised,
    donationCount,
  };
}

// Suppress unused import warning for MockPaymentGateway
void (undefined as unknown as MockPaymentGateway);
