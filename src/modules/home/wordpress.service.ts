/**
 * WordPress Headless CMS integration service.
 *
 * Uses the WordPress REST API to fetch page content for the ISF homepage.
 * The application functions with a static fallback when WordPress is not configured.
 *
 * Architecture:
 *   - WordPress runs as a separate headless CMS (local dev: WordPress Studio or local install)
 *   - ISF fetches content from WordPress via the REST API
 *   - Content is cached in-memory with a configurable TTL
 *   - If WordPress is unavailable, the homepage renders with built-in static content
 *
 * Security:
 *   - No SSRF risk: only fetches from the explicitly configured WORDPRESS_BASE_URL
 *   - No credentials are embedded in URLs
 *   - Timeouts prevent hanging requests
 *   - Cache invalidation on publish (implement via WordPress webhook or cache TTL)
 *
 * Development setup:
 *   1. Install WordPress locally (WordPress Studio: https://developer.wordpress.com/studio/
 *      or local.wp, XAMPP, Docker)
 *   2. Set WORDPRESS_BASE_URL=http://localhost:8888 (or your local WordPress port) in .env
 *   3. Set WORDPRESS_PAGE_SLUG=homepage (create a page with this slug in WordPress)
 *   4. In WordPress: create page → slug = "homepage" → edit with Gutenberg
 *   5. Publish the page
 *   6. ISF will render the page content in the homepage
 *
 * WordPress authentication:
 *   - WordPress Admin access is separate from ISF authentication
 *   - Do NOT create SSO between ISF and WordPress
 *   - WordPress Admin credentials should only be shared with authorised staff
 *   - For the homepage editor link in the dashboard, link directly to the WordPress admin URL
 */

import { env } from '../../config/index.js';
import { logger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordPressBlock {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerHTML: string;
  innerBlocks?: WordPressBlock[];
}

export interface WordPressPage {
  id: number;
  slug: string;
  title: string;
  content: string;
  /** Parsed Gutenberg blocks if available */
  blocks?: WordPressBlock[];
  modifiedAt: string;
  link: string;
}

export interface WordPressConfig {
  isEnabled: boolean;
  baseUrl: string | null;
  pageSlug: string;
  adminUrl: string | null;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let _pageCache: CacheEntry<WordPressPage | null> | null = null;

function getCached(): WordPressPage | null | undefined {
  if (!_pageCache) return undefined;
  if (Date.now() > _pageCache.expiresAt) {
    _pageCache = null;
    return undefined;
  }
  return _pageCache.value;
}

function setCache(value: WordPressPage | null): void {
  const ttl = env.WORDPRESS_CACHE_TTL;
  if (ttl === 0) return; // cache disabled
  _pageCache = {
    value,
    expiresAt: Date.now() + ttl * 1_000,
  };
}

/** Manually invalidate the cache (call after publish webhook). */
export function invalidateWordPressCache(): void {
  _pageCache = null;
}

// ---------------------------------------------------------------------------
// WordPress config
// ---------------------------------------------------------------------------

export function getWordPressConfig(): WordPressConfig {
  const baseUrl = env.WORDPRESS_BASE_URL ?? null;
  return {
    isEnabled: baseUrl !== null,
    baseUrl,
    pageSlug: env.WORDPRESS_PAGE_SLUG,
    adminUrl: baseUrl ? `${baseUrl}/wp-admin` : null,
  };
}

// ---------------------------------------------------------------------------
// REST API fetch
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 5_000;

/**
 * Fetch the homepage page content from WordPress REST API.
 *
 * Returns null if:
 *   - WordPress is not configured
 *   - The page is not found
 *   - WordPress is unreachable (graceful degradation)
 *
 * Does NOT throw — the homepage always renders, even without WordPress.
 */
export async function fetchWordPressHomePage(): Promise<WordPressPage | null> {
  const config = getWordPressConfig();

  if (!config.isEnabled || !config.baseUrl) {
    return null;
  }

  // Check cache first
  const cached = getCached();
  if (cached !== undefined) return cached;

  const slug = encodeURIComponent(config.pageSlug);
  const apiUrl = `${config.baseUrl}/wp-json/wp/v2/pages?slug=${slug}&_fields=id,slug,title,content,modified,link`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ISF-Platform/1.0',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      logger.warn(
        { status: response.status, url: apiUrl },
        'WordPress API returned non-OK response',
      );
      setCache(null);
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pages = (await response.json()) as any[];

    if (!Array.isArray(pages) || pages.length === 0) {
      logger.info({ slug: config.pageSlug }, 'WordPress page not found');
      setCache(null);
      return null;
    }

    const rawPage = pages[0];
    const page: WordPressPage = {
      id: rawPage.id as number,
      slug: rawPage.slug as string,
      title: (rawPage.title?.rendered ?? rawPage.title ?? '') as string,
      content: (rawPage.content?.rendered ?? rawPage.content ?? '') as string,
      modifiedAt: rawPage.modified as string,
      link: rawPage.link as string,
    };

    setCache(page);
    return page;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ url: apiUrl }, 'WordPress API request timed out');
    } else {
      logger.warn({ err, url: apiUrl }, 'WordPress API fetch failed');
    }
    // Do not throw — return null to use static fallback
    setCache(null);
    return null;
  }
}

/**
 * Check if WordPress REST API is reachable.
 * Used for health checks and admin dashboard status.
 */
export async function checkWordPressHealth(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const config = getWordPressConfig();
  if (!config.isEnabled || !config.baseUrl) {
    return { ok: false, error: 'WordPress not configured (WORDPRESS_BASE_URL not set)' };
  }

  const start = Date.now();
  const healthUrl = `${config.baseUrl}/wp-json/`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);
    let response: Response;
    try {
      response = await fetch(healthUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
