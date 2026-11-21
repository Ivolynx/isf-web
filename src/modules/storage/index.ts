/**
 * Storage module — S3-compatible object storage via AWS SDK v3.
 *
 * Uses MinIO locally (docker-compose) and any S3-compatible backend in production.
 * All configuration comes exclusively from environment variables — no hardcoded credentials.
 *
 * Two buckets:
 *   isf-private-docs    — private; accessed only via short-lived signed URLs
 *   isf-public-assets   — public read; CMS cover images and campaign banners
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';

// ---------------------------------------------------------------------------
// S3 client singleton
// ---------------------------------------------------------------------------

let _s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (_s3Client) return _s3Client;

  _s3Client = new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
    // Required for MinIO path-style URLs (http://localhost:9000/bucket/key)
    forcePathStyle: true,
  });

  return _s3Client;
}

// ---------------------------------------------------------------------------
// Upload a Buffer to the public assets bucket
// ---------------------------------------------------------------------------

export interface UploadResult {
  /** Object key stored in S3/MinIO (use this in the database, not a full URL) */
  key: string;
  /** Full public URL to access the object */
  publicUrl: string;
}

/**
 * Upload a file buffer to the public assets bucket.
 *
 * @param key        Object key (e.g. "cms/images/abc123.jpg")
 * @param body       File contents as a Buffer
 * @param mimeType   MIME type (e.g. "image/jpeg")
 */
export async function uploadPublicAsset(
  key: string,
  body: Buffer,
  mimeType: string,
): Promise<UploadResult> {
  const client = getS3Client();
  const bucket = env.STORAGE_BUCKET_PUBLIC;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimeType,
      // Public read is set at bucket level by minio-init; no per-object ACL needed
    }),
  );

  // Construct the public URL from the configured endpoint
  const endpoint = env.STORAGE_ENDPOINT.replace(/\/$/, '');
  const publicUrl = `${endpoint}/${bucket}/${key}`;

  return { key, publicUrl };
}

/**
 * Delete an object from the public assets bucket.
 *
 * @param key  Object key to delete
 */
export async function deletePublicAsset(key: string): Promise<void> {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.STORAGE_BUCKET_PUBLIC,
      Key: key,
    }),
  );
}

/**
 * Generate a short-lived signed URL for a private document.
 *
 * @param key     Object key in the private bucket
 * @param ttlSec  URL lifetime in seconds (default 300 = 5 minutes)
 */
export async function getPrivateSignedUrl(key: string, ttlSec = 300): Promise<string> {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: env.STORAGE_BUCKET_PRIVATE,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: ttlSec });
}
