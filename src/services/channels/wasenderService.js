/**
 * wasenderService — WhatsApp via WasenderAPI (~$6/month per number). The
 * owner's chosen WhatsApp carrier (Nov 2026).
 *
 * IMPORTANT — what this is: WasenderAPI links a number the way WhatsApp Web
 * does (scan a QR from the phone's "Linked devices"). It is NOT Meta's official
 * Business API, so WhatsApp can restrict a number it judges to be automated
 * spam. Botlify only ever REPLIES to guests who message first (no broadcasts,
 * no cold messages), which is the safe pattern; keep it that way.
 *
 * API (wasenderapi.com/api-docs, verified Nov 2026):
 *   base    https://www.wasenderapi.com/api
 *   auth    Authorization: Bearer <token>
 *           - session API key  → messaging (/send-message, /status)
 *           - Personal Access Token (WASENDER_PAT) → session management
 *   send    POST /send-message {to, text} | {to, imageUrl, text?} → {success, data:{msgId, jid, status}}
 *   create  POST /whatsapp-sessions {name, phone_number, account_protection, log_messages,
 *           webhook_url, webhook_enabled, webhook_events} → data:{id, api_key, webhook_secret, status}
 *   connect POST /whatsapp-sessions/{id}/connect
 *   qr      GET  /whatsapp-sessions/{id}/qrcode → data:{qrCode:"2@…"} (render it ourselves)
 *   status  GET  /whatsapp-sessions/{id} (PAT) | GET /status (session key)
 *   delete  DELETE /whatsapp-sessions/{id}
 *   hook    POST to our URL, header X-Webhook-Signature == the session's webhook_secret.
 *           messages.received → data.messages (single object):
 *             key{id, fromMe, remoteJid, cleanedSenderPn, senderPn}, messageBody, message{…}
 *
 * The stored channel credential (encrypted accountId) is JSON:
 *   { apiKey, webhookSecret, sessionId? }   sessionId only when Botlify created it.
 */
const axios = require("axios");
const QRCode = require("qrcode");
const logger = require("../../utils/logger");

const BASE = (process.env.WASENDER_API_BASE || "https://www.wasenderapi.com/api").replace(/\/$/, "");
const PAT = () => process.env.WASENDER_PAT || "";

const isConfigured = () => true; // messaging only needs a per-number key
const canCreateSessions = () => !!PAT();

const normalisePhone = (p) => String(p || "").replace(/[^\d]/g, "");
const readCreds = (accountId) => {
  try {
    const c = typeof accountId === "string" ? JSON.parse(accountId) : accountId;
    return c?.apiKey ? c : null;
  } catch {
    return null;
  }
};

const http = (token) =>
  axios.create({
    baseURL: BASE,
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
  });

const errText = (err) => {
  const d = err.response?.data;
  return d?.message || d?.error || (typeof d === "string" ? d.slice(0, 200) : "") || err.message;
};

// ── Messaging ────────────────────────────────────────────────────────────────

/** Same signature as every provider's sendDM (accountId = decrypted credential JSON). */
async function sendDM(accountId, recipientId, text, opts = {}) {
  const creds = readCreds(accountId);
  const to = normalisePhone(recipientId);
  if (!creds || !to) return { success: false, error: "WhatsApp isn't connected for this hotel." };
  const body = opts.mediaUrl
    ? { to, imageUrl: opts.mediaUrl, ...(text ? { text } : {}) }
    : { to, text: String(text || "") };
  try {
    const { data } = await http(creds.apiKey).post("/send-message", body);
    if (data?.success === false) return { success: false, error: data.message || "Send failed" };
    return { success: true, messageId: data?.data?.msgId ? String(data.data.msgId) : null };
  } catch (err) {
    const status = err.response?.status;
    logger.warn("[Wasender] send failed", { status, err: errText(err) });
    return {
      success: false,
      rateLimited: status === 429,
      error:
        status === 401
          ? "WhatsApp session key was rejected — reconnect WhatsApp in Settings → Channels."
          : errText(err),
    };
  }
}

/** Live session state with a session key ("connected", "need_scan", …). */
async function sessionStatus(apiKey) {
  const { data } = await http(apiKey).get("/status");
  return String(data?.status || data?.data?.status || "unknown").toLowerCase();
}

// ── Session management (Personal Access Token) ──────────────────────────────

async function createSession({ name, phoneNumber, webhookUrl }) {
  if (!canCreateSessions()) throw Object.assign(new Error("WASENDER_PAT not set"), { code: "no_pat" });
  const { data } = await http(PAT()).post("/whatsapp-sessions", {
    name: String(name || "Botlify hotel").slice(0, 60),
    phone_number: `+${normalisePhone(phoneNumber)}`,
    account_protection: true,
    log_messages: false,
    read_incoming_messages: true,
    auto_reject_calls: false,
    ignore_groups: true,
    ignore_channels: true,
    ignore_broadcasts: true,
    always_online: false,
    webhook_url: webhookUrl,
    webhook_enabled: true,
    webhook_events: ["messages.received", "session.status"],
  });
  const s = data?.data || data || {};
  if (!s.id || !s.api_key) throw new Error("WasenderAPI didn't return a session");
  return { sessionId: String(s.id), apiKey: s.api_key, webhookSecret: s.webhook_secret || "", status: s.status };
}

async function connectSession(sessionId) {
  const { data } = await http(PAT()).post(`/whatsapp-sessions/${encodeURIComponent(sessionId)}/connect`);
  return data?.data || data || {};
}

/** QR as a data: URL image the dashboard can show directly, or null. */
async function getQr(sessionId) {
  const { data } = await http(PAT()).get(`/whatsapp-sessions/${encodeURIComponent(sessionId)}/qrcode`);
  const raw = data?.data?.qrCode || data?.qrCode || null;
  if (!raw) return null;
  return QRCode.toDataURL(raw, { margin: 1, width: 320 });
}

async function getSession(sessionId) {
  const { data } = await http(PAT()).get(`/whatsapp-sessions/${encodeURIComponent(sessionId)}`);
  const s = data?.data || data || {};
  return { status: String(s.status || "unknown").toLowerCase(), phoneNumber: s.phone_number || null };
}

async function deleteSession(sessionId) {
  try {
    await http(PAT()).delete(`/whatsapp-sessions/${encodeURIComponent(sessionId)}`);
    return true;
  } catch (err) {
    logger.warn("[Wasender] delete session failed", { err: errText(err) });
    return false;
  }
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/** Guest messages only: never our own (fromMe), never groups/broadcasts/newsletters. */
function parseWebhook(body = {}) {
  const event = String(body.event || "").toLowerCase();
  if (!/messages?\.(received|upsert)/.test(event) && event !== "messages.personal.received") return [];
  const raw = body.data?.messages;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const m of list) {
    const key = m.key || {};
    if (key.fromMe) continue;
    const jid = String(key.remoteJid || "");
    if (/@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue;
    const from = normalisePhone(key.cleanedSenderPn || key.senderPn || (jid.endsWith("@s.whatsapp.net") ? jid : ""));
    if (!from) continue;
    const msg = m.message || {};
    out.push({
      from,
      name: m.pushName || m.notifyName || "",
      id: String(key.id || `${from}:${body.timestamp || Date.now()}`),
      text:
        m.messageBody ||
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        "",
      hasImage: !!msg.imageMessage,
    });
  }
  return out;
}

/** Session status webhooks: "session.status" → {status}. */
function parseSessionStatus(body = {}) {
  if (String(body.event || "").toLowerCase() !== "session.status") return null;
  return String(body.data?.status || "").toLowerCase() || null;
}

module.exports = {
  isConfigured,
  canCreateSessions,
  sendDM,
  sessionStatus,
  createSession,
  connectSession,
  getQr,
  getSession,
  deleteSession,
  parseWebhook,
  parseSessionStatus,
  readCreds,
  normalisePhone,
};
