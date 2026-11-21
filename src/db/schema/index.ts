/**
 * Database schema — Phase 1 & Phase 2: Users, Sessions, Audit Logs, CMS
 *
 * All tables use:
 * - UUID primary keys (gen_random_uuid via pgcrypto)
 * - TIMESTAMPTZ (never plain TIMESTAMP — all timestamps must be timezone-aware)
 * - snake_case column names
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  inet,
  primaryKey,
  date,
  integer,
  char,
  numeric,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const usersTable = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull().default(''),
    role: text('role').notNull().default('USER'),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (t) => [
    // Partial unique index: email uniqueness only among non-deleted accounts.
    // The full partial index (WHERE deleted_at IS NULL) is in the SQL migration.
    // Drizzle schema uses a plain unique index for type-checking purposes.
    uniqueIndex('users_email_unique').on(t.email),
    index('users_email_idx').on(t.email),
    index('users_role_idx').on(t.role),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;

// ---------------------------------------------------------------------------
// sessions — connect-pg-simple compatible
// Drizzle schema mirrors the table created by the SQL migration.
// connect-pg-simple manages this table directly; we declare it for type safety.
// ---------------------------------------------------------------------------

export const sessionsTable = pgTable(
  'sessions',
  {
    sid: text('sid').primaryKey(),
    sess: jsonb('sess').notNull(),
    expire: timestamp('expire', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('sessions_expire_idx').on(t.expire)],
);

// ---------------------------------------------------------------------------
// audit_logs
// ---------------------------------------------------------------------------

export const auditLogsTable = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogsTable.$inferSelect;
export type NewAuditLog = typeof auditLogsTable.$inferInsert;

// ---------------------------------------------------------------------------
// email_verification_tokens
// ---------------------------------------------------------------------------

export const emailVerificationTokensTable = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('evt_user_id_idx').on(t.userId),
    index('evt_expires_at_idx').on(t.expiresAt),
  ],
);

export type EmailVerificationToken = typeof emailVerificationTokensTable.$inferSelect;

// ---------------------------------------------------------------------------
// password_reset_tokens
// ---------------------------------------------------------------------------

export const passwordResetTokensTable = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('prt_user_id_idx').on(t.userId),
    index('prt_expires_at_idx').on(t.expiresAt),
  ],
);

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------

export const invitationsTable = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    role: text('role').notNull().default('USER'),
    invitedBy: uuid('invited_by'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    acceptedBy: uuid('accepted_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: uuid('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('inv_token_hash_idx').on(t.tokenHash),
    index('inv_email_idx').on(t.email),
    index('inv_invited_by_idx').on(t.invitedBy),
    index('inv_expires_at_idx').on(t.expiresAt),
  ],
);

export type Invitation = typeof invitationsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 2 — CMS: categories, tags, articles, article_revisions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export const categoriesTable = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_unique').on(t.slug),
    index('categories_name_idx').on(t.name),
  ],
);

export type Category = typeof categoriesTable.$inferSelect;
export type NewCategory = typeof categoriesTable.$inferInsert;

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export const tagsTable = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('tags_slug_unique').on(t.slug),
    index('tags_name_idx').on(t.name),
  ],
);

export type Tag = typeof tagsTable.$inferSelect;
export type NewTag = typeof tagsTable.$inferInsert;

// ---------------------------------------------------------------------------
// articles
// Status workflow:
//   DRAFT → IN_REVIEW → CHANGES_REQUESTED → IN_REVIEW → APPROVED → PUBLISHED → ARCHIVED
// ---------------------------------------------------------------------------

export const ARTICLE_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const articlesTable = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    /**
     * Free-text display name for the article author shown on public pages.
     * NULL means "fall back to the linked user's displayName".
     * The authorId FK is always the canonical author for access control.
     */
    authorDisplayName: text('author_display_name'),
    /** Raw Tiptap JSON document — the source of truth for editing */
    bodyTiptap: jsonb('body_tiptap').notNull().default({}),
    /** Server-rendered, sanitised HTML — for public display only */
    bodyHtml: text('body_html').notNull().default(''),
    coverImageUrl: text('cover_image_url'),
    status: text('status').notNull().default('DRAFT'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    reviewerId: uuid('reviewer_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    reviewerNotes: text('reviewer_notes'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('articles_slug_unique').on(t.slug),
    index('articles_status_idx').on(t.status),
    index('articles_author_idx').on(t.authorId),
    index('articles_published_at_idx').on(t.publishedAt),
    index('articles_created_at_idx').on(t.createdAt),
  ],
);

export type Article = typeof articlesTable.$inferSelect;
export type NewArticle = typeof articlesTable.$inferInsert;

// ---------------------------------------------------------------------------
// article_categories (many-to-many)
// ---------------------------------------------------------------------------

export const articleCategoriesTable = pgTable(
  'article_categories',
  {
    articleId: uuid('article_id')
      .notNull()
      .references(() => articlesTable.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categoriesTable.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.categoryId] })],
);

// ---------------------------------------------------------------------------
// article_tags (many-to-many)
// ---------------------------------------------------------------------------

export const articleTagsTable = pgTable(
  'article_tags',
  {
    articleId: uuid('article_id')
      .notNull()
      .references(() => articlesTable.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.tagId] })],
);

// ---------------------------------------------------------------------------
// article_revisions (append-only history)
// ---------------------------------------------------------------------------

export const articleRevisionsTable = pgTable(
  'article_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articlesTable.id, { onDelete: 'cascade' }),
    /** Full snapshot of article state at save time */
    snapshot: jsonb('snapshot').notNull(),
    revisedBy: uuid('revised_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    revisionNote: text('revision_note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('article_revisions_article_idx').on(t.articleId, t.createdAt),
    index('article_revisions_revised_by_idx').on(t.revisedBy),
  ],
);

export type ArticleRevision = typeof articleRevisionsTable.$inferSelect;
export type NewArticleRevision = typeof articleRevisionsTable.$inferInsert;

// ---------------------------------------------------------------------------
// Phase 3 — Fundraising: campaigns, payment_records, donations, webhook_events
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// ---------------------------------------------------------------------------
// campaigns
// ---------------------------------------------------------------------------

export const campaignsTable = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    beneficiary: text('beneficiary').notNull().default(''),
    goalAmount: text('goal_amount').notNull(), // stored as text for NUMERIC type
    currency: text('currency').notNull().default('IDR'),
    startDate: text('start_date'), // DATE stored as text
    endDate: text('end_date'),
    coverImageUrl: text('cover_image_url'),
    status: text('status').notNull().default('DRAFT'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    reviewerId: uuid('reviewer_id').references(() => usersTable.id, { onDelete: 'set null' }),
    reviewerNotes: text('reviewer_notes'),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedBy: uuid('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
    launchedAt: timestamp('launched_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('campaigns_slug_unique').on(t.slug),
    index('campaigns_status_idx').on(t.status),
    index('campaigns_created_by_idx').on(t.createdBy),
    index('campaigns_created_at_idx').on(t.createdAt),
  ],
);

export type Campaign = typeof campaignsTable.$inferSelect;
export type NewCampaign = typeof campaignsTable.$inferInsert;

// ---------------------------------------------------------------------------
// payment_records
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const paymentRecordsTable = pgTable(
  'payment_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gateway: text('gateway').notNull(),
    gatewayTxRef: text('gateway_tx_ref').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    amount: text('amount').notNull(), // NUMERIC stored as text
    currency: text('currency').notNull().default('IDR'),
    method: text('method'),
    status: text('status').notNull().default('PENDING'),
    gatewayPayload: jsonb('gateway_payload'),
    paymentUrl: text('payment_url'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_records_idempotency_idx').on(t.idempotencyKey),
    index('payment_records_gateway_tx_idx').on(t.gateway, t.gatewayTxRef),
    index('payment_records_status_idx').on(t.status),
  ],
);

export type PaymentRecord = typeof paymentRecordsTable.$inferSelect;
export type NewPaymentRecord = typeof paymentRecordsTable.$inferInsert;

// ---------------------------------------------------------------------------
// donations
// ---------------------------------------------------------------------------

export const donationsTable = pgTable(
  'donations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaignsTable.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => usersTable.id, { onDelete: 'set null' }),
    donorName: text('donor_name'),
    donorEmail: text('donor_email'),
    isAnonymous: boolean('is_anonymous').notNull().default(false),
    amount: text('amount').notNull(), // NUMERIC stored as text
    currency: text('currency').notNull().default('IDR'),
    status: text('status').notNull().default('PENDING'),
    paymentRecordId: uuid('payment_record_id').references(() => paymentRecordsTable.id, {
      onDelete: 'set null',
    }),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('donations_campaign_idx').on(t.campaignId, t.status),
    index('donations_user_idx').on(t.userId),
    index('donations_status_idx').on(t.status),
    index('donations_created_at_idx').on(t.createdAt),
  ],
);

export type Donation = typeof donationsTable.$inferSelect;
export type NewDonation = typeof donationsTable.$inferInsert;

// ---------------------------------------------------------------------------
// webhook_events
// ---------------------------------------------------------------------------

export const webhookEventsTable = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    eventType: text('event_type').notNull(),
    eventId: text('event_id').notNull(),
    payload: jsonb('payload').notNull(),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    processed: boolean('processed').notNull().default(false),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_events_event_id_unique').on(t.eventId),
    index('webhook_events_provider_idx').on(t.provider, t.createdAt),
  ],
);

export type WebhookEvent = typeof webhookEventsTable.$inferSelect;
export type NewWebhookEvent = typeof webhookEventsTable.$inferInsert;

// ===========================================================================
// Phase 5 — Student Financing: profiles, scholarships, loans
// ===========================================================================

// ---------------------------------------------------------------------------
// student_profiles
// ---------------------------------------------------------------------------

export const STUDENT_PROFILE_STATUSES = [
  'INCOMPLETE',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'CHANGES_REQUESTED',
] as const;
export type StudentProfileStatus = (typeof STUDENT_PROFILE_STATUSES)[number];

export const studentProfilesTable = pgTable(
  'student_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    fullName: text('full_name').notNull(),
    phoneNumber: text('phone_number'),
    address: text('address'),
    city: text('city'),
    province: text('province'),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    universityName: text('university_name'),
    faculty: text('faculty'),
    studyProgram: text('study_program'),
    degreeLevel: text('degree_level'),
    studentIdNumber: text('student_id_number'),
    currentSemester: integer('current_semester'),
    enrollmentYear: integer('enrollment_year'),
    studentStatus: text('student_status').notNull().default('ACTIVE'),
    verificationStatus: text('verification_status').notNull().default('INCOMPLETE'),
    verifiedBy: uuid('verified_by').references(() => usersTable.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    verificationNotes: text('verification_notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('student_profiles_user_idx').on(t.userId),
    index('student_profiles_status_idx').on(t.verificationStatus),
  ],
);

export type StudentProfile = typeof studentProfilesTable.$inferSelect;
export type NewStudentProfile = typeof studentProfilesTable.$inferInsert;

// ---------------------------------------------------------------------------
// student_documents
// ---------------------------------------------------------------------------

export const studentDocumentsTable = pgTable(
  'student_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'cascade' }),
    documentType: text('document_type').notNull(),
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('student_documents_student_idx').on(t.studentId, t.documentType),
  ],
);

export type StudentDocument = typeof studentDocumentsTable.$inferSelect;
export type NewStudentDocument = typeof studentDocumentsTable.$inferInsert;

// ---------------------------------------------------------------------------
// scholarship_programs
// ---------------------------------------------------------------------------

export const scholarshipProgramsTable = pgTable(
  'scholarship_programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description').notNull().default(''),
    programType: text('program_type').notNull().default('SCHOLARSHIP'),
    coveragePct: numeric('coverage_pct', { precision: 5, scale: 2 }).notNull().default('100'),
    fixedAmount: numeric('fixed_amount', { precision: 15, scale: 2 }),
    currency: char('currency', { length: 3 }).notNull().default('IDR'),
    requirements: text('requirements'),
    batch: text('batch'),
    appOpenDate: date('app_open_date', { mode: 'string' }),
    appCloseDate: date('app_close_date', { mode: 'string' }),
    status: text('status').notNull().default('DRAFT'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('scholarship_programs_status_idx').on(t.status),
  ],
);

export type ScholarshipProgram = typeof scholarshipProgramsTable.$inferSelect;
export type NewScholarshipProgram = typeof scholarshipProgramsTable.$inferInsert;

// ---------------------------------------------------------------------------
// scholarship_applications
// ---------------------------------------------------------------------------

export const SCHOLARSHIP_APP_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ScholarshipAppStatus = (typeof SCHOLARSHIP_APP_STATUSES)[number];

export const scholarshipApplicationsTable = pgTable(
  'scholarship_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => scholarshipProgramsTable.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'restrict' }),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    academicYear: text('academic_year').notNull(),
    semester: integer('semester').notNull(),
    motivationText: text('motivation_text'),
    supportingDocs: jsonb('supporting_docs').notNull().default([]),
    status: text('status').notNull().default('DRAFT'),
    reviewerId: uuid('reviewer_id').references(() => usersTable.id, { onDelete: 'set null' }),
    reviewerNotes: text('reviewer_notes'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    approvedBy: uuid('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedAmount: numeric('approved_amount', { precision: 15, scale: 2 }),
    coveragePctActual: numeric('coverage_pct_actual', { precision: 5, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('scholarship_applications_program_idx').on(t.programId),
    index('scholarship_applications_student_idx').on(t.studentId),
    index('scholarship_applications_status_idx').on(t.status),
  ],
);

export type ScholarshipApplication = typeof scholarshipApplicationsTable.$inferSelect;
export type NewScholarshipApplication = typeof scholarshipApplicationsTable.$inferInsert;

// ---------------------------------------------------------------------------
// loan_applications
// ---------------------------------------------------------------------------

export const LOAN_APP_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'AGREEMENT_PENDING',
  'ACTIVE',
  'COMPLETED',
] as const;
export type LoanAppStatus = (typeof LOAN_APP_STATUSES)[number];

export const loanApplicationsTable = pgTable(
  'loan_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'restrict' }),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    universityName: text('university_name').notNull(),
    studyProgram: text('study_program').notNull(),
    semester: integer('semester').notNull(),
    academicYear: text('academic_year').notNull(),
    requestedAmount: numeric('requested_amount', { precision: 15, scale: 2 }).notNull(),
    requestedTenorMonths: integer('requested_tenor_months').notNull(),
    purposeDescription: text('purpose_description').notNull(),
    estimatedCosts: jsonb('estimated_costs').notNull().default([]),
    status: text('status').notNull().default('DRAFT'),
    reviewerId: uuid('reviewer_id').references(() => usersTable.id, { onDelete: 'set null' }),
    reviewerNotes: text('reviewer_notes'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    approvedBy: uuid('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedAmount: numeric('approved_amount', { precision: 15, scale: 2 }),
    approvedTenorMonths: integer('approved_tenor_months'),
    disbursementDate: date('disbursement_date', { mode: 'string' }),
    isSimulation: boolean('is_simulation').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('loan_applications_student_idx').on(t.studentId),
    index('loan_applications_status_idx').on(t.status),
  ],
);

export type LoanApplication = typeof loanApplicationsTable.$inferSelect;
export type NewLoanApplication = typeof loanApplicationsTable.$inferInsert;

// ---------------------------------------------------------------------------
// loan_agreements
// ---------------------------------------------------------------------------

export const LOAN_AGREEMENT_STATUSES = [
  'DRAFT',
  'AWAITING_ACCEPTANCE',
  'ACCEPTED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;
export type LoanAgreementStatus = (typeof LOAN_AGREEMENT_STATUSES)[number];

export const loanAgreementsTable = pgTable(
  'loan_agreements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanApplicationId: uuid('loan_application_id')
      .notNull()
      .unique()
      .references(() => loanApplicationsTable.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'restrict' }),
    agreementNumber: text('agreement_number').notNull().unique(),
    principalAmount: numeric('principal_amount', { precision: 15, scale: 2 }).notNull(),
    tenorMonths: integer('tenor_months').notNull(),
    disbursementDate: date('disbursement_date', { mode: 'string' }).notNull(),
    firstPaymentDate: date('first_payment_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('DRAFT'),
    acceptedBy: uuid('accepted_by').references(() => usersTable.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancellationReason: text('cancellation_reason'),
    isSimulation: boolean('is_simulation').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('loan_agreements_student_idx').on(t.studentId),
    index('loan_agreements_status_idx').on(t.status),
  ],
);

export type LoanAgreement = typeof loanAgreementsTable.$inferSelect;
export type NewLoanAgreement = typeof loanAgreementsTable.$inferInsert;

// ---------------------------------------------------------------------------
// loan_installment_schedules
// ---------------------------------------------------------------------------

export const INSTALLMENT_STATUSES = [
  'UPCOMING',
  'UNPAID',
  'PARTIALLY_PAID',
  'PENDING_VERIFICATION',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export const loanInstallmentSchedulesTable = pgTable(
  'loan_installment_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agreementId: uuid('agreement_id')
      .notNull()
      .references(() => loanAgreementsTable.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'restrict' }),
    installmentNumber: integer('installment_number').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    principalAmount: numeric('principal_amount', { precision: 15, scale: 2 }).notNull(),
    isFinalInstallment: boolean('is_final_installment').notNull().default(false),
    status: text('status').notNull().default('UPCOMING'),
    amountPaid: numeric('amount_paid', { precision: 15, scale: 2 }).notNull().default('0'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('installment_unique_per_agreement').on(t.agreementId, t.installmentNumber),
    index('installment_agreement_idx').on(t.agreementId),
    index('installment_student_idx').on(t.studentId, t.status),
    index('installment_due_date_idx').on(t.dueDate, t.status),
  ],
);

export type LoanInstallmentSchedule = typeof loanInstallmentSchedulesTable.$inferSelect;
export type NewLoanInstallmentSchedule = typeof loanInstallmentSchedulesTable.$inferInsert;

// ---------------------------------------------------------------------------
// loan_payment_submissions
// ---------------------------------------------------------------------------

export const PAYMENT_SUBMISSION_STATUSES = [
  'SUBMITTED',
  'PENDING_VERIFICATION',
  'APPROVED',
  'REJECTED',
  'REVERSED',
] as const;
export type PaymentSubmissionStatus = (typeof PAYMENT_SUBMISSION_STATUSES)[number];

export const loanPaymentSubmissionsTable = pgTable(
  'loan_payment_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    installmentId: uuid('installment_id')
      .notNull()
      .references(() => loanInstallmentSchedulesTable.id, { onDelete: 'restrict' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => studentProfilesTable.id, { onDelete: 'restrict' }),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    paymentAmount: numeric('payment_amount', { precision: 15, scale: 2 }).notNull(),
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    paymentMethod: text('payment_method').notNull(),
    referenceNumber: text('reference_number'),
    notes: text('notes'),
    proofStorageKey: text('proof_storage_key').notNull(),
    proofOriginalName: text('proof_original_name').notNull(),
    proofMimeType: text('proof_mime_type').notNull(),
    status: text('status').notNull().default('SUBMITTED'),
    verifiedBy: uuid('verified_by').references(() => usersTable.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    rejectionReason: text('rejection_reason'),
    reversalReason: text('reversal_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('loan_payment_submissions_installment_idx').on(t.installmentId),
    index('loan_payment_submissions_student_idx').on(t.studentId),
    index('loan_payment_submissions_status_idx').on(t.status),
  ],
);

export type LoanPaymentSubmission = typeof loanPaymentSubmissionsTable.$inferSelect;
export type NewLoanPaymentSubmission = typeof loanPaymentSubmissionsTable.$inferInsert;
