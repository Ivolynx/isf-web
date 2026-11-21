/**
 * Fundraising schemas — Zod validation for campaigns and donations.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

/** Validates an image URL: must be http/https, rejects javascript:/data: protocols */
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

export const campaignCreateSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  slug: z.string().optional().transform((v) => (v ? v.trim() : undefined)),
  description: z.string().min(1, 'Description is required').max(5000),
  beneficiary: z.string().min(1, 'Beneficiary is required').max(500),
  goalAmount: z
    .number()
    .positive('Goal amount must be positive')
    .max(1_000_000_000_000, 'Goal amount too large'),
  currency: z.string().length(3).default('IDR'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  coverImageUrl: safeImageUrlSchema,
});

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export const campaignEditSchema = campaignCreateSchema;
export type CampaignEditInput = CampaignCreateInput;

// ---------------------------------------------------------------------------
// Donation
// ---------------------------------------------------------------------------

export const donationCreateSchema = z.object({
  campaignId: z.string().uuid(),
  amount: z
    .number()
    .positive('Donation amount must be positive')
    .max(1_000_000_000, 'Amount too large')
    .refine((v) => Number.isFinite(v) && !isNaN(v), 'Invalid amount'),
  currency: z.string().length(3).default('IDR'),
  donorName: z.string().max(200).optional(),
  donorEmail: z.string().email().optional().or(z.literal('')),
  isAnonymous: z.boolean().default(false),
  message: z.string().max(500).optional(),
});

export type DonationCreateInput = z.infer<typeof donationCreateSchema>;
