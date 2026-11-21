/**
 * CMS article schemas — Zod validation for article create/edit/workflow.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tiptap document validation
// ---------------------------------------------------------------------------

/**
 * Minimal Tiptap document validation.
 * A valid Tiptap document is a JSON object with type "doc" and a content array.
 */
export const tiptapDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.unknown()),
});

export type TiptapDoc = z.infer<typeof tiptapDocSchema>;

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/**
 * Generates a URL-safe slug from a title.
 * Lowercases, removes diacritics, replaces spaces and special chars with hyphens.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Article create/edit schema
// ---------------------------------------------------------------------------

/** Validates an image URL, blocking dangerous protocols (javascript:, data:, vbscript:) */
const safeImageUrlSchema = z
  .string()
  .url()
  .refine(
    (v) => {
      const lower = v.toLowerCase();
      return !lower.startsWith('javascript:') && !lower.startsWith('data:') && !lower.startsWith('vbscript:');
    },
    { message: 'URL gambar tidak diizinkan (protokol berbahaya)' },
  )
  .optional()
  .or(z.literal(''));

export const articleCreateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be under 200 characters'),
  slug: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : undefined)),
  summary: z.string().max(500, 'Summary must be under 500 characters').default(''),
  /**
   * Free-text display name shown on public article pages.
   * Independent from the account that created the article (authorId).
   */
  authorDisplayName: z.string().max(200).optional().transform((v) => v?.trim() || undefined),
  bodyTiptap: tiptapDocSchema,
  coverImageUrl: safeImageUrlSchema,
  categoryIds: z.array(z.string().uuid()).default([]),
  tagIds: z.array(z.string().uuid()).default([]),
  revisionNote: z.string().max(200).optional(),
});

export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;

export const articleEditSchema = articleCreateSchema.extend({
  revisionNote: z.string().max(200).optional(),
});

export type ArticleEditInput = z.infer<typeof articleEditSchema>;

// ---------------------------------------------------------------------------
// Workflow transition schema
// ---------------------------------------------------------------------------

export const articleSubmitSchema = z.object({
  message: z.string().max(500).optional(),
});

export const articleReviewSchema = z.object({
  action: z.enum(['approve', 'request_changes']),
  notes: z.string().max(1000).optional(),
});

export const articlePublishSchema = z.object({
  // No additional fields required for publish
});

// ---------------------------------------------------------------------------
// Category/tag schemas
// ---------------------------------------------------------------------------

export const categoryCreateSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().max(500).optional(),
});

export const tagCreateSchema = z.object({
  name: z.string().min(1).max(50),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .optional(),
});
