/**
 * Mailer service — sends transactional emails via SMTP.
 *
 * In development, uses Mailpit (localhost:1025) which captures all outgoing
 * email and makes it available at http://localhost:8025.
 *
 * In production, configure SMTP_HOST/PORT/USER/PASS via environment variables.
 *
 * Security:
 * - Email bodies never contain raw secrets, only tokens embedded in URLs.
 * - The raw token is a one-time value; after use it is invalidated server-side.
 * - Connection errors are logged but do not throw to the caller — email
 *   delivery failure is handled by returning a boolean success flag.
 */

import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/index.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Transport — created once, reused across requests
// ---------------------------------------------------------------------------

function buildTransport(): Transporter {
  return createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASS
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
  });
}

let _transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!_transport) {
    _transport = buildTransport();
  }
  return _transport;
}

// ---------------------------------------------------------------------------
// Email sending helper
// ---------------------------------------------------------------------------

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send an email. Returns true on success, false on failure.
 * Never throws — logs the error internally.
 */
async function sendMail(opts: MailOptions): Promise<boolean> {
  try {
    await getTransport().sendMail({
      from: env.SMTP_FROM,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return true;
  } catch (err) {
    logger.error({ err, to: opts.to, subject: opts.subject }, 'Failed to send email');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transactional email templates
// ---------------------------------------------------------------------------

/**
 * Send an email address verification email.
 * The token is embedded in a URL — it is a raw cryptographic token.
 */
export async function sendVerificationEmail(
  to: string,
  rawToken: string,
): Promise<boolean> {
  const url = `${env.APP_BASE_URL}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;

  return sendMail({
    to,
    subject: 'Verify your Intelegensia email address',
    text: [
      'Welcome to Intelligentsia Scholarship Fund.',
      '',
      'Please verify your email address by clicking the link below:',
      url,
      '',
      'This link expires in 24 hours.',
      'If you did not create an account, please ignore this email.',
    ].join('\n'),
    html: `
      <p>Welcome to <strong>Intelligentsia Scholarship Fund</strong>.</p>
      <p>Please verify your email address:</p>
      <p><a href="${url}">Verify email address</a></p>
      <p>This link expires in <strong>24 hours</strong>.</p>
      <p><small>If you did not create an account, please ignore this email.</small></p>
    `.trim(),
  });
}

/**
 * Send a password reset email.
 * The token is embedded in a URL — it is a raw cryptographic token.
 * Generic subject/body that does not reveal whether the account exists.
 */
export async function sendPasswordResetEmail(
  to: string,
  rawToken: string,
): Promise<boolean> {
  const url = `${env.APP_BASE_URL}/auth/reset-password?token=${encodeURIComponent(rawToken)}`;

  return sendMail({
    to,
    subject: 'Reset your Intelegensia password',
    text: [
      'A password reset was requested for the account associated with this email address.',
      '',
      'Click the link below to reset your password:',
      url,
      '',
      'This link expires in 1 hour and can only be used once.',
      'If you did not request a password reset, you can safely ignore this email.',
    ].join('\n'),
    html: `
      <p>A password reset was requested for the account associated with this email address.</p>
      <p><a href="${url}">Reset your password</a></p>
      <p>This link expires in <strong>1 hour</strong> and can only be used once.</p>
      <p><small>If you did not request a password reset, you can safely ignore this email.</small></p>
    `.trim(),
  });
}

/**
 * Send an invitation email with a secure one-time acceptance link.
 */
export async function sendInvitationEmail(
  to: string,
  inviteUrl: string,
  role: string,
): Promise<boolean> {
  return sendMail({
    to,
    subject: 'You have been invited to Intelligentsia Scholarship Fund',
    text: [
      `You have been invited to join Intelligentsia Scholarship Fund as ${role}.`,
      '',
      'Click the link below to set your password and activate your account:',
      inviteUrl,
      '',
      'This link expires in 72 hours and can only be used once.',
      'If you did not expect this invitation, you can safely ignore this email.',
    ].join('\n'),
    html: `
      <p>You have been invited to join <strong>Intelligentsia Scholarship Fund</strong> as <strong>${role}</strong>.</p>
      <p>Click the link below to set your password and activate your account:</p>
      <p><a href="${inviteUrl}">Accept invitation and set password</a></p>
      <p>This link expires in <strong>72 hours</strong> and can only be used once.</p>
      <p><small>If you did not expect this invitation, you can safely ignore this email.</small></p>
    `.trim(),
  });
}

// ---------------------------------------------------------------------------
// Loan billing notifications (simulation mode — sent only when SMTP configured)
// ---------------------------------------------------------------------------

/**
 * Notify student when a loan agreement + installment schedule is created.
 * NOTE: System is in simulation mode — not a real financial agreement.
 */
export async function sendLoanScheduleCreatedEmail(opts: {
  to: string;
  studentName: string;
  agreementNumber: string;
  principalAmount: string;
  tenorMonths: number;
  firstPaymentDate: string;
  portalUrl: string;
}): Promise<boolean> {
  return sendMail({
    to: opts.to,
    subject: `[SIMULASI] Jadwal Cicilan Pembiayaan ${opts.agreementNumber} — ISF`,
    text: [
      `Yth. ${opts.studentName},`,
      '',
      '[SIMULASI — bukan transaksi keuangan nyata]',
      '',
      `Perjanjian pembiayaan ${opts.agreementNumber} telah dibuat.`,
      `Pokok: Rp ${parseFloat(opts.principalAmount).toLocaleString('id-ID')}`,
      `Tenor: ${opts.tenorMonths} bulan`,
      `Cicilan pertama: ${opts.firstPaymentDate}`,
      '',
      `Lihat jadwal cicilan di: ${opts.portalUrl}`,
      '',
      'ISF — Intelligentsia Scholarship Fund',
    ].join('\n'),
    html: `
      <p>Yth. <strong>${opts.studentName}</strong>,</p>
      <p><em>[SIMULASI — bukan transaksi keuangan nyata]</em></p>
      <p>Perjanjian pembiayaan <strong>${opts.agreementNumber}</strong> telah dibuat.</p>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;">Pokok</td><td><strong>Rp ${parseFloat(opts.principalAmount).toLocaleString('id-ID')}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;">Tenor</td><td>${opts.tenorMonths} bulan</td></tr>
        <tr><td style="padding:4px 12px 4px 0;">Cicilan pertama</td><td>${opts.firstPaymentDate}</td></tr>
      </table>
      <p><a href="${opts.portalUrl}">Lihat jadwal cicilan →</a></p>
      <p><small>ISF — Intelligentsia Scholarship Fund</small></p>
    `.trim(),
  });
}

/**
 * Notify student when a payment submission is approved by admin.
 */
export async function sendPaymentApprovedEmail(opts: {
  to: string;
  studentName: string;
  installmentNumber: number;
  amount: string;
  portalUrl: string;
}): Promise<boolean> {
  return sendMail({
    to: opts.to,
    subject: `[SIMULASI] Pembayaran Cicilan ke-${opts.installmentNumber} Disetujui — ISF`,
    text: [
      `Yth. ${opts.studentName},`,
      '',
      '[SIMULASI]',
      '',
      `Pembayaran cicilan ke-${opts.installmentNumber} sebesar Rp ${parseFloat(opts.amount).toLocaleString('id-ID')} telah diverifikasi dan disetujui.`,
      '',
      `Lihat detail di: ${opts.portalUrl}`,
      '',
      'ISF — Intelligentsia Scholarship Fund',
    ].join('\n'),
    html: `
      <p>Yth. <strong>${opts.studentName}</strong>,</p>
      <p><em>[SIMULASI]</em></p>
      <p>Pembayaran cicilan ke-<strong>${opts.installmentNumber}</strong> sebesar <strong>Rp ${parseFloat(opts.amount).toLocaleString('id-ID')}</strong> telah diverifikasi dan disetujui.</p>
      <p><a href="${opts.portalUrl}">Lihat detail pembayaran →</a></p>
      <p><small>ISF — Intelligentsia Scholarship Fund</small></p>
    `.trim(),
  });
}

/**
 * Notify student when a payment submission is rejected by admin.
 */
export async function sendPaymentRejectedEmail(opts: {
  to: string;
  studentName: string;
  installmentNumber: number;
  amount: string;
  reason: string;
  portalUrl: string;
}): Promise<boolean> {
  return sendMail({
    to: opts.to,
    subject: `[SIMULASI] Pembayaran Cicilan ke-${opts.installmentNumber} Ditolak — ISF`,
    text: [
      `Yth. ${opts.studentName},`,
      '',
      '[SIMULASI]',
      '',
      `Pembayaran cicilan ke-${opts.installmentNumber} sebesar Rp ${parseFloat(opts.amount).toLocaleString('id-ID')} tidak dapat diverifikasi.`,
      `Alasan: ${opts.reason}`,
      '',
      `Unggah ulang bukti pembayaran di: ${opts.portalUrl}`,
      '',
      'ISF — Intelligentsia Scholarship Fund',
    ].join('\n'),
    html: `
      <p>Yth. <strong>${opts.studentName}</strong>,</p>
      <p><em>[SIMULASI]</em></p>
      <p>Pembayaran cicilan ke-<strong>${opts.installmentNumber}</strong> sebesar Rp ${parseFloat(opts.amount).toLocaleString('id-ID')} tidak dapat diverifikasi.</p>
      <p><strong>Alasan:</strong> ${opts.reason}</p>
      <p><a href="${opts.portalUrl}">Unggah ulang bukti pembayaran →</a></p>
      <p><small>ISF — Intelligentsia Scholarship Fund</small></p>
    `.trim(),
  });
}
