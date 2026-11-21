/**
 * Portal scholarship pages router — student-facing UI for the scholarship/loan module.
 *
 * GET  /portal/scholarship/profile          — view/edit student profile
 * GET  /portal/scholarship/loans            — list own loan applications + installments
 * GET  /portal/scholarship/loan/new         — new loan application form
 * GET  /portal/scholarship/installment/:id/pay — payment proof upload
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requirePageAuth } from '../../middleware/page.middleware.js';
import { generateCsrfToken } from '../../middleware/csrf.middleware.js';
import { getUserById } from '../auth/auth.service.js';
import * as scholarshipService from '../scholarship/scholarship.service.js';

export const portalScholarshipRouter = Router();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function loadCtx(req: Request, res: Response) {
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

function isMigrationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('relation') && msg.includes('does not exist');
}

// ---------------------------------------------------------------------------
// GET /portal/scholarship/profile — student profile form
// ---------------------------------------------------------------------------

portalScholarshipRouter.get(
  '/profile',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const ctx = await loadCtx(req, res);

      let profile = null;
      let dbError: string | null = null;
      try {
        profile = await scholarshipService.getStudentProfile(userId);
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel profil mahasiswa belum tersedia — jalankan migration terlebih dahulu.';
        } else {
          throw err;
        }
      }

      res.render('portal/scholarship-profile.njk', {
        ...ctx,
        title: 'Profil Mahasiswa — ISF',
        profile,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/scholarship/loans — loans + installments list
// ---------------------------------------------------------------------------

portalScholarshipRouter.get(
  '/loans',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const ctx = await loadCtx(req, res);

      let loans: Awaited<ReturnType<typeof scholarshipService.getLoanApplicationsByStudent>> = [];
      let installments: Awaited<ReturnType<typeof scholarshipService.getInstallmentsByStudent>> = [];
      let dbError: string | null = null;

      try {
        [loans, installments] = await Promise.all([
          scholarshipService.getLoanApplicationsByStudent(userId),
          scholarshipService.getInstallmentsByStudent(userId),
        ]);
      } catch (err) {
        if (isMigrationError(err)) {
          dbError = 'Tabel pembiayaan belum tersedia — jalankan migration terlebih dahulu.';
        } else {
          throw err;
        }
      }

      res.render('portal/scholarship-loans.njk', {
        ...ctx,
        title: 'Pembiayaan Saya — ISF',
        loans,
        installments,
        dbError,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/scholarship/loan/new — new loan form
// ---------------------------------------------------------------------------

portalScholarshipRouter.get(
  '/loan/new',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const ctx = await loadCtx(req, res);

      let profile = null;
      try {
        profile = await scholarshipService.getStudentProfile(userId);
      } catch { /* table may not exist yet */ }

      res.render('portal/scholarship-loan-form.njk', {
        ...ctx,
        title: 'Ajukan Pembiayaan — ISF',
        profile,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal/scholarship/installment/:id/pay — payment proof upload
// ---------------------------------------------------------------------------

portalScholarshipRouter.get(
  '/installment/:id/pay',
  requirePageAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session.userId!;
      const installmentId = String(req.params['id']);
      const ctx = await loadCtx(req, res);

      // Load the installment, ensuring it belongs to this student
      const installments = await scholarshipService.getInstallmentsByStudent(userId);
      const installment = installments.find((i) => i.id === installmentId);

      if (!installment) {
        res.status(404).render('errors/404.njk', ctx);
        return;
      }

      if (installment.status === 'PAID' || installment.status === 'CANCELLED') {
        res.redirect('/portal/scholarship/loans');
        return;
      }

      const today = new Date().toISOString().slice(0, 10);

      res.render('portal/scholarship-pay.njk', {
        ...ctx,
        title: 'Upload Bukti Pembayaran — ISF',
        installment,
        installmentId,
        today,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);
