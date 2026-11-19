/**
 * platformWhatsApp — Botlify's OWN WhatsApp number (one WasenderAPI session),
 * used to talk to drivers and consultants: job offers, reminders, payout
 * receipts. Guests never see this number; they talk to their hotel's number.
 *
 * Env (from the WasenderAPI dashboard, session for Botlify's ops phone):
 *   WASENDER_PLATFORM_API_KEY        session API key
 *   WASENDER_PLATFORM_WEBHOOK_SECRET session webhook secret
 * Webhook URL to set on that session:
 *   https://<api>/api/drivers/whatsapp/hook   (event: messages.received)
 */
const logger = require("../../utils/logger");
const wasender = require("./wasenderService");

const apiKey = () => process.env.WASENDER_PLATFORM_API_KEY || "";
const isConfigured = () => apiKey().length > 10;

async function send(phone, text) {
  if (!isConfigured()) return { success: false, error: "platform_whatsapp_not_configured" };
  const res = await wasender.sendDM(JSON.stringify({ apiKey: apiKey() }), phone, text);
  if (!res.success) logger.warn(`[platformWA] send to ${String(phone).slice(-4)} failed: ${res.error}`);
  return res;
}

function verifySignature(req) {
  const expected = process.env.WASENDER_PLATFORM_WEBHOOK_SECRET || "";
  const got = String(req.headers["x-webhook-signature"] || "");
  if (!expected || got.length !== expected.length) return false;
  return require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { isConfigured, send, verifySignature, parseWebhook: wasender.parseWebhook };
