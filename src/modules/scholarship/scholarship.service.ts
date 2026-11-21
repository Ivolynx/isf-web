/**
 * Scholarship and Student Loan service.
 *
 * Handles:
 *   - Student profile CRUD
 *   - Scholarship application workflow
 *   - Student loan application workflow
 *   - Installment schedule generation
 *   - Payment submission and verification
 *
 * Financial rules:
 *   - Scholarship grants do NOT create piutang records
 *   - Student loan disbursements DO create piutang records
 *   - Only approved payments reduce the outstanding balance
 *   - Payments are verified by admin before reducing balance
 *   - All monetary amounts use NUMERIC(15,2) — never floating-point
 */

import { eq, and, desc, sql, or } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  studentProfilesTable,
  scholarshipProgramsTable,
  scholarshipApplicationsTable,
  loanApplicationsTable,
  loanAgreementsTable,
  loanInstallmentSchedulesTable,
  loanPaymentSubmissionsTable,
  type StudentProfile,
  type NewStudentProfile,
  type ScholarshipApplication,
  type LoanApplication,
  type LoanAgreement,
  type LoanInstallmentSchedule,
  type LoanPaymentSubmission,
} from '../../db/schema/index.js';
import { hasPermission } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { ForbiddenError, BadRequestError, NotFoundError } from '../../shared/errors.js';
import { recordAuditEvent } from '../../shared/audit.js';
import { logger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Student Profile
// ---------------------------------------------------------------------------

export interface StudentProfileInput {
  fullName: string;
  phoneNumber?: string;
  address?: string;
  city?: string;
  province?: string;
  dateOfBirth?: string;
  universityName?: string;
  faculty?: string;
  studyProgram?: string;
  degreeLevel?: string;
  studentIdNumber?: string;
  currentSemester?: number;
  enrollmentYear?: number;
  studentStatus?: 'ACTIVE' | 'INACTIVE' | 'GRADUATED' | 'DROPPED';
}

export async function getStudentProfile(userId: string): Promise<StudentProfile | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getStudentProfileById(profileId: string): Promise<StudentProfile | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.id, profileId))
    .limit(1);
  return row ?? null;
}

export async function upsertStudentProfile(
  userId: string,
  input: StudentProfileInput,
): Promise<StudentProfile> {
  const db = getDb();

  const existing = await getStudentProfile(userId);

  if (existing) {
    const [updated] = await db
      .update(studentProfilesTable)
      .set({
        fullName: input.fullName,
        phoneNumber: input.phoneNumber ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        province: input.province ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        universityName: input.universityName ?? null,
        faculty: input.faculty ?? null,
        studyProgram: input.studyProgram ?? null,
        degreeLevel: input.degreeLevel ?? null,
        studentIdNumber: input.studentIdNumber ?? null,
        currentSemester: input.currentSemester ?? null,
        enrollmentYear: input.enrollmentYear ?? null,
        studentStatus: input.studentStatus ?? 'ACTIVE',
        // Reset to pending verification when profile is updated
        verificationStatus: existing.verificationStatus === 'VERIFIED'
          ? 'PENDING_VERIFICATION'
          : existing.verificationStatus,
        updatedAt: new Date(),
      })
      .where(eq(studentProfilesTable.id, existing.id))
      .returning();

    if (!updated) throw new Error('Profile update returned no rows');
    return updated;
  } else {
    const [created] = await db
      .insert(studentProfilesTable)
      .values({
        userId,
        fullName: input.fullName,
        phoneNumber: input.phoneNumber ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        province: input.province ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        universityName: input.universityName ?? null,
        faculty: input.faculty ?? null,
        studyProgram: input.studyProgram ?? null,
        degreeLevel: input.degreeLevel ?? null,
        studentIdNumber: input.studentIdNumber ?? null,
        currentSemester: input.currentSemester ?? null,
        enrollmentYear: input.enrollmentYear ?? null,
        studentStatus: input.studentStatus ?? 'ACTIVE',
        verificationStatus: 'INCOMPLETE',
      } satisfies Partial<typeof studentProfilesTable.$inferInsert>)
      .returning();

    if (!created) throw new Error('Profile insert returned no rows');

    recordAuditEvent({
      actorId: userId,
      action: 'student_profile.created',
      entityType: 'student_profile',
      entityId: created.id,
      metadata: { userId },
    });

    return created;
  }
}

export async function submitProfileForVerification(profileId: string, userId: string): Promise<StudentProfile> {
  const db = getDb();
  const profile = await getStudentProfileById(profileId);
  if (!profile) throw new NotFoundError('Student profile not found');
  if (profile.userId !== userId) throw new ForbiddenError('Access denied');

  if (!profile.fullName || !profile.universityName) {
    throw new BadRequestError('Profil belum lengkap. Isi nama lengkap dan nama universitas terlebih dahulu.');
  }

  const [updated] = await db
    .update(studentProfilesTable)
    .set({ verificationStatus: 'PENDING_VERIFICATION', updatedAt: new Date() })
    .where(eq(studentProfilesTable.id, profileId))
    .returning();

  if (!updated) throw new Error('Profile update returned no rows');
  return updated;
}

export async function verifyStudentProfile(
  profileId: string,
  verifierId: string,
  verifierRole: Role,
  approved: boolean,
  notes?: string,
): Promise<StudentProfile> {
  if (!hasPermission(verifierRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to verify student profiles');
  }

  const db = getDb();
  const profile = await getStudentProfileById(profileId);
  if (!profile) throw new NotFoundError('Student profile not found');

  const newStatus = approved ? 'VERIFIED' : 'CHANGES_REQUESTED';

  const [updated] = await db
    .update(studentProfilesTable)
    .set({
      verificationStatus: newStatus,
      verifiedBy: approved ? verifierId : null,
      verifiedAt: approved ? new Date() : null,
      verificationNotes: notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(studentProfilesTable.id, profileId))
    .returning();

  if (!updated) throw new Error('Profile update returned no rows');

  recordAuditEvent({
    actorId: verifierId,
    action: approved ? 'student_profile.verified' : 'student_profile.changes_requested',
    entityType: 'student_profile',
    entityId: profileId,
    metadata: { approved, notes },
  });

  return updated;
}

export async function listStudentProfiles(
  actorRole: Role,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ profiles: StudentProfile[]; total: number }> {
  if (!hasPermission(actorRole, 'application:review')) {
    throw new ForbiddenError('Insufficient permissions');
  }

  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  const whereClause = opts.status
    ? eq(studentProfilesTable.verificationStatus, opts.status)
    : undefined;

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(studentProfilesTable)
    .where(whereClause);

  const total = countResult?.count ?? 0;

  const profiles = await db
    .select()
    .from(studentProfilesTable)
    .where(whereClause)
    .orderBy(desc(studentProfilesTable.createdAt))
    .limit(limit)
    .offset(offset);

  return { profiles, total };
}

// ---------------------------------------------------------------------------
// Scholarship Applications
// ---------------------------------------------------------------------------

export interface ScholarshipApplicationInput {
  programId: string;
  academicYear: string;
  semester: number;
  motivationText?: string;
}

export async function createScholarshipApplication(
  input: ScholarshipApplicationInput,
  userId: string,
): Promise<ScholarshipApplication> {
  const db = getDb();

  // Get student profile — must exist and be verified (or at least incomplete)
  const profile = await getStudentProfile(userId);
  if (!profile) {
    throw new BadRequestError('Profil mahasiswa belum dibuat. Lengkapi profil terlebih dahulu.');
  }

  // Check program exists and is active
  const [program] = await db
    .select()
    .from(scholarshipProgramsTable)
    .where(eq(scholarshipProgramsTable.id, input.programId))
    .limit(1);

  if (!program || program.status !== 'ACTIVE') {
    throw new NotFoundError('Program beasiswa tidak ditemukan atau tidak aktif');
  }

  const [application] = await db
    .insert(scholarshipApplicationsTable)
    .values({
      programId: input.programId,
      studentId: profile.id,
      submittedBy: userId,
      academicYear: input.academicYear,
      semester: input.semester,
      motivationText: input.motivationText ?? null,
      supportingDocs: [],
      status: 'DRAFT',
    })
    .returning();

  if (!application) throw new Error('Application insert returned no rows');

  recordAuditEvent({
    actorId: userId,
    action: 'scholarship_application.created',
    entityType: 'scholarship_application',
    entityId: application.id,
    metadata: { programId: input.programId },
  });

  return application;
}

export async function submitScholarshipApplication(
  applicationId: string,
  userId: string,
): Promise<ScholarshipApplication> {
  const db = getDb();

  const [app] = await db
    .select()
    .from(scholarshipApplicationsTable)
    .where(eq(scholarshipApplicationsTable.id, applicationId))
    .limit(1);

  if (!app) throw new NotFoundError('Pengajuan tidak ditemukan');
  if (app.submittedBy !== userId) throw new ForbiddenError('Akses ditolak');
  if (app.status !== 'DRAFT') throw new BadRequestError('Pengajuan tidak dalam status DRAFT');

  const [updated] = await db
    .update(scholarshipApplicationsTable)
    .set({ status: 'SUBMITTED', updatedAt: new Date() })
    .where(eq(scholarshipApplicationsTable.id, applicationId))
    .returning();

  if (!updated) throw new Error('Update returned no rows');

  recordAuditEvent({
    actorId: userId,
    action: 'scholarship_application.submitted',
    entityType: 'scholarship_application',
    entityId: applicationId,
  });

  return updated;
}

export async function approveScholarshipApplication(
  applicationId: string,
  actorId: string,
  actorRole: Role,
  approvedAmount: string,
  coveragePctActual: string,
): Promise<ScholarshipApplication> {
  if (!hasPermission(actorRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to approve scholarship applications');
  }

  // Validate amount — must be a valid positive decimal
  const amount = parseFloat(approvedAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new BadRequestError('Jumlah beasiswa tidak valid');
  }

  const db = getDb();

  const [app] = await db
    .select()
    .from(scholarshipApplicationsTable)
    .where(eq(scholarshipApplicationsTable.id, applicationId))
    .limit(1);

  if (!app) throw new NotFoundError('Pengajuan tidak ditemukan');
  if (app.status !== 'IN_REVIEW' && app.status !== 'SUBMITTED') {
    throw new BadRequestError(`Pengajuan tidak dapat disetujui dari status ${app.status}`);
  }

  const [updated] = await db
    .update(scholarshipApplicationsTable)
    .set({
      status: 'APPROVED',
      approvedBy: actorId,
      approvedAt: new Date(),
      approvedAmount,
      coveragePctActual,
      updatedAt: new Date(),
    })
    .where(eq(scholarshipApplicationsTable.id, applicationId))
    .returning();

  if (!updated) throw new Error('Update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'scholarship_application.approved',
    entityType: 'scholarship_application',
    entityId: applicationId,
    metadata: { approvedAmount, coveragePctActual },
  });

  return updated;
}

export async function getScholarshipApplicationsByStudent(userId: string): Promise<ScholarshipApplication[]> {
  const db = getDb();
  const profile = await getStudentProfile(userId);
  if (!profile) return [];

  return db
    .select()
    .from(scholarshipApplicationsTable)
    .where(eq(scholarshipApplicationsTable.studentId, profile.id))
    .orderBy(desc(scholarshipApplicationsTable.createdAt));
}

// ---------------------------------------------------------------------------
// Student Loan Applications
// ---------------------------------------------------------------------------

export interface LoanApplicationInput {
  universityName: string;
  studyProgram: string;
  semester: number;
  academicYear: string;
  requestedAmount: string;
  requestedTenorMonths: number;
  purposeDescription: string;
  estimatedCosts?: Array<{ description: string; amount: string }>;
}

export async function createLoanApplication(
  input: LoanApplicationInput,
  userId: string,
): Promise<LoanApplication> {
  const db = getDb();

  const profile = await getStudentProfile(userId);
  if (!profile) {
    throw new BadRequestError('Profil mahasiswa belum dibuat. Lengkapi profil terlebih dahulu.');
  }

  const amount = parseFloat(input.requestedAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new BadRequestError('Nominal pembiayaan tidak valid');
  }
  if (input.requestedTenorMonths < 1 || input.requestedTenorMonths > 120) {
    throw new BadRequestError('Tenor harus antara 1 dan 120 bulan');
  }

  const [application] = await db
    .insert(loanApplicationsTable)
    .values({
      studentId: profile.id,
      submittedBy: userId,
      universityName: input.universityName,
      studyProgram: input.studyProgram,
      semester: input.semester,
      academicYear: input.academicYear,
      requestedAmount: input.requestedAmount,
      requestedTenorMonths: input.requestedTenorMonths,
      purposeDescription: input.purposeDescription,
      estimatedCosts: input.estimatedCosts ?? [],
      status: 'DRAFT',
      isSimulation: true, // Always simulation until legal clearance
    })
    .returning();

  if (!application) throw new Error('Loan application insert returned no rows');

  recordAuditEvent({
    actorId: userId,
    action: 'loan_application.created',
    entityType: 'loan_application',
    entityId: application.id,
    metadata: { requestedAmount: input.requestedAmount, tenor: input.requestedTenorMonths },
  });

  return application;
}

export async function submitLoanApplication(
  applicationId: string,
  userId: string,
): Promise<LoanApplication> {
  const db = getDb();

  const [app] = await db
    .select()
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.id, applicationId))
    .limit(1);

  if (!app) throw new NotFoundError('Pengajuan tidak ditemukan');
  if (app.submittedBy !== userId) throw new ForbiddenError('Akses ditolak');
  if (app.status !== 'DRAFT') throw new BadRequestError('Pengajuan tidak dalam status DRAFT');

  const [updated] = await db
    .update(loanApplicationsTable)
    .set({ status: 'SUBMITTED', updatedAt: new Date() })
    .where(eq(loanApplicationsTable.id, applicationId))
    .returning();

  if (!updated) throw new Error('Update returned no rows');

  recordAuditEvent({
    actorId: userId,
    action: 'loan_application.submitted',
    entityType: 'loan_application',
    entityId: applicationId,
  });

  return updated;
}

export async function approveLoanApplication(
  applicationId: string,
  actorId: string,
  actorRole: Role,
  opts: {
    approvedAmount: string;
    approvedTenorMonths: number;
    disbursementDate: string;
  },
): Promise<LoanApplication> {
  if (!hasPermission(actorRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to approve loan applications');
  }

  const amount = parseFloat(opts.approvedAmount);
  if (isNaN(amount) || amount <= 0) throw new BadRequestError('Nominal pembiayaan tidak valid');
  if (opts.approvedTenorMonths < 1 || opts.approvedTenorMonths > 120) {
    throw new BadRequestError('Tenor tidak valid');
  }

  const db = getDb();

  const [app] = await db
    .select()
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.id, applicationId))
    .limit(1);

  if (!app) throw new NotFoundError('Pengajuan tidak ditemukan');
  if (app.status !== 'IN_REVIEW' && app.status !== 'SUBMITTED') {
    throw new BadRequestError(`Pengajuan tidak dapat disetujui dari status ${app.status}`);
  }

  const [updated] = await db
    .update(loanApplicationsTable)
    .set({
      status: 'APPROVED',
      approvedBy: actorId,
      approvedAt: new Date(),
      approvedAmount: opts.approvedAmount,
      approvedTenorMonths: opts.approvedTenorMonths,
      disbursementDate: opts.disbursementDate,
      updatedAt: new Date(),
    })
    .where(eq(loanApplicationsTable.id, applicationId))
    .returning();

  if (!updated) throw new Error('Update returned no rows');

  recordAuditEvent({
    actorId,
    action: 'loan_application.approved',
    entityType: 'loan_application',
    entityId: applicationId,
    metadata: {
      approvedAmount: opts.approvedAmount,
      tenor: opts.approvedTenorMonths,
      disbursementDate: opts.disbursementDate,
    },
  });

  return updated;
}

export async function getLoanApplicationsByStudent(userId: string): Promise<LoanApplication[]> {
  const db = getDb();
  const profile = await getStudentProfile(userId);
  if (!profile) return [];

  return db
    .select()
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.studentId, profile.id))
    .orderBy(desc(loanApplicationsTable.createdAt));
}

// ---------------------------------------------------------------------------
// Loan Agreement & Installment Schedule
// ---------------------------------------------------------------------------

/**
 * Generate installment schedule for a loan agreement.
 *
 * Uses integer arithmetic (stored as NUMERIC) to avoid floating-point errors.
 * Last installment absorbs any rounding remainder so total = principalAmount exactly.
 */
export function generateInstallmentSchedule(
  principalAmount: string,
  tenorMonths: number,
  firstPaymentDate: string,
): Array<{ installmentNumber: number; dueDate: string; principalAmount: string; isFinalInstallment: boolean }> {
  // Use integer centesimal arithmetic: multiply by 100 to work in "sen" (hundredths of rupiah)
  const totalSen = Math.round(parseFloat(principalAmount) * 100);
  const baseSen = Math.floor(totalSen / tenorMonths);
  const remainderSen = totalSen - baseSen * tenorMonths;

  const schedule = [];
  let current = new Date(firstPaymentDate);

  for (let i = 1; i <= tenorMonths; i++) {
    // Last installment gets the remainder
    const senThisMonth = i === tenorMonths ? baseSen + remainderSen : baseSen;
    const isFinal = i === tenorMonths;

    // Format as YYYY-MM-DD
    const dueDate = current.toISOString().slice(0, 10);
    // Amount as NUMERIC string (2 decimal places)
    const amount = (senThisMonth / 100).toFixed(2);

    schedule.push({
      installmentNumber: i,
      dueDate,
      principalAmount: amount,
      isFinalInstallment: isFinal,
    });

    // Advance to next month (same day)
    const nextDate = new Date(current);
    nextDate.setMonth(nextDate.getMonth() + 1);
    current = nextDate;
  }

  return schedule;
}

export async function createLoanAgreementWithSchedule(
  loanApplicationId: string,
  actorId: string,
  actorRole: Role,
  opts: {
    agreementNumber: string;
    principalAmount: string;
    tenorMonths: number;
    disbursementDate: string;
    firstPaymentDate: string;
  },
): Promise<{ agreement: LoanAgreement; installments: LoanInstallmentSchedule[] }> {
  if (!hasPermission(actorRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to create loan agreements');
  }

  const db = getDb();

  // Get the loan application
  const [loanApp] = await db
    .select()
    .from(loanApplicationsTable)
    .where(eq(loanApplicationsTable.id, loanApplicationId))
    .limit(1);

  if (!loanApp) throw new NotFoundError('Loan application not found');
  if (loanApp.status !== 'APPROVED') {
    throw new BadRequestError('Pengajuan pinjaman belum disetujui');
  }

  // Create the agreement and schedule in a transaction
  return await db.transaction(async (tx) => {
    const [agreement] = await tx
      .insert(loanAgreementsTable)
      .values({
        loanApplicationId,
        studentId: loanApp.studentId,
        agreementNumber: opts.agreementNumber,
        principalAmount: opts.principalAmount,
        tenorMonths: opts.tenorMonths,
        disbursementDate: opts.disbursementDate,
        firstPaymentDate: opts.firstPaymentDate,
        status: 'AWAITING_ACCEPTANCE',
        isSimulation: true,
        createdBy: actorId,
      })
      .returning();

    if (!agreement) throw new Error('Agreement insert returned no rows');

    // Generate installment schedule
    const schedule = generateInstallmentSchedule(
      opts.principalAmount,
      opts.tenorMonths,
      opts.firstPaymentDate,
    );

    const installments = await tx
      .insert(loanInstallmentSchedulesTable)
      .values(
        schedule.map((item) => ({
          agreementId: agreement.id,
          studentId: loanApp.studentId,
          installmentNumber: item.installmentNumber,
          dueDate: item.dueDate,
          principalAmount: item.principalAmount,
          isFinalInstallment: item.isFinalInstallment,
          status: 'UPCOMING' as const,
          amountPaid: '0',
        })),
      )
      .returning();

    // Update loan application status
    await tx
      .update(loanApplicationsTable)
      .set({ status: 'AGREEMENT_PENDING', updatedAt: new Date() })
      .where(eq(loanApplicationsTable.id, loanApplicationId));

    recordAuditEvent({
      actorId,
      action: 'loan_agreement.created',
      entityType: 'loan_agreement',
      entityId: agreement.id,
      metadata: {
        agreementNumber: opts.agreementNumber,
        principalAmount: opts.principalAmount,
        tenorMonths: opts.tenorMonths,
        isSimulation: true,
      },
    });

    logger.info(
      { agreementId: agreement.id, isSimulation: true },
      'SIMULATION: Loan agreement created — not a real financial instrument',
    );

    return { agreement, installments };
  });
}

export async function getInstallmentsByStudent(userId: string): Promise<LoanInstallmentSchedule[]> {
  const db = getDb();
  const profile = await getStudentProfile(userId);
  if (!profile) return [];

  return db
    .select()
    .from(loanInstallmentSchedulesTable)
    .where(eq(loanInstallmentSchedulesTable.studentId, profile.id))
    .orderBy(loanInstallmentSchedulesTable.dueDate);
}

// ---------------------------------------------------------------------------
// Payment Submissions (private bucket — NOT public)
// ---------------------------------------------------------------------------

export interface PaymentSubmissionInput {
  installmentId: string;
  paymentAmount: string;
  paymentDate: string;
  paymentMethod: 'BANK_TRANSFER' | 'CASH' | 'OTHER';
  referenceNumber?: string;
  notes?: string;
  proofStorageKey: string;
  proofOriginalName: string;
  proofMimeType: string;
}

export async function submitPayment(
  input: PaymentSubmissionInput,
  userId: string,
): Promise<LoanPaymentSubmission> {
  const db = getDb();

  const profile = await getStudentProfile(userId);
  if (!profile) throw new ForbiddenError('Student profile required');

  // Verify the installment belongs to this student
  const [installment] = await db
    .select()
    .from(loanInstallmentSchedulesTable)
    .where(
      and(
        eq(loanInstallmentSchedulesTable.id, input.installmentId),
        eq(loanInstallmentSchedulesTable.studentId, profile.id),
      ),
    )
    .limit(1);

  if (!installment) throw new NotFoundError('Tagihan tidak ditemukan atau bukan milik Anda');
  if (installment.status === 'PAID' || installment.status === 'CANCELLED') {
    throw new BadRequestError('Tagihan ini sudah lunas atau dibatalkan');
  }

  const amount = parseFloat(input.paymentAmount);
  if (isNaN(amount) || amount <= 0) throw new BadRequestError('Nominal pembayaran tidak valid');

  const [submission] = await db
    .insert(loanPaymentSubmissionsTable)
    .values({
      installmentId: input.installmentId,
      studentId: profile.id,
      submittedBy: userId,
      paymentAmount: input.paymentAmount,
      paymentDate: input.paymentDate,
      paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      proofStorageKey: input.proofStorageKey,
      proofOriginalName: input.proofOriginalName,
      proofMimeType: input.proofMimeType,
      status: 'SUBMITTED',
    })
    .returning();

  if (!submission) throw new Error('Payment submission insert returned no rows');

  // Update installment status to PENDING_VERIFICATION
  await db
    .update(loanInstallmentSchedulesTable)
    .set({ status: 'PENDING_VERIFICATION', updatedAt: new Date() })
    .where(eq(loanInstallmentSchedulesTable.id, input.installmentId));

  recordAuditEvent({
    actorId: userId,
    action: 'loan_payment.submitted',
    entityType: 'loan_payment_submission',
    entityId: submission.id,
    metadata: { installmentId: input.installmentId, amount: input.paymentAmount },
  });

  return submission;
}

export async function approvePayment(
  submissionId: string,
  actorId: string,
  actorRole: Role,
): Promise<{ submission: LoanPaymentSubmission; installment: LoanInstallmentSchedule }> {
  if (!hasPermission(actorRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to approve payments');
  }

  const db = getDb();

  return await db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(loanPaymentSubmissionsTable)
      .where(eq(loanPaymentSubmissionsTable.id, submissionId))
      .limit(1);

    if (!submission) throw new NotFoundError('Payment submission not found');
    if (submission.status !== 'SUBMITTED' && submission.status !== 'PENDING_VERIFICATION') {
      throw new BadRequestError('Payment cannot be approved in current status');
    }

    const [installment] = await tx
      .select()
      .from(loanInstallmentSchedulesTable)
      .where(eq(loanInstallmentSchedulesTable.id, submission.installmentId))
      .limit(1);

    if (!installment) throw new NotFoundError('Installment not found');

    // Calculate new amount paid — ONLY after admin approval
    const currentPaid = parseFloat(installment.amountPaid);
    const newPayment = parseFloat(submission.paymentAmount);
    const newTotalPaid = currentPaid + newPayment;
    const principalAmount = parseFloat(installment.principalAmount);

    let newStatus: string;
    if (newTotalPaid >= principalAmount) {
      newStatus = 'PAID';
    } else if (newTotalPaid > 0) {
      newStatus = 'PARTIALLY_PAID';
    } else {
      newStatus = installment.status;
    }

    const [updatedSubmission] = await tx
      .update(loanPaymentSubmissionsTable)
      .set({
        status: 'APPROVED',
        verifiedBy: actorId,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(loanPaymentSubmissionsTable.id, submissionId))
      .returning();

    const [updatedInstallment] = await tx
      .update(loanInstallmentSchedulesTable)
      .set({
        amountPaid: newTotalPaid.toFixed(2),
        status: newStatus,
        paidAt: newStatus === 'PAID' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(loanInstallmentSchedulesTable.id, submission.installmentId))
      .returning();

    if (!updatedSubmission || !updatedInstallment) throw new Error('Update returned no rows');

    recordAuditEvent({
      actorId,
      action: 'loan_payment.approved',
      entityType: 'loan_payment_submission',
      entityId: submissionId,
      metadata: {
        installmentId: submission.installmentId,
        amount: submission.paymentAmount,
        newTotalPaid: newTotalPaid.toFixed(2),
        newStatus,
      },
    });

    return { submission: updatedSubmission, installment: updatedInstallment };
  });
}

export async function rejectPayment(
  submissionId: string,
  actorId: string,
  actorRole: Role,
  reason: string,
): Promise<LoanPaymentSubmission> {
  if (!hasPermission(actorRole, 'application:approve')) {
    throw new ForbiddenError('Insufficient permissions to reject payments');
  }
  if (!reason.trim()) throw new BadRequestError('Reason for rejection is required');

  const db = getDb();

  return await db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(loanPaymentSubmissionsTable)
      .where(eq(loanPaymentSubmissionsTable.id, submissionId))
      .limit(1);

    if (!submission) throw new NotFoundError('Payment submission not found');
    if (submission.status !== 'SUBMITTED' && submission.status !== 'PENDING_VERIFICATION') {
      throw new BadRequestError('Payment cannot be rejected in current status');
    }

    const [updatedSubmission] = await tx
      .update(loanPaymentSubmissionsTable)
      .set({
        status: 'REJECTED',
        verifiedBy: actorId,
        verifiedAt: new Date(),
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(loanPaymentSubmissionsTable.id, submissionId))
      .returning();

    if (!updatedSubmission) throw new Error('Update returned no rows');

    // Revert installment back to UNPAID (or appropriate previous status)
    await tx
      .update(loanInstallmentSchedulesTable)
      .set({ status: 'UNPAID', updatedAt: new Date() })
      .where(eq(loanInstallmentSchedulesTable.id, submission.installmentId));

    recordAuditEvent({
      actorId,
      action: 'loan_payment.rejected',
      entityType: 'loan_payment_submission',
      entityId: submissionId,
      metadata: { reason },
    });

    return updatedSubmission;
  });
}

export async function listPendingPayments(
  actorRole: Role,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ payments: LoanPaymentSubmission[]; total: number }> {
  if (!hasPermission(actorRole, 'application:review')) {
    throw new ForbiddenError('Insufficient permissions');
  }

  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  // Return SUBMITTED or PENDING_VERIFICATION submissions
  const whereClause = or(
    eq(loanPaymentSubmissionsTable.status, 'SUBMITTED'),
    eq(loanPaymentSubmissionsTable.status, 'PENDING_VERIFICATION'),
  );

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(loanPaymentSubmissionsTable)
    .where(whereClause);

  const total = countResult?.count ?? 0;

  const payments = await db
    .select()
    .from(loanPaymentSubmissionsTable)
    .where(whereClause)
    .orderBy(desc(loanPaymentSubmissionsTable.createdAt))
    .limit(limit)
    .offset(offset);

  return { payments, total };
}
