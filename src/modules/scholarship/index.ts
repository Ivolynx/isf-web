/**
 * Scholarship module — student profiles, scholarship applications, loan applications.
 *
 * IMPORTANT FINANCIAL DISTINCTIONS (non-negotiable):
 *   - Scholarship grants are NOT piutang (receivables).
 *     They are gratuitous grants. Approved grants do NOT create loan obligations.
 *   - Student loans ARE piutang. They create repayment obligations.
 *   - These must never be mixed in financial records or reports.
 *
 * SIMULATION MODE:
 *   - All student loan disbursements are in simulation mode until:
 *     a) ISF's operating entity is confirmed
 *     b) Applicable financial regulations are reviewed
 *     c) Loan agreements are reviewed by qualified legal counsel
 *   - The isSimulation flag is set to TRUE on all loan records until cleared.
 */

export { scholarshipRouter } from './scholarship.router.js';
export * from './scholarship.service.js';
