-- ISF Platform — Phase 2 (CMS) migration: articles, categories, tags, revisions
-- Creates: article workflow tables and supporting taxonomy tables

-- ---------------------------------------------------------------------------
-- article_status enum (simulated via CHECK constraint)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX categories_slug_unique ON categories (slug);
CREATE INDEX categories_name_idx ON categories (name);

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX tags_slug_unique ON tags (slug);
CREATE INDEX tags_name_idx ON tags (name);

-- ---------------------------------------------------------------------------
-- articles
-- Status workflow:
--   DRAFT → IN_REVIEW → (CHANGES_REQUESTED →) IN_REVIEW → APPROVED → PUBLISHED → ARCHIVED
-- ---------------------------------------------------------------------------
CREATE TABLE articles (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug              TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  summary           TEXT        NOT NULL DEFAULT '',
  -- body_tiptap: raw Tiptap JSON document (source of truth)
  body_tiptap       JSONB       NOT NULL DEFAULT '{}',
  -- body_html: server-rendered, sanitised HTML for public display
  body_html         TEXT        NOT NULL DEFAULT '',
  cover_image_url   TEXT,
  status            TEXT        NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN (
                                  'DRAFT',
                                  'IN_REVIEW',
                                  'CHANGES_REQUESTED',
                                  'APPROVED',
                                  'PUBLISHED',
                                  'ARCHIVED'
                                )),
  author_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- reviewer_id: set when article enters IN_REVIEW
  reviewer_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  -- reviewer_notes: latest notes from reviewer (for CHANGES_REQUESTED)
  reviewer_notes    TEXT,
  published_at      TIMESTAMPTZ,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX articles_slug_unique ON articles (slug) WHERE deleted_at IS NULL;
CREATE INDEX articles_status_idx     ON articles (status);
CREATE INDEX articles_author_idx     ON articles (author_id);
CREATE INDEX articles_published_at_idx ON articles (published_at DESC) WHERE status = 'PUBLISHED';
CREATE INDEX articles_created_at_idx ON articles (created_at DESC);

-- ---------------------------------------------------------------------------
-- article_categories (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE article_categories (
  article_id  UUID  NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_id UUID  NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, category_id)
);

-- ---------------------------------------------------------------------------
-- article_tags (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE article_tags (
  article_id  UUID  NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id      UUID  NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- article_revisions (append-only history)
-- A snapshot is created on every content save.
-- ---------------------------------------------------------------------------
CREATE TABLE article_revisions (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  article_id  UUID        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  -- snapshot: full article state (title, summary, body_tiptap, body_html) at save time
  snapshot    JSONB       NOT NULL,
  revised_by  UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- revision_note: optional description of what changed
  revision_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: revisions are immutable
);

CREATE INDEX article_revisions_article_idx ON article_revisions (article_id, created_at DESC);
CREATE INDEX article_revisions_revised_by_idx ON article_revisions (revised_by);
