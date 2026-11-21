/**
 * CMS module — article management, Tiptap editor, blog.
 *
 * Phase 2 implementation:
 *   - Article CRUD (create, edit, soft-delete)
 *   - Article workflow: DRAFT → IN_REVIEW → APPROVED → PUBLISHED → ARCHIVED
 *   - Revision history (append-only snapshots)
 *   - Categories and tags
 *   - Public blog listing and detail pages
 *   - Tiptap JSON storage with server-side HTML rendering
 *   - XSS-safe HTML sanitisation
 *
 * Content workflow roles:
 *   EDITOR   — create, edit, submit for review
 *   REVIEWER — approve, reject, request changes
 *   ADMIN    — all of the above + publish, archive, unpublish
 *   OWNER    — all permissions
 *
 * See docs/adr/007-cms.md for the full design.
 */

export { cmsApiRouter } from './cms.api.router.js';
export { cmsPagesRouter } from './cms.pages.router.js';
export { blogRouter } from './blog.router.js';
export { cmsUploadRouter } from './cms.upload.router.js';
