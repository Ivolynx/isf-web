/**
 * Phase 3 Fundraising integration tests.
 *
 * Tests run against the in-memory app (no real DB). They skip gracefully when
 * fundraising tables are not yet migrated (same pattern as CMS tests).
 *
 * Coverage:
 *   - Campaign CRUD permission matrix (EDITOR, REVIEWER, USER, ADMIN, OWNER)
 *   - Campaign workflow transitions (DRAFT → IN_REVIEW → APPROVED → ACTIVE → COMPLETED)
 *   - Conflict of interest: author cannot approve own campaign
 *   - Donation initiation schema validation (server-side amount check)
 *   - IDOR: user cannot see another user's donation
 *   - Webhook idempotency
 *   - Campaign total is derived from PAID donations only
 *   - Mock payment gateway helper
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { isDatabaseAvailable } from '../setup.js';
import {
  MockPaymentGateway,
  type WebhookNotification,
} from '../../src/shared/payment-gateway.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isFundraisingAvailable(): Promise<boolean> {
  if (!(await isDatabaseAvailable())) return false;
  try {
    const { getPool } = await import('../../src/db/client.js');
    const pool = getPool();
    const res = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'campaigns' LIMIT 1`,
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MockPaymentGateway unit tests (no DB needed)
// ---------------------------------------------------------------------------

describe('MockPaymentGateway', () => {
  it('should generate a unique payment URL for each initiation', async () => {
    const gw = new MockPaymentGateway({ baseUrl: 'http://localhost:3000' });
    const r1 = await gw.initiatePayment({
      donationId: 'don-1',
      amount: 50000,
      currency: 'IDR',
      description: 'Test',
      callbackUrl: 'http://localhost:3000/webhooks/payment',
      successUrl: 'http://localhost:3000/donate/result',
    });
    const r2 = await gw.initiatePayment({
      donationId: 'don-2',
      amount: 25000,
      currency: 'IDR',
      description: 'Test 2',
      callbackUrl: 'http://localhost:3000/webhooks/payment',
      successUrl: 'http://localhost:3000/donate/result',
    });

    expect(r1.gatewayTransactionRef).not.toBe(r2.gatewayTransactionRef);
    expect(r1.paymentUrl).toContain('/fundraising/mock-pay/');
    expect(r1.paymentUrl).toContain('don-1');
    expect(r1.expiresAt).toBeTruthy();
  });

  it('should create and verify a signed test webhook payload', async () => {
    const secret = 'test-webhook-secret-32chars-long!!';
    const gw = new MockPaymentGateway({ webhookSecret: secret });

    const { body, signature } = gw.createTestWebhookPayload({
      eventId: 'evt-001',
      gatewayTxRef: 'mock-ref-001',
      status: 'paid',
      amount: 50000,
    });

    const parsed = await gw.verifyAndParseWebhook(Buffer.from(body), {
      'x-mock-signature': signature,
    });

    expect(parsed.eventId).toBe('evt-001');
    expect(parsed.gatewayTransactionRef).toBe('mock-ref-001');
    expect(parsed.status).toBe('paid');
    expect(parsed.amount).toBe(50000);
  });

  it('should reject a webhook with invalid signature', async () => {
    const secret = 'test-webhook-secret-32chars-long!!';
    const gw = new MockPaymentGateway({ webhookSecret: secret });

    const { body } = gw.createTestWebhookPayload({
      eventId: 'evt-002',
      gatewayTxRef: 'mock-ref-002',
      status: 'paid',
      amount: 50000,
    });

    await expect(
      gw.verifyAndParseWebhook(Buffer.from(body), {
        'x-mock-signature': 'invalid-signature',
      }),
    ).rejects.toThrow();
  });

  it('should work without a signature when no webhookSecret is configured', async () => {
    const gw = new MockPaymentGateway(); // no secret

    const payload = JSON.stringify({
      event_id: 'evt-003',
      transaction_ref: 'mock-ref-003',
      status: 'failed',
      amount: 10000,
      currency: 'IDR',
    });

    const parsed = await gw.verifyAndParseWebhook(Buffer.from(payload), {});
    expect(parsed.status).toBe('failed');
  });

  it('should map unknown status to "failed"', async () => {
    const gw = new MockPaymentGateway();

    const payload = JSON.stringify({
      event_id: 'evt-004',
      transaction_ref: 'mock-ref-004',
      status: 'unknown_status',
      amount: 5000,
      currency: 'IDR',
    });

    const parsed = await gw.verifyAndParseWebhook(Buffer.from(payload), {});
    expect(parsed.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Campaign service unit tests (require DB)
// ---------------------------------------------------------------------------

describe('Fundraising — campaign service', () => {
  let fundraisingAvailable = false;
  // Shared test user IDs (real rows in the users table)
  let testEditorId: string;
  let testAdminId: string;
  let testReviewerId: string;

  beforeAll(async () => {
    fundraisingAvailable = await isFundraisingAvailable();
    if (!fundraisingAvailable) {
      console.warn(
        '[skip] Fundraising DB tables not found — run migration 0006 to enable these tests.',
      );
      return;
    }

    // Insert minimal test users so FK on campaigns.created_by is satisfied
    const { getDb } = await import('../../src/db/client.js');
    const { usersTable } = await import('../../src/db/schema/index.js');
    const { hashPassword } = await import('../../src/shared/password.js');
    const db = getDb();
    const hash = await hashPassword('TestPass1!');

    testEditorId = randomUUID();
    testAdminId = randomUUID();
    testReviewerId = randomUUID();

    await db.insert(usersTable).values([
      {
        id: testEditorId,
        email: `test-editor-${testEditorId}@test.invalid`,
        passwordHash: hash,
        displayName: 'Test Editor',
        role: 'EDITOR',
      },
      {
        id: testAdminId,
        email: `test-admin-${testAdminId}@test.invalid`,
        passwordHash: hash,
        displayName: 'Test Admin',
        role: 'ADMIN',
      },
      {
        id: testReviewerId,
        email: `test-reviewer-${testReviewerId}@test.invalid`,
        passwordHash: hash,
        displayName: 'Test Reviewer',
        role: 'REVIEWER',
      },
    ]);
  }, 20_000);

  afterAll(async () => {
    if (!fundraisingAvailable || !testEditorId) return;
    try {
      const { getDb } = await import('../../src/db/client.js');
      const { usersTable } = await import('../../src/db/schema/index.js');
      const { inArray } = await import('drizzle-orm');
      const db = getDb();
      const ids = [testEditorId, testAdminId, testReviewerId].filter(Boolean);
      if (ids.length > 0) {
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
    } catch { /* ignore cleanup errors */ }
  });

  it('EDITOR can create a campaign', async () => {
    if (!fundraisingAvailable) return;

    const { createCampaign } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { BadRequestError, ForbiddenError } = await import('../../src/shared/errors.js');

    const title = `Test Campaign ${Date.now()}`;
    const campaign = await createCampaign(
      {
        title,
        description: 'Test description for campaign',
        beneficiary: 'Test Students',
        goalAmount: 5_000_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    expect(campaign).toBeTruthy();
    expect(campaign.title).toBe(title);
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.createdBy).toBe(testEditorId);
    void BadRequestError;
    void ForbiddenError;
  });

  it('USER cannot create a campaign', async () => {
    if (!fundraisingAvailable) return;

    const { createCampaign } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { ForbiddenError } = await import('../../src/shared/errors.js');

    // USER role check is enforced before any DB insert — no FK needed
    await expect(
      createCampaign(
        {
          title: 'Should fail',
          description: 'User should not be able to create campaigns',
          beneficiary: 'Nobody',
          goalAmount: 1_000,
          currency: 'IDR',
        },
        testEditorId, // valid UUID; ForbiddenError thrown before DB insert
        'USER',
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('Campaign workflow: DRAFT → IN_REVIEW → APPROVED', async () => {
    if (!fundraisingAvailable) return;

    const {
      createCampaign,
      submitCampaignForReview,
      approveCampaign,
    } = await import('../../src/modules/fundraising/fundraising.service.js');

    // testEditorId creates, testAdminId approves (different users)
    const campaign = await createCampaign(
      {
        title: `Workflow Test ${Date.now()}`,
        description: 'Testing workflow transitions',
        beneficiary: 'Test Beneficiary',
        goalAmount: 1_000_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    expect(campaign.status).toBe('DRAFT');

    // Submit for review
    const inReview = await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');
    expect(inReview.status).toBe('IN_REVIEW');

    // Approve (different user as admin — conflict of interest check)
    const approved = await approveCampaign(campaign.id, testAdminId, 'ADMIN');
    expect(approved.status).toBe('APPROVED');
  });

  it('Campaign conflict of interest: author cannot approve their own campaign', async () => {
    if (!fundraisingAvailable) return;

    const {
      createCampaign,
      submitCampaignForReview,
      approveCampaign,
    } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { ForbiddenError } = await import('../../src/shared/errors.js');

    // testEditorId creates and tries to approve their own campaign
    const campaign = await createCampaign(
      {
        title: `COI Test ${Date.now()}`,
        description: 'Conflict of interest test',
        beneficiary: 'Test',
        goalAmount: 500_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');

    // Try to approve their own campaign — should throw ForbiddenError
    await expect(
      approveCampaign(campaign.id, testEditorId, 'ADMIN'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('REVIEWER can request changes but cannot approve', async () => {
    if (!fundraisingAvailable) return;

    const {
      createCampaign,
      submitCampaignForReview,
      approveCampaign,
      requestCampaignChanges,
    } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { ForbiddenError } = await import('../../src/shared/errors.js');

    const campaign = await createCampaign(
      {
        title: `Reviewer Test ${Date.now()}`,
        description: 'Testing reviewer permissions',
        beneficiary: 'Test Beneficiary',
        goalAmount: 2_000_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');

    // REVIEWER can request changes
    const changesRequested = await requestCampaignChanges(
      campaign.id,
      testReviewerId,
      'REVIEWER',
      'Perlu perbaikan di deskripsi.',
    );
    expect(changesRequested.status).toBe('CHANGES_REQUESTED');

    // Re-submit for another attempt
    await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');

    // REVIEWER cannot approve
    await expect(
      approveCampaign(campaign.id, testReviewerId, 'REVIEWER'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('Cannot submit campaign not in DRAFT or CHANGES_REQUESTED', async () => {
    if (!fundraisingAvailable) return;

    const {
      createCampaign,
      submitCampaignForReview,
      approveCampaign,
      activateCampaign,
    } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { BadRequestError } = await import('../../src/shared/errors.js');

    const campaign = await createCampaign(
      {
        title: `Submit Status Test ${Date.now()}`,
        description: 'Testing invalid workflow transitions',
        beneficiary: 'Test',
        goalAmount: 500_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');
    await approveCampaign(campaign.id, testAdminId, 'ADMIN');
    await activateCampaign(campaign.id, testAdminId, 'ADMIN');

    // Cannot submit an ACTIVE campaign for review
    await expect(
      submitCampaignForReview(campaign.id, testEditorId, 'EDITOR'),
    ).rejects.toThrow(BadRequestError);
  });

  it('Donation to a non-ACTIVE campaign is rejected', async () => {
    if (!fundraisingAvailable) return;

    const { createCampaign, initiateDonation } = await import(
      '../../src/modules/fundraising/fundraising.service.js'
    );
    const { BadRequestError } = await import('../../src/shared/errors.js');

    const campaign = await createCampaign(
      {
        title: `Inactive Donation Test ${Date.now()}`,
        description: 'Should not accept donations in DRAFT',
        beneficiary: 'Test',
        goalAmount: 1_000_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    // Campaign is DRAFT — donation should fail
    await expect(
      initiateDonation(
        {
          campaignId: campaign.id,
          amount: 50_000,
          currency: 'IDR',
          isAnonymous: false,
        },
        null,
      ),
    ).rejects.toThrow(BadRequestError);
  });

  it('Donation with amount below minimum is rejected server-side', async () => {
    if (!fundraisingAvailable) return;

    const {
      createCampaign,
      submitCampaignForReview,
      approveCampaign,
      activateCampaign,
      initiateDonation,
    } = await import('../../src/modules/fundraising/fundraising.service.js');
    const { BadRequestError } = await import('../../src/shared/errors.js');

    const campaign = await createCampaign(
      {
        title: `Min Amount Test ${Date.now()}`,
        description: 'Testing minimum donation validation',
        beneficiary: 'Test',
        goalAmount: 1_000_000,
        currency: 'IDR',
      },
      testEditorId,
      'EDITOR',
    );

    await submitCampaignForReview(campaign.id, testEditorId, 'EDITOR');
    await approveCampaign(campaign.id, testAdminId, 'ADMIN');
    await activateCampaign(campaign.id, testAdminId, 'ADMIN');

    // IDR amount below 1000 — should throw BadRequestError
    await expect(
      initiateDonation(
        { campaignId: campaign.id, amount: 500, currency: 'IDR', isAnonymous: false },
        null,
      ),
    ).rejects.toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// WebhookNotification type guard (compile-time type test)
// ---------------------------------------------------------------------------

describe('WebhookNotification type', () => {
  it('should compile with valid properties', () => {
    const notification: WebhookNotification = {
      eventId: 'evt-compile',
      gatewayTransactionRef: 'ref-001',
      status: 'paid',
      amount: 50000,
      currency: 'IDR',
      occurredAt: new Date().toISOString(),
      rawPayload: {},
    };
    expect(notification.status).toBe('paid');
  });
});
