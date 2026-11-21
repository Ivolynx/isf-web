/**
 * Express application factory.
 *
 * Separating the app factory from the server entry point allows
 * tests to import the app without starting a real TCP server.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Express } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import nunjucks from 'nunjucks';
import { v4 as uuidv4 } from 'uuid';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';

import { env } from '../config/index.js';
import { logger } from '../shared/logger.js';
import { AppError, NotFoundError } from '../shared/errors.js';
import { getPool } from '../db/client.js';
import { healthRouter } from '../modules/health/health.router.js';
import { authRouter } from '../modules/auth/auth.router.js';
import { authPagesRouter } from '../modules/auth/auth.pages.router.js';
import { usersRouter } from '../modules/users/users.router.js';
import { portalRouter } from '../modules/portal/portal.router.js';
import { adminRouter } from '../modules/admin/admin.router.js';
import { ownerRouter } from '../modules/owner/owner.router.js';
import { cmsApiRouter, cmsPagesRouter, blogRouter, cmsUploadRouter } from '../modules/cms/index.js';
import { mediaRouter } from '../modules/storage/media.router.js';
import { homeRouter } from '../modules/home/home.router.js';
import {
  fundraisingApiRouter,
  fundraisingPublicRouter,
  fundraisingDashboardRouter,
} from '../modules/fundraising/index.js';
import { scholarshipRouter } from '../modules/scholarship/index.js';
import { portalScholarshipRouter } from '../modules/portal/portal.scholarship.router.js';
import { adminScholarshipRouter } from '../modules/admin/admin.scholarship.router.js';
import { webhookRouter } from '../modules/webhooks/webhook.router.js';
import {
  csrfProtection,
  csrfTokenHandler,
  csrfErrorHandler,
} from '../middleware/csrf.middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(): Express {
  const app = express();

  // -------------------------------------------------------------------------
  // Trust proxy — required when behind Nginx or a load balancer
  // -------------------------------------------------------------------------
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // -------------------------------------------------------------------------
  // Request ID — attach a unique ID to every request for traceability
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const id = uuidv4();
    res.setHeader('X-Request-Id', id);
    res.locals['requestId'] = id;
    next();
  });

  // -------------------------------------------------------------------------
  // HTTP security headers (Helmet)
  // -------------------------------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            // Tiptap is now bundled locally via esbuild (public/js/editor.bundle.js).
            // 'unsafe-inline' is required for inline <script> blocks in Nunjucks templates.
            // In production, upgrade to nonce-based CSP.
            "'unsafe-inline'",
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
          ],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: [
            // 'self' covers /media/public/* proxy — the primary image delivery path.
            "'self'",
            'data:',
            'blob:',
            'https://images.unsplash.com',
            // Keep storage endpoint allowed for direct MinIO access in local dev
            // (e.g. admin-only signed URLs rendered in <img> tags).
            env.STORAGE_ENDPOINT,
          ],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
      // HSTS — only active in production (served over HTTPS)
      strictTransportSecurity: env.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
      crossOriginEmbedderPolicy: false, // Allow Unsplash images in landing page
    }),
  );

  // -------------------------------------------------------------------------
  // Request logging (Pino HTTP)
  // -------------------------------------------------------------------------
  app.use(
    pinoHttp({
      logger,
      // Do not log health check requests to reduce noise
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      customLogLevel: (
        _req: Request,
        res: Response,
        err: Error | undefined,
      ) => {
        if (err != null || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customProps: (_req: Request, res: Response) => ({
        requestId: res.locals['requestId'] as string | undefined,
      }),
    }),
  );

  // -------------------------------------------------------------------------
  // Cookie parser — required by csrf-csrf to read the CSRF cookie
  // Must come before session and CSRF middleware.
  // -------------------------------------------------------------------------
  app.use(cookieParser());

  // -------------------------------------------------------------------------
  // Body parsing
  // -------------------------------------------------------------------------
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // -------------------------------------------------------------------------
  // Global rate limiting — foundation only, tightened per-route in later phases
  // -------------------------------------------------------------------------
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1_000, // 15 minutes
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    skip: (req) => req.url === '/health',
  });
  app.use(globalLimiter);

  // -------------------------------------------------------------------------
  // Session middleware (connect-pg-simple PostgreSQL session store)
  //
  // Security: cookies are HttpOnly, SameSite=Strict.
  // In production, Secure=true (requires HTTPS).
  // -------------------------------------------------------------------------
  const PgSession = ConnectPgSimple(session);

  app.use(
    session({
      store: new PgSession({
        pool: getPool(),
        tableName: 'sessions',
        // Purge expired sessions every 1 hour
        pruneSessionInterval: 60 * 60,
        // Error handler — log but don't crash
        errorLog: (err: Error) =>
          logger.error({ err }, 'connect-pg-simple session store error'),
      }),
      secret: env.SESSION_SECRET,
      name: 'isf.sid',
      resave: false,
      saveUninitialized: false,
      rolling: true, // Slide the expiry window on activity
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1_000, // 30 days
      },
    }),
  );

  // -------------------------------------------------------------------------
  // Nunjucks template engine
  // -------------------------------------------------------------------------
  const viewsDir = path.join(__dirname, '..', 'views');
  const nunjucksEnv = nunjucks.configure(viewsDir, {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true,
    express: app,
    noCache: env.NODE_ENV !== 'production',
  });
  app.set('view engine', 'njk');
  app.set('views', viewsDir);

  // -------------------------------------------------------------------------
  // Nunjucks custom filters
  // -------------------------------------------------------------------------

  /**
   * date(format) — format a Date object (or date string) using a simple
   * hand-rolled formatter. Avoids pulling in a date library.
   *
   * Supported tokens: DD, MMM, YYYY, HH, mm
   * Usage: {{ someDate | date('DD MMM YYYY HH:mm') }}
   */
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nunjucksEnv.addFilter('date', function dateFilter(...args: any[]): string {
    const value: unknown = args[0];
    const format: string = typeof args[1] === 'string' ? args[1] : 'DD MMM YYYY';
    if (!value) return '-';
    const d = value instanceof Date ? value : new Date(String(value));
    if (isNaN(d.getTime())) return String(value);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return format
      .replace('YYYY', String(d.getFullYear()))
      .replace('MMM', MONTHS_SHORT[d.getMonth()] ?? '')
      .replace('DD', pad(d.getDate()))
      .replace('HH', pad(d.getHours()))
      .replace('mm', pad(d.getMinutes()));
  });

  // -------------------------------------------------------------------------
  // Static files — serve the ISF landing page and assets
  //
  // Security: express.static is configured to only serve files from public/.
  // The backend source (src/), migrations, .env, etc. are entirely outside
  // this directory and cannot be served regardless of path traversal attempts.
  // -------------------------------------------------------------------------
  const publicDir = path.resolve(__dirname, '..', '..', 'public');
  // Serve static assets (css, js, assets) but not index.html — the home
  // route below renders the dynamic Nunjucks homepage instead.
  app.use(
    express.static(publicDir, {
      index: false,
      redirect: false,
      maxAge: env.NODE_ENV === 'production' ? '7d' : '0',
      dotfiles: 'deny',
    }),
  );

  // -------------------------------------------------------------------------
  // Application routes
  // -------------------------------------------------------------------------
  // Dynamic homepage — must come before any catch-all static serving
  app.use('/', homeRouter);

  app.use('/health', healthRouter);

  // CSRF token endpoint — GET, so no CSRF protection needed on this route itself
  app.get('/auth/csrf-token', csrfTokenHandler);

  // Auth pages router — browser GET/POST for login, register, etc.
  // CSRF protection is applied; GET routes are exempt by middleware config.
  app.use('/auth', csrfProtection, authPagesRouter);

  // Auth API router — JSON API for programmatic access
  app.use('/auth', csrfProtection, authRouter);

  app.use('/api/v1/users', csrfProtection, usersRouter);

  // Portal, admin, and owner page routers
  app.use('/portal', csrfProtection, portalRouter);
  app.use('/portal/scholarship', csrfProtection, portalScholarshipRouter);
  app.use('/admin', csrfProtection, adminRouter);
  app.use('/admin/scholarship', csrfProtection, adminScholarshipRouter);
  app.use('/owner', csrfProtection, ownerRouter);

  // CMS pages (dashboard) — authenticated, role-protected
  app.use('/admin/cms', csrfProtection, cmsPagesRouter);

  // CMS API — JSON endpoints for article management
  app.use('/api/v1', csrfProtection, cmsApiRouter);

  // CMS image upload — multipart, authenticated, CSRF-protected
  app.use('/api/v1/cms', csrfProtection, cmsUploadRouter);

  // Public media proxy — streams CMS images from S3/Railway Bucket.
  // No CSRF needed (read-only, no session required).
  app.use('/media', mediaRouter);

  // Blog — public, no CSRF needed (read-only)
  app.use('/blog', blogRouter);

  // Fundraising public pages — public, read-only (no CSRF for GET)
  app.use('/fundraising', csrfProtection, fundraisingPublicRouter);

  // Fundraising dashboard — authenticated, role-protected
  app.use('/admin/fundraising', csrfProtection, fundraisingDashboardRouter);

  // Fundraising API — JSON endpoints
  app.use('/api/v1', csrfProtection, fundraisingApiRouter);

  // Scholarship & Student Loan API — authenticated, CSRF-protected
  // Includes: student profile, scholarship applications, loan applications,
  // installment schedule, payment proof submission (multipart inside router)
  app.use('/api/v1/scholarship', csrfProtection, scholarshipRouter);

  // Webhooks — server-to-server, HMAC-verified, NOT CSRF-protected
  // Note: raw body capture is handled inside webhookRouter itself
  app.use('/webhooks', webhookRouter);

  // -------------------------------------------------------------------------
  // CSRF error handler — must be before the general 404/error handlers
  // -------------------------------------------------------------------------
  app.use(csrfErrorHandler);

  // -------------------------------------------------------------------------
  // 404 handler — must come after all routes
  // -------------------------------------------------------------------------
  app.use((_req: Request, res: Response) => {
    const requestId = res.locals['requestId'] as string | undefined;
    if (_req.accepts('html')) {
      res.status(404).render('errors/404.njk', { requestId });
    } else {
      res.status(404).json({ error: 'Not found', requestId });
    }
  });

  // -------------------------------------------------------------------------
  // Central error handler
  // -------------------------------------------------------------------------
  app.use(
    (
      err: unknown,
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const requestId = res.locals['requestId'] as string | undefined;

      if (err instanceof AppError && err.isOperational) {
        // Known, safe-to-surface operational error
        logger.warn({ err, requestId, url: req.url }, err.message);

        if (req.accepts('html')) {
          if (err instanceof NotFoundError) {
            res.status(err.statusCode).render('errors/404.njk', { requestId });
          } else {
            res.status(err.statusCode).render('errors/500.njk', { requestId });
          }
        } else {
          res.status(err.statusCode).json({
            error: err.message,
            requestId,
          });
        }
      } else {
        // Unknown / programming error — log fully, never expose internals
        logger.error(
          { err, requestId, url: req.url },
          'Unhandled error',
        );

        if (req.accepts('html')) {
          res.status(500).render('errors/500.njk', { requestId });
        } else {
          res.status(500).json({
            error: 'Internal server error',
            requestId,
          });
        }
      }
    },
  );

  return app;
}
