-- ISF Platform — Phase 3 (Fundraising) migration: campaigns, donations, payments
-- Creates: campaigns, payment_records, donations, webhook_events tables
-- ORDER: payment_records must come before donations (FK dependency)

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug            TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  description     TEXT        NOT NULL DEFAULT '',
  beneficiary     TEXT        NOT NULL DEFAULT '',
  goal_amount     NUMERIC(15,2) NOT NULL CHECK (goal_amount > 0),
  currency        CHAR(3)     NOT NULL DEFAULT 'IDR',
  start_date      DATE,
  end_date        DATE,
  cover_image_url TEXT,
  status          TEXT        NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN (
                                'DRAFT',
                                'IN_REVIEW',
                                'CHANGES_REQUESTED',
                                'APPROVED',
                                'SCHEDULED',
                                'ACTIVE',
                                'PAUSED',
                                'COMPLETED',
                                'CANCELLED'
                              )),
  created_by      UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  reviewer_notes  TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  launched_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX campaigns_slug_unique ON campaigns (slug) WHERE deleted_at IS NULL;
CREATE INDEX campaigns_status_idx      ON campaigns (status);
CREATE INDEX campaigns_created_by_idx  ON campaigns (created_by);
CREATE INDEX campaigns_created_at_idx  ON campaigns (created_at DESC);

-- ---------------------------------------------------------------------------
-- payment_records (must come before donations — FK dependency)
-- ---------------------------------------------------------------------------
CREATE TABLE payment_records (
  id                  UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  gateway             TEXT          NOT NULL,
  gateway_tx_ref      TEXT          NOT NULL,
  idempotency_key     TEXT          NOT NULL UNIQUE,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency            CHAR(3)       NOT NULL DEFAULT 'IDR',
  method              TEXT,
  status              TEXT          NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING','PAID','FAILED','EXPIRED','REFUNDED')),
  gateway_payload     JSONB,
  payment_url         TEXT,
  confirmed_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX payment_records_gateway_tx_idx ON payment_records (gateway, gateway_tx_ref);
CREATE INDEX payment_records_status_idx     ON payment_records (status);
CREATE UNIQUE INDEX payment_records_idempotency_idx ON payment_records (idempotency_key);

-- ---------------------------------------------------------------------------
-- donations
-- ---------------------------------------------------------------------------
CREATE TABLE donations (
  id                  UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id         UUID          NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  user_id             UUID          REFERENCES users(id) ON DELETE SET NULL,
  donor_name          TEXT,
  donor_email         TEXT,
  is_anonymous        BOOLEAN       NOT NULL DEFAULT FALSE,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency            CHAR(3)       NOT NULL DEFAULT 'IDR',
  status              TEXT          NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING','PAID','FAILED','EXPIRED','REFUNDED')),
  payment_record_id   UUID          REFERENCES payment_records(id) ON DELETE SET NULL,
  message             TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX donations_campaign_idx   ON donations (campaign_id, status);
CREATE INDEX donations_user_idx       ON donations (user_id);
CREATE INDEX donations_status_idx     ON donations (status);
CREATE INDEX donations_created_at_idx ON donations (created_at DESC);

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id                  UUID          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider            TEXT          NOT NULL,
  event_type          TEXT          NOT NULL,
  event_id            TEXT          NOT NULL UNIQUE,
  payload             JSONB         NOT NULL,
  signature_verified  BOOLEAN       NOT NULL DEFAULT FALSE,
  processed           BOOLEAN       NOT NULL DEFAULT FALSE,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX webhook_events_provider_idx ON webhook_events (provider, created_at DESC);
