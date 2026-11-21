/**
 * CMS image upload router.
 *
 * POST /api/v1/cms/upload-image
 *   — Requires authentication + article:create or article:edit permission
 *   — Accepts multipart/form-data with a single "image" field
 *   — Validates MIME type via file magic bytes (first 12 bytes)
 *   — Enforces 3 MB size limit
 *   — Uploads to MinIO public-assets bucket
 *   — Returns { url, key } — never returns credentials
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { isRole } from '../../shared/rbac.js';
import type { Role } from '../../shared/rbac.js';
import { ForbiddenError, BadRequestError } from '../../shared/errors.js';
import { uploadPublicAsset } from '../storage/index.js';
import { logger } from '../../shared/logger.js';

export const cmsUploadRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

// Allowed MIME types and their magic byte signatures
const ALLOWED_SIGNATURES: Array<{
  mime: string;
  ext: string;
  magic: number[];
  offset?: number;
}> = [
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png',  ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF....WEBP
];

// ---------------------------------------------------------------------------
// Magic byte validation
// ---------------------------------------------------------------------------

function detectMimeType(buffer: Buffer): { mime: string; ext: string } | null {
  for (const sig of ALLOWED_SIGNATURES) {
    const offset = sig.offset ?? 0;
    const slice = buffer.subarray(offset, offset + sig.magic.length);
    const matches = sig.magic.every((byte, i) => (slice[i] as number | undefined) === byte);
    if (!matches) continue;

    // Extra check for WebP: bytes 8-11 must be "WEBP"
    if (sig.mime === 'image/webp') {
      const webpMark = buffer.subarray(8, 12).toString('ascii');
      if (webpMark !== 'WEBP') continue;
    }

    return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multer — memory storage (we validate then stream to S3, then discard)
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    // Preliminary browser-supplied MIME check (not trusted for security — magic bytes checked later)
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      cb(new BadRequestError('Hanya file JPEG, PNG, dan WebP yang diizinkan'));
      return;
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// POST /api/v1/cms/upload-image
// ---------------------------------------------------------------------------

cmsUploadRouter.post(
  '/upload-image',
  requireAuth(),
  (req: Request, res: Response, next: NextFunction) => {
    // Authorization: must have at least one CMS article permission
    const role = req.session.userRole;
    if (!role || !isRole(role)) {
      next(new ForbiddenError('Authentication required'));
      return;
    }
    const allowedRoles: Role[] = ['OWNER', 'ADMIN', 'EDITOR'];
    if (!allowedRoles.includes(role as Role)) {
      next(new ForbiddenError('Insufficient permissions to upload images'));
      return;
    }
    next();
  },
  (req: Request, res: Response, next: NextFunction) => {
    upload.single('image')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new BadRequestError('Ukuran file melebihi batas 3 MB'));
          return;
        }
        next(new BadRequestError(`Upload error: ${err.message}`));
        return;
      }
      if (err instanceof BadRequestError || err instanceof ForbiddenError) {
        next(err);
        return;
      }
      if (err) {
        // Catch non-multer errors (e.g. malformed multipart boundary)
        next(new BadRequestError('Format request tidak valid. Gunakan multipart/form-data.'));
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(422).json({ error: 'Tidak ada file yang diunggah (field: image)' });
        return;
      }

      const buffer = req.file.buffer;

      // Magic byte validation — do not trust browser-supplied Content-Type
      const detected = detectMimeType(buffer);
      if (!detected) {
        res.status(422).json({
          error: 'Format file tidak didukung. Hanya JPEG, PNG, dan WebP yang diizinkan.',
        });
        return;
      }

      // Generate a safe, unique object key
      const id = uuidv4().replace(/-/g, '');
      const key = `cms/images/${id}.${detected.ext}`;

      try {
        const result = await uploadPublicAsset(key, buffer, detected.mime);

        logger.info(
          { key: result.key, mime: detected.mime, size: buffer.length, userId: req.session.userId },
          'CMS image uploaded',
        );

        // Return only the public URL and key — never credentials
        res.status(201).json({ url: result.publicUrl, key: result.key });
      } catch (storageErr) {
        // Surface a clear 503 when object storage is not reachable,
        // rather than a generic 500, so callers can show a meaningful message.
        const msg = storageErr instanceof Error ? storageErr.message : String(storageErr);
        const isConnErr = msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
          msg.includes('getaddrinfo') || msg.includes('NetworkingError') ||
          msg.toLowerCase().includes('connect');
        if (isConnErr) {
          logger.warn({ storageErr }, 'Object storage not reachable for CMS upload');
          res.status(503).json({
            error: 'Layanan penyimpanan sementara tidak tersedia. Gunakan opsi URL gambar sebagai alternatif, atau coba lagi nanti.',
          });
          return;
        }
        throw storageErr;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to upload CMS image');
      next(err);
    }
  },
);
