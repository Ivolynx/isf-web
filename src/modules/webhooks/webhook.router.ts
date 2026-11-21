/**
 * Webhook router — receives payment gateway webhook notifications.
 *
 * POST /webhooks/payment — receive webhook from payment gateway
 *
 * SECURITY:
 * - No CSRF protection (webhooks are server-to-server, no browser session).
 * - Signature is verified via HMAC before any state change (gateway-specific).
 * - Idempotency: duplicate event_id returns 200 without re-processing.
 * - Raw body is captured before body-parser runs for HMAC to work.
 * - See docs/adr/008-payments.md for the full webhook architecture.
 *
 * IMPORTANT: This router is mounted BEFORE express.json() on the /webhooks path,
 * so that rawBody is available for HMAC verification.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../../shared/logger.js';
import { processWebhookNotification } from '../fundraising/fundraising.service.js';
import { env } from '../../config/index.js';

export const webhookRouter = Router();

// ---------------------------------------------------------------------------
// Raw body capture middleware (must run before express.json on this router)
// ---------------------------------------------------------------------------

webhookRouter.use((req: Request, _res: Response, next: NextFunction) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', next);
});

// ---------------------------------------------------------------------------
// POST /webhooks/payment
// ---------------------------------------------------------------------------

webhookRouter.post('/payment', async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const headers = req.headers as Record<string, string | string[] | undefined>;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
  } catch {
    logger.warn({ url: req.url }, 'Webhook: invalid JSON body');
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // Determine provider from header or query (gateway-specific)
  const provider = String(headers['x-gateway-provider'] ?? req.query['provider'] ?? 'mock');

  let signatureVerified = false;
  let eventId: string;
  let eventType: string;
  let gatewayTxRef: string;
  let status: 'paid' | 'failed' | 'expired' | 'refunded';
  let amount: number;
  let currency: string;

  if (provider === 'mock') {
    // Mock gateway: verify a simple HMAC-SHA256 signature
    signatureVerified = _verifyMockSignature(rawBody, headers);

    eventId = String(body['event_id'] ?? '');
    eventType = String(body['event_type'] ?? 'payment.update');
    gatewayTxRef = String(body['transaction_ref'] ?? '');
    const rawStatus = String(body['status'] ?? 'pending');
    const validStatuses = ['paid', 'failed', 'expired', 'refunded'] as const;
    status = (validStatuses as ReadonlyArray<string>).includes(rawStatus)
      ? (rawStatus as 'paid' | 'failed' | 'expired' | 'refunded')
      : 'failed';
    amount = Number(body['amount'] ?? 0);
    currency = String(body['currency'] ?? 'IDR');
  } else {
    // Unknown provider — reject
    logger.warn({ provider }, 'Webhook: unknown payment provider');
    res.status(400).json({ error: 'Unknown payment provider' });
    return;
  }

  if (!eventId || !gatewayTxRef) {
    logger.warn({ provider, body }, 'Webhook: missing required fields');
    res.status(400).json({ error: 'Missing required webhook fields' });
    return;
  }

  if (!signatureVerified) {
    logger.warn({ provider, eventId }, 'Webhook: signature verification failed — rejecting');
    res.status(401).json({ error: 'Signature verification failed' });
    return;
  }

  try {
    const result = await processWebhookNotification({
      provider,
      eventId,
      eventType,
      gatewayTxRef,
      status,
      amount,
      currency,
      rawPayload: body,
      signatureVerified,
    });

    if (result.alreadyProcessed) {
      logger.info({ provider, eventId }, 'Webhook: duplicate event — idempotent skip');
    } else {
      logger.info({ provider, eventId, status }, 'Webhook: processed successfully');
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error({ err, provider, eventId }, 'Webhook: processing error');
    // 500 causes gateway to retry — do not expose internal error details
    res.status(500).json({ error: 'Internal processing error' });
  }
});

// ---------------------------------------------------------------------------
// Mock signature verification
// ---------------------------------------------------------------------------

function _verifyMockSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const webhookSecret = env.WEBHOOK_SECRET;

  // If no WEBHOOK_SECRET configured in dev/test, allow through with a warning
  if (!webhookSecret) {
    logger.warn('Webhook: WEBHOOK_SECRET not set — accepting unverified webhook (dev only)');
    return true;
  }

  const signatureHeader = headers['x-mock-signature'];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!signature) return false;

  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
