/**
 * Scholarship router — student profile, scholarship, and loan management.
 *
 * Portal (student) routes:
 *   GET  /portal/scholarship/profile        — view/edit student profile
 *   POST /api/v1/scholarship/profile        — upsert student profile
 *   POST /api/v1/scholarship/profile/submit — submit for verification
 *   GET  /api/v1/scholarship/applications   — list own scholarship applications
 *   POST /api/v1/scholarship/applications   — create scholarship application
 *   POST /api/v1/scholarship/applications/:id/submit — submit application
 *   GET  /api/v1/scholarship/loans          — list own loan applications
 *   POST /api/v1/scholarship/loans          — create loan application
 *   POST /api/v1/scholarship/loans/:id/submit — submit loan application
 *   GET  /api/v1/scholarship/installments   — list own installments
 *   POST /api/v1/scholarship/installments/:id/pay — submit payment proof
 *
 * Admin routes:
 *   GET  /api/v1/scholarship/admin/profiles  — list student profiles for verification
 *   POST /api/v1/scholarship/admin/profiles/:id/verify — verify/reject profile
 *   GET  /api/v1/scholarship/admin/loans     — list loan applications
 *   POST /api/v1/scholarship/admin/loans/:id/approve — approve loan
 *   POST /api/v1/scholarship/admin/loans/:id/reject  — reject loan
 *   POST /api/v1/scholarship/admin/loans/:id/agreement — create agreement+schedule
 *   GET  /api/v1/scholarship/admin/payments  — list pending payments
 *   POST /api/v1/scholarship/admin/payments/:id/approve — approve payment
 *   POST /api/v1/scholarship/admin/payments/:id/reject  — reject payment
 *
 * All money amounts are validated server-side.
 * Scholarship grants and student loans are tracked separately.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middleware/auth.middleware.js';
import { isRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { ForbiddenError, BadRequestError } from '../../shared/errors.js';
import * as scholarshipService from './scholarship.service.js';
import { uploadPrivateAsset } from '../storage/index.js';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';

export const scholarshipRouter = Router();

// ---------------------------------------------------------------------------
// Multer for payment proof uploads (private bucket, 5MB max)
// ---------------------------------------------------------------------------

const MAX_PROOF_SIZE = (parseInt(process.env['MAX_PROOF_SIZE_MB'] ?? '5') || 5) * 1024 * 1024;

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROOF_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      cb(new BadRequestError('Hanya JPG, PNG, WebP, atau PDF yang diizinkan untuk bukti pembayaran'));
      return;
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRole(req: Request): Role {
  const role = req.session.userRole;
  if (!role || !isRole(role)) throw new ForbiddenError('Invalid session role');
  return role;
}

function getUserId(req: Request): string {
  const id = req.session.userId;
  if (!id) throw new ForbiddenError('Authentication required');
  return id;
}

// ---------------------------------------------------------------------------
// Student profile endpoints
// ---------------------------------------------------------------------------

const profileInputSchema = z.object({
  fullName: z.string().min(1).max(200),
  phoneNumber: z.string().max(30).optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  universityName: z.string().max(300).optional(),
  faculty: z.string().max(200).optional(),
  studyProgram: z.string().max(200).optional(),
  degreeLevel: z.enum(['D3', 'D4', 'S1', 'S2', 'S3', 'Profesi']).optional(),
  studentIdNumber: z.string().max(50).optional(),
  currentSemester: z.number().int().positive().max(20).optional(),
  enrollmentYear: z.number().int().min(2000).max(2100).optional(),
  studentStatus: z.enum(['ACTIVE', 'INACTIVE', 'GRADUATED', 'DROPPED']).optional(),
});

scholarshipRouter.get(
  '/profile',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const profile = await scholarshipService.getStudentProfile(userId);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/profile',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const parsed = profileInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }
      // Strip undefined optional values to satisfy exactOptionalPropertyTypes
      const profileData: import('./scholarship.service.js').StudentProfileInput = {
        fullName: parsed.data.fullName,
        ...(parsed.data.phoneNumber !== undefined && { phoneNumber: parsed.data.phoneNumber }),
        ...(parsed.data.address !== undefined && { address: parsed.data.address }),
        ...(parsed.data.city !== undefined && { city: parsed.data.city }),
        ...(parsed.data.province !== undefined && { province: parsed.data.province }),
        ...(parsed.data.dateOfBirth !== undefined && { dateOfBirth: parsed.data.dateOfBirth }),
        ...(parsed.data.universityName !== undefined && { universityName: parsed.data.universityName }),
        ...(parsed.data.faculty !== undefined && { faculty: parsed.data.faculty }),
        ...(parsed.data.studyProgram !== undefined && { studyProgram: parsed.data.studyProgram }),
        ...(parsed.data.degreeLevel !== undefined && { degreeLevel: parsed.data.degreeLevel }),
        ...(parsed.data.studentIdNumber !== undefined && { studentIdNumber: parsed.data.studentIdNumber }),
        ...(parsed.data.currentSemester !== undefined && { currentSemester: parsed.data.currentSemester }),
        ...(parsed.data.enrollmentYear !== undefined && { enrollmentYear: parsed.data.enrollmentYear }),
        ...(parsed.data.studentStatus !== undefined && { studentStatus: parsed.data.studentStatus }),
      };
      const profile = await scholarshipService.upsertStudentProfile(userId, profileData);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/profile/submit',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const profile = await scholarshipService.getStudentProfile(userId);
      if (!profile) {
        res.status(404).json({ error: 'Profil mahasiswa tidak ditemukan' });
        return;
      }
      const updated = await scholarshipService.submitProfileForVerification(profile.id, userId);
      res.json({ profile: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Scholarship application endpoints (student)
// ---------------------------------------------------------------------------

const scholarshipAppSchema = z.object({
  programId: z.string().uuid(),
  academicYear: z.string().min(1).max(20),
  semester: z.number().int().positive().max(20),
  motivationText: z.string().max(2000).optional(),
});

scholarshipRouter.get(
  '/applications',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const applications = await scholarshipService.getScholarshipApplicationsByStudent(userId);
      res.json({ applications });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/applications',
  requirePermission('application:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const parsed = scholarshipAppSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }
      const appData: import('./scholarship.service.js').ScholarshipApplicationInput = {
        programId: parsed.data.programId,
        academicYear: parsed.data.academicYear,
        semester: parsed.data.semester,
        ...(parsed.data.motivationText !== undefined && { motivationText: parsed.data.motivationText }),
      };
      const application = await scholarshipService.createScholarshipApplication(appData, userId);
      res.status(201).json({ application });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/applications/:id/submit',
  requirePermission('application:submit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const application = await scholarshipService.submitScholarshipApplication(
        String(req.params['id']),
        userId,
      );
      res.json({ application });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Loan application endpoints (student)
// ---------------------------------------------------------------------------

const loanAppSchema = z.object({
  universityName: z.string().min(1).max(300),
  studyProgram: z.string().min(1).max(200),
  semester: z.number().int().positive().max(20),
  academicYear: z.string().min(1).max(20),
  requestedAmount: z.string().refine((v) => {
    const n = parseFloat(v);
    return !isNaN(n) && n > 0 && n <= 100_000_000_000;
  }, 'Nominal tidak valid'),
  requestedTenorMonths: z.number().int().min(1).max(120),
  purposeDescription: z.string().min(10).max(2000),
  estimatedCosts: z.array(z.object({
    description: z.string().min(1),
    amount: z.string(),
  })).optional(),
});

scholarshipRouter.get(
  '/loans',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const loans = await scholarshipService.getLoanApplicationsByStudent(userId);
      res.json({ loans });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/loans',
  requirePermission('application:create'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const parsed = loanAppSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }
      const loanData: import('./scholarship.service.js').LoanApplicationInput = {
        universityName: parsed.data.universityName,
        studyProgram: parsed.data.studyProgram,
        semester: parsed.data.semester,
        academicYear: parsed.data.academicYear,
        requestedAmount: parsed.data.requestedAmount,
        requestedTenorMonths: parsed.data.requestedTenorMonths,
        purposeDescription: parsed.data.purposeDescription,
        ...(parsed.data.estimatedCosts !== undefined && { estimatedCosts: parsed.data.estimatedCosts }),
      };
      const loan = await scholarshipService.createLoanApplication(loanData, userId);
      res.status(201).json({ loan });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/loans/:id/submit',
  requirePermission('application:submit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const loan = await scholarshipService.submitLoanApplication(
        String(req.params['id']),
        userId,
      );
      res.json({ loan });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Installment schedule and payment proof (student)
// ---------------------------------------------------------------------------

scholarshipRouter.get(
  '/installments',
  requireAuth(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const installments = await scholarshipService.getInstallmentsByStudent(userId);
      res.json({ installments });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/installments/:id/pay',
  requireAuth(),
  (req: Request, res: Response, next: NextFunction) => {
    proofUpload.single('proof')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new BadRequestError(`Ukuran file melebihi ${MAX_PROOF_SIZE / 1024 / 1024} MB`));
          return;
        }
        next(new BadRequestError(err.message));
        return;
      }
      if (err) { next(err); return; }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);

      if (!req.file) {
        res.status(422).json({ error: 'Bukti pembayaran wajib diunggah' });
        return;
      }

      const paymentSchema = z.object({
        paymentAmount: z.string().refine((v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0),
        paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        paymentMethod: z.enum(['BANK_TRANSFER', 'CASH', 'OTHER']),
        referenceNumber: z.string().max(100).optional(),
        notes: z.string().max(500).optional(),
      });

      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }

      // Upload proof to private bucket using the shared storage singleton.
      // Key format: loan-payments/{userId}/{uuid}.{ext}
      const ext = req.file.originalname.split('.').pop() ?? 'bin';
      const key = `loan-payments/${userId}/${uuidv4()}.${ext}`;

      await uploadPrivateAsset(key, req.file.buffer, req.file.mimetype);

      const submission = await scholarshipService.submitPayment(
        {
          installmentId: String(req.params['id']),
          paymentAmount: parsed.data.paymentAmount,
          paymentDate: parsed.data.paymentDate,
          paymentMethod: parsed.data.paymentMethod,
          ...(parsed.data.referenceNumber !== undefined && { referenceNumber: parsed.data.referenceNumber }),
          ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
          proofStorageKey: key,
          proofOriginalName: req.file.originalname,
          proofMimeType: req.file.mimetype,
        },
        userId,
      );

      res.status(201).json({ submission });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

scholarshipRouter.get(
  '/admin/profiles',
  requirePermission('application:review'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const role = getRole(req);
      const status = req.query['status'] as string | undefined;
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;
      const result = await scholarshipService.listStudentProfiles(role, {
        limit,
        offset,
        ...(status !== undefined && { status }),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/admin/profiles/:id/verify',
  requirePermission('application:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getUserId(req);
      const role = getRole(req);
      const { approved, notes } = req.body as { approved: boolean; notes?: string };
      const profile = await scholarshipService.verifyStudentProfile(
        String(req.params['id']),
        actorId,
        role,
        Boolean(approved),
        notes,
      );
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/admin/loans/:id/approve',
  requirePermission('application:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getUserId(req);
      const role = getRole(req);
      const approveSchema = z.object({
        approvedAmount: z.string().refine((v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0),
        approvedTenorMonths: z.number().int().min(1).max(120),
        disbursementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const parsed = approveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }
      const loan = await scholarshipService.approveLoanApplication(
        String(req.params['id']),
        actorId,
        role,
        parsed.data,
      );
      res.json({ loan });
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/admin/loans/:id/agreement',
  requirePermission('application:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getUserId(req);
      const role = getRole(req);
      const agreementSchema = z.object({
        agreementNumber: z.string().min(1).max(100),
        principalAmount: z.string().refine((v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0),
        tenorMonths: z.number().int().min(1).max(120),
        disbursementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        firstPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const parsed = agreementSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'Validation failed', details: parsed.error.errors });
        return;
      }
      const result = await scholarshipService.createLoanAgreementWithSchedule(
        String(req.params['id']),
        actorId,
        role,
        parsed.data,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/admin/payments/:id/approve',
  requirePermission('application:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getUserId(req);
      const role = getRole(req);
      const result = await scholarshipService.approvePayment(
        String(req.params['id']),
        actorId,
        role,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

scholarshipRouter.post(
  '/admin/payments/:id/reject',
  requirePermission('application:approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = getUserId(req);
      const role = getRole(req);
      const { reason } = req.body as { reason?: string };
      if (!reason?.trim()) {
        res.status(422).json({ error: 'Reason for rejection is required' });
        return;
      }
      const submission = await scholarshipService.rejectPayment(
        String(req.params['id']),
        actorId,
        role,
        reason,
      );
      res.json({ submission });
    } catch (err) {
      next(err);
    }
  },
);
