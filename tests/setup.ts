/**
 * Test setup — loaded by vitest before every test suite (setupFiles in vitest.config.ts).
 *
 * Responsibilities:
 *   1. Load test environment variables from .env.test (if present) or set safe defaults.
 *   2. Export isDatabaseAvailable() — tests use this to skip DB-dependent assertions
 *      when running in environments without a database (CI without Docker, etc.).
 */

import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.test first, then fall back to .env
// dotenv.config() does NOT override existing process.env values, so
// environment variables set by the CI system take precedence.
config({ path: path.join(__dirname, '..', '.env.test'), override: false });
config({ path: path.join(__dirname, '..', '.env'), override: false });

// Ensure NODE_ENV is 'test' — required by the app factory (skips CSRF validation)
process.env['NODE_ENV'] = 'test';

// Set safe defaults for required env vars if not already set.
// These match the docker-compose.yml defaults for local development.
process.env['DATABASE_URL'] ??= 'postgresql://isf_user:isf_password@localhost:5432/isf_db';
process.env['SESSION_SECRET'] ??= 'test-session-secret-must-be-at-least-32-chars!!';
process.env['APP_BASE_URL'] ??= 'http://localhost:3000';

// ---------------------------------------------------------------------------
// isDatabaseAvailable — used in test files to skip DB tests gracefully
// ---------------------------------------------------------------------------

let _dbAvailableCache: boolean | null = null;

/**
 * Returns true if the test database is reachable.
 * Result is cached after the first call to avoid repeated connection attempts.
 *
 * Tests that require a live database should call this in beforeAll() and
 * skip or mark pending if the database is not available.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  if (_dbAvailableCache !== null) return _dbAvailableCache;

  try {
    // Dynamically import to avoid initializing the DB client if not needed
    const { checkDatabaseHealth } = await import('../src/db/client.js');
    const result = await checkDatabaseHealth();
    _dbAvailableCache = result.ok;
  } catch {
    _dbAvailableCache = false;
  }

  return _dbAvailableCache;
}
