/**
 * Payment gateway interface boundary.
 *
 * All payment gateway implementations MUST satisfy this interface.
 * This allows swapping providers (Midtrans, Xendit, etc.) without
 * changing business logic.
 *
 * Available implementations:
 *   MockPaymentGateway       — local development and testing (fully implemented)
 *   MidtransPaymentGateway   — add when credentials are available
 *   XenditPaymentGateway     — add when credentials are available
 *
 * Critical architectural rules:
 *   1. A client-side button click or redirect is NOT payment confirmation.
 *   2. Donations are PENDING until a verified server-side webhook marks them PAID.
 *   3. Webhook payloads are verified with HMAC before any state change.
 *   4. Processed event IDs are stored for replay protection.
 *   5. All payment state transitions happen inside a database transaction.
 *   6. Payment records are never hard-deleted.
 *   7. Campaign totals are always derived — never stored as a mutable balance.
 *
 * See docs/adr/008-payments.md for architecture details.
 */

import { createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/** The result of initiating a payment at the gateway. */
export interface PaymentInitResult {
  /** Gateway-assigned transaction reference (external ID). */
  gatewayTransactionRef: string;
  /** URL to redirect the user to for completing payment. */
  paymentUrl: string;
  /** ISO-8601 expiry time for the payment link. */
  expiresAt: string;
}

/** Notification received from the gateway (parsed, not raw). */
export interface WebhookNotification {
  /** Unique event ID from the gateway — used for idempotency. */
  eventId: string;
  /** Gateway-assigned transaction reference. */
  gatewayTransactionRef: string;
  /** Normalized payment status. */
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  /** Amount in smallest currency unit (e.g., cents for IDR). */
  amount: number;
  /** ISO-4217 currency code (e.g., 'IDR'). */
  currency: string;
  /** ISO-8601 timestamp of the event at the gateway. */
  occurredAt: string;
  /** Raw gateway-specific payload for reconciliation. */
  rawPayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Payment gateway interface.
 * All gateway adapters must implement this interface.
 */
export interface PaymentGateway {
  readonly name: string;

  /**
   * Initiate a payment at the gateway.
   * Returns a payment URL to redirect the user to.
   * The donation is created as PENDING before calling this method.
   */
  initiatePayment(params: {
    donationId: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    customerName?: string;
    callbackUrl: string;
    successUrl: string;
  }): Promise<PaymentInitResult>;

  /**
   * Verify and parse an incoming webhook notification.
   *
   * @param rawBody  The raw request body (Buffer or string) for HMAC verification.
   * @param headers  The request headers.
   * @returns Parsed notification, or throws if signature is invalid.
   */
  verifyAndParseWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookNotification>;
}

// ---------------------------------------------------------------------------
// Mock implementation (for tests and local development)
// ---------------------------------------------------------------------------

/**
 * Mock payment gateway for local development and tests.
 *
 * Does NOT make real HTTP calls. Does NOT process real money.
 *
 * The mock gateway:
 * - Generates a fake payment URL pointing to /fundraising/mock-pay/:ref
 * - Signs webhook payloads with HMAC-SHA256 using WEBHOOK_SECRET (if set)
 * - Supports manual testing by visiting the mock-pay URL
 *
 * UI NOTICE: Pages that use mock gateway must clearly indicate to users
 * that no real payment is being processed. Do NOT display mock gateway
 * as if it were a real payment provider.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly name = 'mock';

  private readonly webhookSecret: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: { webhookSecret?: string; baseUrl?: string } = {}) {
    this.webhookSecret = opts.webhookSecret;
    this.baseUrl = opts.baseUrl ?? 'http://localhost:3000';
  }

  async initiatePayment(params: {
    donationId: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    customerName?: string;
    callbackUrl: string;
    successUrl: string;
  }): Promise<PaymentInitResult> {
    const gatewayTransactionRef = `mock-${uuidv4()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Mock payment URL — in a real gateway this would redirect to the gateway's hosted page.
    // For mock: a simple page where the developer can manually confirm or reject.
    const paymentUrl =
      `${this.baseUrl}/fundraising/mock-pay/${gatewayTransactionRef}` +
      `?donation_id=${encodeURIComponent(params.donationId)}` +
      `&amount=${encodeURIComponent(String(params.amount))}` +
      `&currency=${encodeURIComponent(params.currency)}` +
      `&success_url=${encodeURIComponent(params.successUrl)}` +
      `&callback_url=${encodeURIComponent(params.callbackUrl)}`;

    return {
      gatewayTransactionRef,
      paymentUrl,
      expiresAt,
    };
  }

  async verifyAndParseWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookNotification> {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;
    const body = JSON.parse(bodyStr) as Record<string, unknown>;

    // Verify HMAC if secret is set
    if (this.webhookSecret) {
      const signatureHeader = headers['x-mock-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

      if (!signature) {
        throw new Error('Missing webhook signature');
      }

      const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');
      const expected = createHmac('sha256', this.webhookSecret).update(buf).digest('hex');

      if (signature !== expected) {
        throw new Error('Webhook signature mismatch');
      }
    }

    const rawStatus = String(body['status'] ?? 'pending');
    const validStatuses = ['pending', 'paid', 'failed', 'expired', 'refunded'] as const;
    const status = (validStatuses as ReadonlyArray<string>).includes(rawStatus)
      ? (rawStatus as WebhookNotification['status'])
      : 'failed';

    return {
      eventId: String(body['event_id'] ?? uuidv4()),
      gatewayTransactionRef: String(body['transaction_ref'] ?? ''),
      status,
      amount: Number(body['amount'] ?? 0),
      currency: String(body['currency'] ?? 'IDR'),
      occurredAt: String(body['occurred_at'] ?? new Date().toISOString()),
      rawPayload: body,
    };
  }

  /**
   * Generate a signed webhook payload for testing.
   * Use this in tests to simulate a gateway webhook notification.
   */
  createTestWebhookPayload(params: {
    eventId: string;
    gatewayTxRef: string;
    status: 'paid' | 'failed' | 'expired' | 'refunded';
    amount: number;
    currency?: string;
  }): { body: string; signature: string } {
    const payload = {
      event_id: params.eventId,
      event_type: 'payment.update',
      transaction_ref: params.gatewayTxRef,
      status: params.status,
      amount: params.amount,
      currency: params.currency ?? 'IDR',
      occurred_at: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    const signature = this.webhookSecret
      ? createHmac('sha256', this.webhookSecret).update(body).digest('hex')
      : 'unsigned';

    return { body, signature };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Get the configured payment gateway instance.
 * Currently only 'mock' is implemented. Add provider adapters here.
 */
export function getPaymentGateway(opts: {
  provider: string;
  webhookSecret?: string;
  baseUrl?: string;
}): PaymentGateway {
  if (opts.provider === 'mock') {
    const gwOpts: { webhookSecret?: string; baseUrl?: string } = {};
    if (opts.webhookSecret) gwOpts.webhookSecret = opts.webhookSecret;
    if (opts.baseUrl) gwOpts.baseUrl = opts.baseUrl;
    return new MockPaymentGateway(gwOpts);
  }

  // Future: add Midtrans/Xendit adapters here when credentials are available
  throw new Error(
    `Payment provider '${opts.provider}' is not yet implemented. ` +
    `Provide credentials and add an adapter in src/shared/payment-gateway.ts.`,
  );
}
