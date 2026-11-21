/**
 * Fundraising module — public exports.
 *
 * Phase 2 implementation:
 *   - Campaign management (DRAFT → IN_REVIEW → APPROVED → ACTIVE → COMPLETED)
 *   - Public donation form
 *   - Mock payment gateway (real provider adapters to be added separately)
 *   - Webhook receiver with HMAC signature verification
 *   - Idempotent donation status transitions
 *   - Campaign totals derived from confirmed donations only (SELECT SUM)
 *
 * CRITICAL payment security rules:
 *   1. A client-side redirect is NOT proof of payment.
 *   2. Donation status is set to PAID only after a verified server-side webhook.
 *   3. Webhook payloads are verified with HMAC before processing.
 *   4. Each webhook event has a unique gateway event ID for idempotency.
 *   5. Payment state transitions happen inside a DB transaction.
 *   6. Campaign totals are always derived — never stored as a mutable balance.
 *
 * See docs/adr/008-payments.md for full webhook and payment architecture.
 */

export { fundraisingApiRouter } from './fundraising.api.router.js';
export { fundraisingPublicRouter, fundraisingDashboardRouter } from './fundraising.pages.router.js';
