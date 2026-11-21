/**
 * Media proxy router — serves public CMS images stored in Railway Bucket (or MinIO).
 *
 * GET /media/public/:filename
 *   — Streams the file from the S3 public-assets bucket under the prefix cms/images/.
 *   — No authentication required (images are public-facing content).
 *   — Only the cms/images/ prefix is served; loan-payments/ and any other prefix
 *     are intentionally unreachable through this endpoint.
 *   — Filename is validated against a strict allowlist of characters and extensions
 *     before being used as an S3 key — no arbitrary key injection possible.
 *   — Sends correct Content-Type, Cache-Control, ETag, and X-Content-Type-Options.
 *
 * Security notes:
 *   - The key is always constructed as `cms/images/${validatedFilename}` — the client
 *     cannot supply a path that escapes this prefix.
 *   - Encoded slashes in the filename are rejected by the strict pattern.
 *   - 404 on NoSuchKey, 503 on network errors — no bucket/key details leaked.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getPublicAssetStream } from './index.js';
import { logger } from '../../shared/logger.js';

export const mediaRouter = Router();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Allowed filename pattern for proxy-served CMS images.
 *
 * Accepts: UUID hex chars (a-f0-9), hyphen, underscore, plus a known image extension.
 * Rejects: path separators, encoded slashes, dots in the stem, uppercase, etc.
 *
 * Valid examples:  abc123def456.jpg   a1b2c3d4e5f6.webp
 */
const SAFE_FILENAME_RE = /^[a-f0-9\-_]+\.(jpg|jpeg|png|webp)$/;

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// ---------------------------------------------------------------------------
// S3 error helpers
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();
    return (
      name === 'NoSuchKey' ||
      name === 'NotFound' ||
      msg.includes('nosuchkey') ||
      msg.includes('not found') ||
      // HTTP 404 from S3
      (err as NodeJS.ErrnoException).code === '404'
    );
  }
  return false;
}

function isConnectError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('getaddrinfo') ||
      msg.includes('networkingerror') ||
      msg.includes('connect')
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /media/public/:filename
// ---------------------------------------------------------------------------

mediaRouter.get(
  '/public/:filename',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filenameParam = req.params['filename'];

      // Strict validation — rejects anything that isn't a safe UUID-style image filename.
      if (
        typeof filenameParam !== 'string' ||
        !SAFE_FILENAME_RE.test(filenameParam)
      ) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const filename = filenameParam;

      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      let stream: Awaited<ReturnType<typeof getPublicAssetStream>>;
      try {
        stream = await getPublicAssetStream(filename);
      } catch (err) {
        if (isNotFoundError(err)) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        if (isConnectError(err)) {
          logger.warn({ filename, err }, 'Storage not reachable for media proxy');
          res.status(503).json({ error: 'Storage temporarily unavailable' });
          return;
        }
        throw err;
      }

      // Determine content type — trust our validated extension, not S3's value.
      const contentType = MIME_BY_EXT[ext] ?? stream.contentType ?? 'application/octet-stream';

      // Security headers
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Cache: UUID-named assets are content-addressed — safe to cache for 7 days.
      res.setHeader(
        'Cache-Control',
        'public, max-age=604800, stale-while-revalidate=86400, immutable',
      );

      if (stream.etag) {
        res.setHeader('ETag', stream.etag);
      }

      if (stream.contentLength !== undefined) {
        res.setHeader('Content-Length', stream.contentLength);
      }

      // Stream the body from S3 to the client.
      stream.body.pipe(res);

      stream.body.on('error', (streamErr: Error) => {
        logger.error({ filename, streamErr }, 'Stream error while piping media response');
        // If headers not sent yet, send 503; otherwise just destroy.
        if (!res.headersSent) {
          res.status(503).json({ error: 'Storage error during streaming' });
        } else {
          res.destroy();
        }
      });
    } catch (err) {
      next(err);
    }
  },
);
