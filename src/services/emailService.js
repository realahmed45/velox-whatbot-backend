/**
 * Email Service using Brevo HTTP API (more reliable than SMTP)
 */
const axios = require("axios");
const logger = require("../utils/logger");

const BREVO_API_KEY = process.env.BREVO_API_KEY; // NEVER hardcode — set in .env
const FROM_EMAIL = process.env.FROM_EMAIL || "realahmedali4@gmail.com";
const FROM_NAME = "Botlify";
// Where user replies to our emails should land.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "contactus@botlify.site";

logger.info("Email service init", {
  BREVO_API_KEY: BREVO_API_KEY
    ? `SET (${BREVO_API_KEY.slice(0, 12)}...)`
    : "MISSING",
});

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    const toAddr = Array.isArray(to) ? to : [to];
    const payload = {
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      replyTo: { name: `${FROM_NAME} Support`, email: SUPPORT_EMAIL },
      to: toAddr.map((email) => ({ email })),
      subject,
      htmlContent: html || `<p>${text}</p>`,
    };

    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      payload,
      {
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    logger.info(`Email sent to ${to}: ${subject} [${response.data.messageId}]`);
    return { success: true, id: response.data.messageId };
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error("Email send FAILED", { error: detail, to, subject });
    throw new Error(JSON.stringify(detail));
  }
};

// ─── Email Templates ────────────────────────────────────────

const sendVerificationEmail = async ({ to, name, code }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
      <div style="background: #FF6B2C; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Botlify</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2 style="color: #333;">Verify your email, ${name}!</h2>
        <p style="color: #666; line-height: 1.6;">Use the code below to confirm your email address and finish setting up your account.</p>
        <div style="text-align: center; margin: 32px 0;">
          <div style="display: inline-block; background: #FFF3ED; border: 1px solid #FFD9C2; border-radius: 12px; padding: 18px 40px;">
            <span style="font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #FF6B2C; font-family: 'Courier New', monospace;">${code}</span>
          </div>
        </div>
        <p style="color: #999; font-size: 14px; text-align: center;">This code expires in 15 minutes. If you didn't sign up, you can safely ignore this email.</p>
      </div>
    </div>`;
  return sendEmail({ to, subject: `${code} is your Botlify verification code`, html });
};

const sendWelcomeEmail = async ({ to, name }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #25D366; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Welcome to Botlify! 🎉</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2>Hi ${name},</h2>
        <p style="color: #666; line-height: 1.6;">You've successfully verified your email! Your WhatsApp automation journey starts now.</p>
        <h3 style="color: #333;">Get started in 3 steps:</h3>
        <ol style="color: #666; line-height: 2;">
          <li>Complete your business profile</li>
          <li>Connect your WhatsApp number (takes 5 minutes)</li>
          <li>Activate an industry template and go live!</li>
        </ol>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.CLIENT_URL}/onboarding" style="background: #25D366; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">Complete Setup Now</a>
        </div>
        <p style="color: #999; font-size: 14px;">Need help? Reply to this email or join our community forum.</p>
      </div>
    </div>`;
  return sendEmail({
    to,
    subject: "Welcome to Botlify — Let's get your bot live!",
    html,
  });
};

const sendPasswordResetEmail = async ({ to, name, code }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #111827; padding: 24px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0;">Botlify</h1>
      </div>
      <div style="background: white; padding: 32px; border-radius: 0 0 12px 12px;">
        <h2 style="color: #333;">Reset your password, ${name}!</h2>
        <p style="color: #666; line-height: 1.6;">Use the code below to reset your Botlify password.</p>
        <div style="text-align: center; margin: 32px 0;">
          <div style="display: inline-block; background: #FFF3ED; border: 1px solid #FFD9C2; border-radius: 12px; padding: 18px 40px;">
            <span style="font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #FF6B2C; font-family: 'Courier New', monospace;">${code}</span>
          </div>
        </div>
        <p style="color: #999; font-size: 14px; text-align: center;">This code expires in 15 minutes. If you didn't request a reset, you can safely ignore this email.</p>
      </div>
    </div>`;
  return sendEmail({
    to,
    subject: `${code} is your Botlify password reset code`,
    html,
  });
};

const sendUsageAlertEmail = async ({
  to,
  name,
  usagePercent,
  planName,
  upgradeUrl,
}) => {
  const isOverLimit = usagePercent >= 100;
  const color = isOverLimit ? "#FF4444" : "#FF9800";
  const subject = isOverLimit
    ? "⚠️ Message limit reached — Upgrade to continue"
    : `⚠️ ${usagePercent}% of your message quota used`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${color}; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Usage Alert</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2>Hi ${name},</h2>
        <p style="color: #666;">
          ${
            isOverLimit
              ? "You've reached your monthly message limit. Your bot is now paused. Upgrade your plan or purchase overage credits to resume."
              : `You've used ${usagePercent}% of your ${planName} plan message quota for this month.`
          }
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${upgradeUrl}" style="background: ${color}; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">
            ${isOverLimit ? "Upgrade Now" : "View Billing"}
          </a>
        </div>
      </div>
    </div>`;
  return sendEmail({ to, subject, html });
};

const sendInvoiceEmail = async ({
  to,
  name,
  invoiceNumber,
  amount,
  pdfUrl,
  periodStart,
  periodEnd,
}) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #25D366; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Invoice #${invoiceNumber}</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2>Hi ${name},</h2>
        <p style="color: #666;">Your Botlify invoice is ready.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 10px 0; color: #666;">Invoice Number</td>
            <td style="padding: 10px 0; text-align: right; font-weight: bold;">${invoiceNumber}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 10px 0; color: #666;">Period</td>
            <td style="padding: 10px 0; text-align: right;">${periodStart} – ${periodEnd}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; color: #666; font-weight: bold;">Total</td>
            <td style="padding: 10px 0; text-align: right; font-weight: bold; font-size: 20px; color: #25D366;">PKR ${amount.toLocaleString()}</td>
          </tr>
        </table>
        ${pdfUrl ? `<div style="text-align: center; margin: 20px 0;"><a href="${pdfUrl}" style="background: #333; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none;">Download PDF Invoice</a></div>` : ""}
      </div>
    </div>`;
  return sendEmail({
    to,
    subject: `Invoice #${invoiceNumber} — Botlify`,
    html,
  });
};

const sendTeamInviteEmail = async ({
  to,
  inviterName,
  workspaceName,
  inviteUrl,
}) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #25D366; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Team Invitation</h1>
      </div>
      <div style="background: white; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2>${inviterName} invited you to join ${workspaceName}</h2>
        <p style="color: #666;">You've been invited as an Agent on Botlify to help manage your conversations.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${inviteUrl}" style="background: #25D366; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">Accept Invitation</a>
        </div>
        <p style="color: #999; font-size: 14px;">This invitation expires in 7 days.</p>
      </div>
    </div>`;
  return sendEmail({
    to,
    subject: `You've been invited to ${workspaceName} on Botlify`,
    html,
  });
};

// Notify the platform admin that a new user just signed up. Sent to
// ADMIN_NOTIFY_EMAIL (falls back to a sensible default). Best-effort.
const sendSignupNotification = async ({ name, email, method, signupNumber }) => {
  const to = process.env.ADMIN_NOTIFY_EMAIL || "realahmedali4@gmail.com";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
      <div style="background:#0f172a;padding:18px 24px;border-radius:8px 8px 0 0;">
        <h2 style="color:#fff;margin:0;font-size:18px;">🎉 New Botlify signup</h2>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;padding:22px 24px;border-radius:0 0 8px 8px;">
        <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;width:120px;">Name</td><td style="padding:6px 0;font-weight:600;">${name || "—"}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Email</td><td style="padding:6px 0;font-weight:600;">${email}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Method</td><td style="padding:6px 0;">${method === "google" ? "Google" : "Email + password"}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">User #</td><td style="padding:6px 0;">${signupNumber || "?"}</td></tr>
        </table>
      </div>
    </div>`;
  return sendEmail({
    to,
    subject: `🎉 New signup: ${name || email}`,
    html,
  });
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendUsageAlertEmail,
  sendInvoiceEmail,
  sendTeamInviteEmail,
  sendSignupNotification,
};
