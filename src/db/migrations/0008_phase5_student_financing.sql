-- ISF Platform — Phase 4 (Phase 3 of new work) migration
-- Student profiles, scholarship programs & applications, student loan system
--
-- IMPORTANT NOTES:
-- 1. Scholarship grants are NOT piutang (receivables) — they are grants.
-- 2. Student loans ARE piutang — the amount must be repaid per agreement.
-- 3. These two financing types must NEVER be mixed in financial reports.
-- 4. This migration is safe to run on a database that already has ISF tables.
-- 5. No data from existing tables is modified.
--
-- LEGAL NOTE (DEVELOPMENT SIMULATION MODE):
-- The student loan system is in SIMULATION mode until:
--   a) The operating entity's legal status is confirmed
--   b) Applicable financial services regulations are reviewed
--   c) Loan agreements are reviewed by qualified legal counsel
-- Do not process real financial transactions through the simulation system.

-- ---------------------------------------------------------------------------
-- student_profiles
-- Stores student identity and academic information.
-- Created when a USER first accesses a scholarship/loan program.
-- ---------------------------------------------------------------------------
CREATE TABLE student_profiles (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,

  -- Identity (data minimisation: only collect what is necessary)
  full_name         TEXT        NOT NULL,
  phone_number      TEXT,
  address           TEXT,
  city              TEXT,
  province          TEXT,
  date_of_birth     DATE,

  -- Academic information
  university_name   TEXT,
  faculty           TEXT,
  study_program     TEXT,
  degree_level      TEXT        CHECK (degree_level IN ('D3', 'D4', 'S1', 'S2', 'S3', 'Profesi')),
  student_id_number TEXT,       -- NIM
  current_semester  INT         CHECK (current_semester > 0 AND current_semester <= 20),
  enrollment_year   INT         CHECK (enrollment_year >= 2000 AND enrollment_year <= 2100),
  student_status    TEXT        NOT NULL DEFAULT 'ACTIVE'
                                CHECK (student_status IN ('ACTIVE', 'INACTIVE', 'GRADUATED', 'DROPPED')),

  -- Verification status
  verification_status TEXT      NOT NULL DEFAULT 'INCOMPLETE'
                                CHECK (verification_status IN (
                                  'INCOMPLETE',
                                  'PENDING_VERIFICATION',
                                  'VERIFIED',
                                  'CHANGES_REQUESTED'
                                )),
  verified_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  verified_at       TIMESTAMPTZ,
  verification_notes TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX student_profiles_user_idx      ON student_profiles (user_id);
CREATE INDEX student_profiles_status_idx    ON student_profiles (verification_status);
CREATE INDEX student_profiles_university_idx ON student_profiles (university_name);

-- ---------------------------------------------------------------------------
-- student_documents
-- Document uploads for student profile verification.
-- All documents stored in private bucket (never public).
-- ---------------------------------------------------------------------------
CREATE TABLE student_documents (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id      UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  document_type   TEXT        NOT NULL
                              CHECK (document_type IN (
                                'STUDENT_ID_CARD',
                                'ACTIVE_STUDENT_PROOF',
                                'ACADEMIC_TRANSCRIPT',
                                'OTHER'
                              )),
  storage_key     TEXT        NOT NULL, -- object key in private bucket
  original_name   TEXT        NOT NULL,
  mime_type       TEXT        NOT NULL,
  file_size_bytes INT         NOT NULL,
  uploaded_by     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX student_documents_student_idx  ON student_documents (student_id, document_type);

-- ---------------------------------------------------------------------------
-- scholarship_programs
-- Defines ISF scholarship programs (Full, Partial, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE scholarship_programs (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT        NOT NULL,
  slug            TEXT        NOT NULL UNIQUE,
  description     TEXT        NOT NULL DEFAULT '',
  program_type    TEXT        NOT NULL DEFAULT 'SCHOLARSHIP'
                              CHECK (program_type IN ('SCHOLARSHIP', 'PARTIAL_SCHOLARSHIP', 'OTHER')),
  -- Coverage percentage (100 = full scholarship, 70 = 70% scholarship, etc.)
  coverage_pct    NUMERIC(5,2) NOT NULL DEFAULT 100
                              CHECK (coverage_pct > 0 AND coverage_pct <= 100),
  -- Optional fixed amount override (if set, overrides coverage_pct calculation)
  fixed_amount    NUMERIC(15,2),
  currency        CHAR(3)     NOT NULL DEFAULT 'IDR',
  -- Requirements text (markdown)
  requirements    TEXT,
  -- Academic year / batch
  batch           TEXT,
  -- Application period
  app_open_date   DATE,
  app_close_date  DATE,
  -- Status
  status          TEXT        NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED')),
  created_by      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX scholarship_programs_status_idx ON scholarship_programs (status);

-- ---------------------------------------------------------------------------
-- scholarship_applications
-- Student applications for scholarship programs.
-- ---------------------------------------------------------------------------
CREATE TABLE scholarship_applications (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  program_id      UUID        NOT NULL REFERENCES scholarship_programs(id) ON DELETE RESTRICT,
  student_id      UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  submitted_by    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Application details
  academic_year   TEXT        NOT NULL,
  semester        INT         NOT NULL CHECK (semester > 0),
  motivation_text TEXT,
  supporting_docs JSONB       NOT NULL DEFAULT '[]',

  -- Workflow
  status          TEXT        NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN (
                                'DRAFT',
                                'SUBMITTED',
                                'IN_REVIEW',
                                'APPROVED',
                                'REJECTED',
                                'CANCELLED'
                              )),
  reviewer_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes  TEXT,
  reviewed_at     TIMESTAMPTZ,
  approved_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,

  -- Approved grant details (set upon approval)
  approved_amount NUMERIC(15,2),
  coverage_pct_actual NUMERIC(5,2),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate submissions
  CONSTRAINT scholarship_applications_unique_active
    UNIQUE NULLS NOT DISTINCT (program_id, student_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX scholarship_applications_program_idx ON scholarship_applications (program_id);
CREATE INDEX scholarship_applications_student_idx ON scholarship_applications (student_id);
CREATE INDEX scholarship_applications_status_idx  ON scholarship_applications (status);

-- ---------------------------------------------------------------------------
-- loan_applications
-- Student applications for ISF student loans (financing).
-- SIMULATION MODE: No real financial disbursement until legal review complete.
-- ---------------------------------------------------------------------------
CREATE TABLE loan_applications (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id      UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  submitted_by    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Academic context
  university_name TEXT        NOT NULL,
  study_program   TEXT        NOT NULL,
  semester        INT         NOT NULL CHECK (semester > 0),
  academic_year   TEXT        NOT NULL,

  -- Requested financing
  requested_amount    NUMERIC(15,2) NOT NULL CHECK (requested_amount > 0),
  requested_tenor_months INT   NOT NULL CHECK (requested_tenor_months > 0 AND requested_tenor_months <= 120),
  purpose_description TEXT    NOT NULL,
  estimated_costs     JSONB   NOT NULL DEFAULT '[]',

  -- Workflow status
  status          TEXT        NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN (
                                'DRAFT',
                                'SUBMITTED',
                                'IN_REVIEW',
                                'APPROVED',
                                'REJECTED',
                                'CANCELLED',
                                'AGREEMENT_PENDING',
                                'ACTIVE',
                                'COMPLETED'
                              )),
  reviewer_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes  TEXT,
  reviewed_at     TIMESTAMPTZ,
  approved_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,

  -- Final approved terms (set by ISF upon approval)
  approved_amount         NUMERIC(15,2),
  approved_tenor_months   INT     CHECK (approved_tenor_months > 0),
  disbursement_date       DATE,

  -- Simulation flag: always true until legal clearance
  is_simulation   BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX loan_applications_student_idx ON loan_applications (student_id);
CREATE INDEX loan_applications_status_idx  ON loan_applications (status);

-- ---------------------------------------------------------------------------
-- loan_agreements
-- Formal financing agreements between ISF and students.
-- SIMULATION MODE: Contracts not legally binding until reviewed by counsel.
-- ---------------------------------------------------------------------------
CREATE TABLE loan_agreements (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  loan_application_id UUID        NOT NULL UNIQUE REFERENCES loan_applications(id) ON DELETE RESTRICT,
  student_id          UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  agreement_number    TEXT        NOT NULL UNIQUE,

  -- Agreed financing terms
  principal_amount    NUMERIC(15,2) NOT NULL CHECK (principal_amount > 0),
  tenor_months        INT         NOT NULL CHECK (tenor_months > 0 AND tenor_months <= 120),
  disbursement_date   DATE        NOT NULL,
  first_payment_date  DATE        NOT NULL,

  -- Status
  status              TEXT        NOT NULL DEFAULT 'DRAFT'
                                  CHECK (status IN (
                                    'DRAFT',
                                    'AWAITING_ACCEPTANCE',
                                    'ACCEPTED',
                                    'ACTIVE',
                                    'COMPLETED',
                                    'CANCELLED'
                                  )),
  accepted_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  accepted_at         TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Simulation mode flag
  is_simulation       BOOLEAN     NOT NULL DEFAULT TRUE,

  created_by          UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX loan_agreements_student_idx   ON loan_agreements (student_id);
CREATE INDEX loan_agreements_status_idx    ON loan_agreements (status);

-- ---------------------------------------------------------------------------
-- loan_installment_schedules
-- Automatically generated repayment schedule per agreement.
-- Immutable after creation — corrections use reversal records.
-- ---------------------------------------------------------------------------
CREATE TABLE loan_installment_schedules (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agreement_id        UUID        NOT NULL REFERENCES loan_agreements(id) ON DELETE RESTRICT,
  student_id          UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,

  installment_number  INT         NOT NULL CHECK (installment_number > 0),
  due_date            DATE        NOT NULL,
  -- Principal amount due for this installment (INTEGER centesimal for precision)
  -- Stored as NUMERIC to avoid floating-point errors
  principal_amount    NUMERIC(15,2) NOT NULL CHECK (principal_amount >= 0),
  -- Last installment may differ due to rounding adjustment
  is_final_installment BOOLEAN    NOT NULL DEFAULT FALSE,

  -- Status
  status              TEXT        NOT NULL DEFAULT 'UPCOMING'
                                  CHECK (status IN (
                                    'UPCOMING',
                                    'UNPAID',
                                    'PARTIALLY_PAID',
                                    'PENDING_VERIFICATION',
                                    'PAID',
                                    'OVERDUE',
                                    'CANCELLED'
                                  )),

  -- Payments applied
  amount_paid         NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  paid_at             TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT installment_unique_per_agreement UNIQUE (agreement_id, installment_number)
);

CREATE INDEX installment_agreement_idx ON loan_installment_schedules (agreement_id);
CREATE INDEX installment_student_idx   ON loan_installment_schedules (student_id, status);
CREATE INDEX installment_due_date_idx  ON loan_installment_schedules (due_date, status);

-- ---------------------------------------------------------------------------
-- loan_payment_submissions
-- Student-submitted payment proofs for installment repayments.
-- Documents stored in PRIVATE bucket — NEVER public.
-- IMPORTANT: Payment is only confirmed after admin verification.
-- ---------------------------------------------------------------------------
CREATE TABLE loan_payment_submissions (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  installment_id      UUID        NOT NULL REFERENCES loan_installment_schedules(id) ON DELETE RESTRICT,
  student_id          UUID        NOT NULL REFERENCES student_profiles(id) ON DELETE RESTRICT,
  submitted_by        UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Payment details provided by student
  payment_amount      NUMERIC(15,2) NOT NULL CHECK (payment_amount > 0),
  payment_date        DATE        NOT NULL,
  payment_method      TEXT        NOT NULL
                                  CHECK (payment_method IN (
                                    'BANK_TRANSFER',
                                    'CASH',
                                    'OTHER'
                                  )),
  reference_number    TEXT,
  notes               TEXT,

  -- Proof document (stored in private bucket)
  proof_storage_key   TEXT        NOT NULL,
  proof_original_name TEXT        NOT NULL,
  proof_mime_type     TEXT        NOT NULL,

  -- Verification workflow
  status              TEXT        NOT NULL DEFAULT 'SUBMITTED'
                                  CHECK (status IN (
                                    'SUBMITTED',
                                    'PENDING_VERIFICATION',
                                    'APPROVED',
                                    'REJECTED',
                                    'REVERSED'
                                  )),
  verified_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  reversal_reason     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX loan_payment_submissions_installment_idx ON loan_payment_submissions (installment_id);
CREATE INDEX loan_payment_submissions_student_idx     ON loan_payment_submissions (student_id);
CREATE INDEX loan_payment_submissions_status_idx      ON loan_payment_submissions (status);

-- ---------------------------------------------------------------------------
-- Audit log entries for financial operations
-- Extends the existing audit_logs table conventions.
-- Specific constraint: only verified payments reduce loan balance.
-- ---------------------------------------------------------------------------

-- Constraint: prevent balance going below zero
-- Enforced in application layer; database stores transactions append-only.
-- See application service for balance calculation logic.
