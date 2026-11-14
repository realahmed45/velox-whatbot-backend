/**
 * dialog360Service — WhatsApp via 360dialog (official Meta BSP).
 *
 * Replaces Zernio as the WhatsApp carrier (Nov 2026). Each hotel's number has
 * its own 360dialog API key (D360-API-KEY); we store it encrypted as the
 * workspace.channels entry's accountId, exactly like other providers, so the
 * automation engine's transport layer stays provider-agnostic.
 *
 * Messaging API — verified against docs.360dialog.com (Nov 2026):
 *   base   https://waba-v2.360dialog.io
 *   auth   header  D360-API-KEY: <per-number key>
 *   send   POST /messages  {messaging_product:"whatsapp", recipient_type:"individual",
 *                           to, type:"text", text:{body}}
 *   hook   POST /v1/configs/webhook  {url, headers?}
 *   in     Meta Cloud API payload: entry[].changes[].value.{metadata, contacts[], messages[]}
 *   media  GET /<media_id> → {url}; swap lookaside.fbsbx.com → waba-v2.360dialog.io,
 *          GET it with the key (URL valid 5 minutes)
 *   Free-form text only inside the customer-service window; outside it Meta
 *   requires an approved template (error 131047).
 *
 * Partner onboarding (one-click "Connect WhatsApp") — NOT in the public docs;
 * built to 360dialog's standard partner flow and fully env-driven so it can be
 * corrected without code once partner access shows the reference:
 *   popup     {D360_HUB_URL}/dashboard/app/{partnerId}/permissions?redirect_url=…&state=…
 *   redirect  ?client=<clientId>&channels=[<channelId>,…]&state=…
 *   key       POST {D360_PARTNER_API}/partners/{partnerId}/channels/{channelId}/api_keys
 *             auth: x-api-key: D360_PARTNER_API_KEY   (or Bearer token from
 *             POST /token {username,password} when D360_PARTNER_USERNAME is set)
 * Without partner credentials, hotels connect by pasting their own API key from
 * the 360dialog hub — that path needs nothing from us and works today.
 *
 * Env:
 *   D360_API_BASE           default https://waba-v2.360dialog.io
 *   D360_PARTNER_ID         enables the Connect popup
 *   D360_PARTNER_API_KEY    partner API key (x-api-key)
 *   D360_PARTNER_USERNAME / D360_PARTNER_PASSWORD   alternative token auth
 *   D360_PARTNER_API        default https://hub.360dialog.io/api/v2
 *   D360_HUB_URL            default https://hub.360dialog.com
 */
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../../utils/logger");

const BASE = (process.env.D360_API_BASE || "https://waba-v2.360dialog.io").replace(/\/$/, "");
const PARTNER_ID = process.env.D360_PARTNER_ID || "";
const PARTNER_API = (process.env.D360_PARTNER_API || "https://hub.360dialog.io/api/v2").replace(/\/$/, "");
const HUB_URL = (process.env.D360_HUB_URL || "https://hub.360dialog.com").replace(/\/$/, "");

const api = (apiKey) =>
  axios.create({
    baseURL: BASE,
    timeout: 15000,
    headers: { "D360-API-KEY": apiKey, "Content-Type": "application/json" },
  });

/** Messaging needs only a per-number key, so it is always "configured". */
const isConfigured = () => true;
const partnerConfigured = () =>
  !!(PARTNER_ID && (process.env.D360_PARTNER_API_KEY || process.env.D360_PARTNER_USERNAME));

const normalisePhone = (p) => String(p || "").replace(/[^\d]/g, "");

// ── Sending ──────────────────────────────────────────────────────────────────

const isOutsideWindowError = (data = {}) => {
  const blob = JSON.stringify(data || {}).toLowerCase();
  return blob.includes("131047") || blob.includes("re-engagement") || blob.includes("24 hours");
};

/**
 * Send a WhatsApp message. Signature matches the other providers' sendDM so
 * automationEngine.resolveSendTransport can call any of them the same way.
 * @param {string} apiKey       decrypted per-number D360-API-KEY
 * @param {string} recipientId  guest's wa_id / phone number
 */
async function sendDM(apiKey, recipientId, text, opts = {}) {
  const to = normalisePhone(recipientId);
  if (!apiKey || !to) return { success: false, error: "WhatsApp isn't connected for this hotel." };
  const body = opts.mediaUrl
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: opts.mediaType === "document" ? "document" : "image",
        [opts.mediaType === "document" ? "document" : "image"]: {
          link: opts.mediaUrl,
          ...(text ? { caption: text } : {}),
        },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: String(text || ""), preview_url: false },
      };
  try {
    const { data } = await api(apiKey).post("/messages", body);
    return { success: true, messageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    const d = err.response?.data || {};
    const outsideWindow = isOutsideWindowError(d);
    logger.warn("[360dialog] send failed", { status: err.response?.status, err: JSON.stringify(d).slice(0, 300) });
    return {
      success: false,
      outsideWindow,
      rateLimited: err.response?.status === 429,
      error: outsideWindow
        ? "This guest last messaged over 24 hours ago, so WhatsApp only allows an approved template message. Ask them to message again, or send a template."
        : d?.error?.message || d?.meta?.developer_message || err.message,
    };
  }
}

/** Approved template (outside the 24h window). */
async function sendTemplate(apiKey, recipientId, { name, language = "en", components } = {}) {
  try {
    const { data } = await api(apiKey).post("/messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalisePhone(recipientId),
      type: "template",
      template: { name, language: { code: language }, ...(components ? { components } : {}) },
    });
    return { success: true, messageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

// ── Webhook config + parsing ─────────────────────────────────────────────────

/** Point the number's webhook at us. Also proves the API key is valid. */
async function configureWebhook(apiKey, url) {
  const { data } = await api(apiKey).post("/v1/configs/webhook", { url });
  return data;
}

/** A random per-connection secret we put in the webhook URL to route + authenticate it. */
const newHookToken = () => crypto.randomBytes(24).toString("hex");

/**
 * Meta Cloud API payload → flat inbound messages. Status updates (sent,
 * delivered, read) are returned separately and never treated as messages.
 */
function parseWebhook(body = {}) {
  const messages = [];
  const statuses = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const meta = v.metadata || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
      for (const m of v.messages || []) {
        const media = m.image || m.document || m.audio || m.video || m.sticker || null;
        messages.push({
          phoneNumberId: meta.phone_number_id || null,
          displayPhone: meta.display_phone_number || null,
          from: m.from,
          name: names[m.from] || "",
          id: m.id,
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          type: m.type,
          text:
            m.text?.body ||
            m.button?.text ||
            m.interactive?.button_reply?.title ||
            m.interactive?.list_reply?.title ||
            media?.caption ||
            (m.type === "location" ? `📍 ${m.location?.name || ""} ${m.location?.latitude},${m.location?.longitude}`.trim() : "") ||
            "",
          mediaId: media?.id || null,
          mediaType: m.type,
        });
      }
      for (const s of v.statuses || []) statuses.push({ id: s.id, status: s.status, to: s.recipient_id });
    }
  }
  return { messages, statuses };
}

/** Download incoming media bytes (URL is valid ~5 minutes). */
async function downloadMedia(apiKey, mediaId) {
  const { data } = await api(apiKey).get(`/${encodeURIComponent(mediaId)}`);
  if (!data?.url) throw new Error("No media URL returned");
  const url = String(data.url).replace("lookaside.fbsbx.com", new URL(BASE).host);
  const res = await axios.get(url, {
    headers: { "D360-API-KEY": apiKey },
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return { buffer: Buffer.from(res.data), mimeType: data.mime_type || res.headers["content-type"] };
}

// ── Partner onboarding (one-click connect) ───────────────────────────────────

function connectUrl({ redirectUrl, state }) {
  if (!partnerConfigured()) return null;
  const q = new URLSearchParams({ redirect_url: redirectUrl, state: String(state || "") });
  return `${HUB_URL}/dashboard/app/${encodeURIComponent(PARTNER_ID)}/permissions?${q}`;
}

let tokenCache = { token: "", exp: 0 };
async function partnerHeaders() {
  if (process.env.D360_PARTNER_API_KEY) return { "x-api-key": process.env.D360_PARTNER_API_KEY };
  if (tokenCache.token && Date.now() < tokenCache.exp) return { Authorization: `Bearer ${tokenCache.token}` };
  const { data } = await axios.post(`${PARTNER_API}/token`, {
    username: process.env.D360_PARTNER_USERNAME,
    password: process.env.D360_PARTNER_PASSWORD,
  });
  const token = data?.access_token || data?.token;
  if (!token) throw new Error("360dialog partner token missing");
  tokenCache = { token, exp: Date.now() + 50 * 60 * 1000 };
  return { Authorization: `Bearer ${token}` };
}

/** Parse the redirect's channels param: "[id1,id2]" or "id1,id2". */
const parseChannels = (raw) =>
  String(raw || "")
    .replace(/[[\]"' ]/g, "")
    .split(",")
    .filter(Boolean);

/** Create the per-number API key for a channel the hotel just connected. */
async function createChannelApiKey(channelId) {
  if (!partnerConfigured()) throw new Error("360dialog partner access isn't configured");
  const { data } = await axios.post(
    `${PARTNER_API}/partners/${encodeURIComponent(PARTNER_ID)}/channels/${encodeURIComponent(channelId)}/api_keys`,
    {},
    { headers: { ...(await partnerHeaders()), "Content-Type": "application/json" }, timeout: 20000 },
  );
  const apiKey = data?.api_key || data?.key;
  if (!apiKey) throw new Error("360dialog returned no API key");
  return { apiKey, address: data?.address || null };
}

module.exports = {
  isConfigured,
  partnerConfigured,
  sendDM,
  sendTemplate,
  configureWebhook,
  newHookToken,
  parseWebhook,
  downloadMedia,
  connectUrl,
  parseChannels,
  createChannelApiKey,
  normalisePhone,
};
