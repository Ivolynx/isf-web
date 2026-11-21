/**
 * Admin scholarship pages router — admin UI for managing student profiles, loans, payments.
 *
 * GET /admin/scholarship                    — dashboard (counts)
 * GET /admin/scholarship/profiles           — list + filter student profiles
 * GET /admin/scholarship/profiles/:id       — view profile detail + verify
 * GET /admin/scholarship/loans              — list loan applications
 * GET /admin/scholarship/loans/:id          — loan detail + approve + create agreement
 * GET /admin/scholarship/payments           — list pending payment proofs
 * GET /admin/scholarship/payments/:id       — payment detail + approve/reject
 * GET /admin/scholarship/ledger             — student financing ledger
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requirePageRole } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import { getWordPressConfig } from '../home/wordpress.service.js';
import * as scholarshipService from '../scholarship/scholarship.service.js';
import { getPrivateSignedUrl } from '../storage/index.js';
import { getDb } from '../../db/client.js';
import {
  loanApplicationsTable,
  loanAgreementsTable,
  loanInstallmentSchedulesTable,
  loanPaymentSubmissionsTable,
} from '../../db/schema/index.js';
import { desc, eq, sql } from 'drizzle-orm';
import type { Role } from '../../shared/rbac.js';

export const adminScholarshipRouter = Router();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildCtx(req: Request, res: Response, user: Awaited<ReturnType<typeof getUserById>>) {
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

function isMigrationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('relation') && msg.includes('does not exist');
}

// ---------------------------------------------------------------------------
// GET /admin/scholarship — dashboard with counts
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);

      let pendingProfiles = 0;
      let pendingLoans = 0;
      let pendingPayments = 0;
      let dbError: string | null = null;

      try {
        const role = req.session.userRole as Role;
        const [profilesResult, paymentsResult] = await Promise.all([
          scholarshipService.listStudentProfiles(role, { status: 'PENDING_VERIFICATION', limit: 1 }),
          scholarshipService.listPendingPayments(role, { limit: 1 }),
        ]);
        pendingProfiles = profilesResult.total;
        pendingPayments = paymentsResult.total;

        // Count pending/submitted loans
        const db = getDb();
        const loansRows = await db
          .select({ id: loanApplicationsTable.id })
          .from(loanApplicationsTable)
          .where(eq(loanApplicationsTable.status, 'SUBMITTED'));
        pendingLoans = loansRows.length;
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel modul mahasiswa belum tersedia — jalankan migration 0008 terlebih dahulu.';
        } else {
          throw err;
        }
      }

      res.render('admin/scholarship-dashboard.njk', {
        ...ctx,
        title: 'Beasiswa & Pembiayaan — ISF',
        pendingProfiles,
        pendingLoans,
        pendingPayments,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/profiles — list student profiles
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/profiles',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const role = req.session.userRole as Role;
      const statusFilter = String(req.query['status'] ?? '').trim() || undefined;
      const limit = 20;
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;

      let profiles: Awaited<ReturnType<typeof scholarshipService.listStudentProfiles>>['profiles'] = [];
      let total = 0;
      let dbError: string | null = null;

      try {
        const result = await scholarshipService.listStudentProfiles(role, {
          limit,
          offset,
          ...(statusFilter !== undefined && { status: statusFilter }),
        });
        profiles = result.profiles;
        total = result.total;
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel profil mahasiswa belum tersedia.';
        } else {
          throw err;
        }
      }

      res.render('admin/scholarship-profiles.njk', {
        ...ctx,
        title: 'Verifikasi Profil Mahasiswa — ISF',
        profiles,
        total,
        limit,
        offset,
        statusFilter,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/profiles/:id — profile detail + verify action
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/profiles/:id',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const profileId = String(req.params['id']);

      const profile = await scholarshipService.getStudentProfileById(profileId);
      if (!profile) {
        res.status(404).render('errors/404.njk', ctx);
        return;
      }

      res.render('admin/scholarship-profile-detail.njk', {
        ...ctx,
        title: `${profile.fullName} — Profil Mahasiswa`,
        profile,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/loans — list loan applications
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/loans',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const statusFilter = String(req.query['status'] ?? '').trim() || undefined;
      const limit = 20;
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;

      let loans: typeof loanApplicationsTable.$inferSelect[] = [];
      let total = 0;
      let dbError: string | null = null;

      try {
        const db = getDb();
        const query = db
          .select()
          .from(loanApplicationsTable)
          .orderBy(desc(loanApplicationsTable.createdAt))
          .limit(limit)
          .offset(offset);

        loans = statusFilter
          ? await db.select().from(loanApplicationsTable)
            .where(eq(loanApplicationsTable.status, statusFilter))
            .orderBy(desc(loanApplicationsTable.createdAt))
            .limit(limit).offset(offset)
          : await query;
        total = loans.length; // approximate — good enough for pagination
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel loan belum tersedia.';
        } else {
          throw err;
        }
      }

      res.render('admin/scholarship-loans.njk', {
        ...ctx,
        title: 'Pengajuan Pembiayaan — ISF',
        loans,
        total,
        limit,
        offset,
        statusFilter,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/loans/:id — loan detail
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/loans/:id',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const loanId = String(req.params['id']);

      const db = getDb();
      const [loan] = await db
        .select()
        .from(loanApplicationsTable)
        .where(eq(loanApplicationsTable.id, loanId))
        .limit(1);

      if (!loan) {
        res.status(404).render('errors/404.njk', ctx);
        return;
      }

      res.render('admin/scholarship-loan-detail.njk', {
        ...ctx,
        title: 'Detail Pengajuan Pembiayaan — ISF',
        loan,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/payments — list pending payment submissions
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/payments',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const role = req.session.userRole as Role;

      let payments: Awaited<ReturnType<typeof scholarshipService.listPendingPayments>>['payments'] = [];
      let dbError: string | null = null;

      try {
        const result = await scholarshipService.listPendingPayments(role, { limit: 50 });
        payments = result.payments;
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel pembayaran belum tersedia.';
        } else {
          throw err;
        }
      }

      res.render('admin/scholarship-payments.njk', {
        ...ctx,
        title: 'Verifikasi Pembayaran — ISF',
        payments,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/payments/:id — payment detail + signed URL for proof
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/payments/:id',
  requirePageRole('OWNER', 'ADMIN', 'REVIEWER'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);
      const paymentId = String(req.params['id']);

      const db = getDb();
      const [payment] = await db
        .select()
        .from(loanPaymentSubmissionsTable)
        .where(eq(loanPaymentSubmissionsTable.id, paymentId))
        .limit(1);

      if (!payment) {
        res.status(404).render('errors/404.njk', ctx);
        return;
      }

      // Generate a short-lived signed URL for the proof document (private bucket)
      let signedUrl: string | null = null;
      try {
        signedUrl = await getPrivateSignedUrl(payment.proofStorageKey, 300);
      } catch {
        // S3 may not be available in dev — gracefully degrade
      }

      res.render('admin/scholarship-payment-detail.njk', {
        ...ctx,
        title: 'Detail Bukti Pembayaran — ISF',
        payment,
        signedUrl,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/scholarship/ledger — student financing ledger
// ---------------------------------------------------------------------------

adminScholarshipRouter.get(
  '/ledger',
  requirePageRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.session.userId ? await getUserById(req.session.userId) : null;
      const ctx = buildCtx(req, res, user);

      let dbError: string | null = null;
      let agreements: typeof loanAgreementsTable.$inferSelect[] = [];
      let approvedPayments: typeof loanPaymentSubmissionsTable.$inferSelect[] = [];
      interface LedgerStats {
        totalActiveLoans: number;
        totalPrincipal: string;
        totalInstallments: number;
        paidInstallments: number;
        unpaidInstallments: number;
        totalReceived: string;
      }
      let stats: LedgerStats = {
        totalActiveLoans: 0,
        totalPrincipal: '0',
        totalInstallments: 0,
        paidInstallments: 0,
        unpaidInstallments: 0,
        totalReceived: '0',
      };

      try {
        const db = getDb();

        // Fetch all loan agreements
        agreements = await db
          .select()
          .from(loanAgreementsTable)
          .orderBy(desc(loanAgreementsTable.createdAt))
          .limit(100);

        // Fetch approved payments (verified = reduces balance)
        approvedPayments = await db
          .select()
          .from(loanPaymentSubmissionsTable)
          .where(eq(loanPaymentSubmissionsTable.status, 'APPROVED'))
          .orderBy(desc(loanPaymentSubmissionsTable.verifiedAt))
          .limit(200);

        // Compute stats
        const [installmentStats] = await db
          .select({
            total: sql<number>`COUNT(*)::int`,
            paid: sql<number>`COUNT(*) FILTER (WHERE status = 'PAID')::int`,
            unpaid: sql<number>`COUNT(*) FILTER (WHERE status IN ('UNPAID','UPCOMING','PARTIALLY_PAID'))::int`,
          })
          .from(loanInstallmentSchedulesTable);

        const totalPrincipal = agreements.reduce(
          (sum, ag) => sum + parseFloat(ag.principalAmount),
          0,
        );

        const totalReceived = approvedPayments.reduce(
          (sum, pay) => sum + parseFloat(pay.paymentAmount),
          0,
        );

        stats = {
          totalActiveLoans: agreements.filter((ag) => ag.status === 'ACTIVE' || ag.status === 'AWAITING_ACCEPTANCE').length,
          totalPrincipal: totalPrincipal.toFixed(2),
          totalInstallments: installmentStats?.total ?? 0,
          paidInstallments: installmentStats?.paid ?? 0,
          unpaidInstallments: installmentStats?.unpaid ?? 0,
          totalReceived: totalReceived.toFixed(2),
        };
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel pembiayaan belum tersedia — jalankan migration 0008 terlebih dahulu.';
        } else {
          throw err;
        }
      }

      res.render('admin/scholarship-ledger.njk', {
        ...ctx,
        title: 'Buku Pembiayaan Mahasiswa — ISF',
        agreements,
        approvedPayments,
        stats,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);
