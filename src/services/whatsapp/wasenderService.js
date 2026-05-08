/**
 * WasenderAPI service — paid managed WhatsApp gateway ($6/mo per number).
 *
 * Why this provider:
 *   - Cheap ($6/mo, no per-message fees)
 *   - QR-scan link, no Facebook signup required
 *   - Lower ban-rate than self-hosted Baileys (managed infra)
 *   - Official Node SDK + REST API
 *
 * Lifecycle:
 *   1. createSession() — workspace clicks "Connect" → we create a remote
 *      session, get a sessionId + apiKey, store encrypted on workspace.
 *   2. getQR() — frontend polls; returns QR code image (base64) until scanned.
 *   3. sendMessage() — text/image/document via REST.
 *   4. webhook — incoming messages arrive at /api/whatsapp/wasender/webhook
 *      and feed into processIncomingMessage.
 *
 * Reference: https://wasenderapi.com/api-docs
 */
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../../utils/logger");

const BASE_URL = process.env.WASENDER_BASE_URL || "https://wasenderapi.com/api";
// Account-level "personal access token" used to provision new sessions.
// Per-session API keys are returned by the create-session endpoint.
const ACCOUNT_TOKEN = process.env.WASENDER_ACCOUNT_TOKEN || "";

const client = (apiKey) =>
  axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${apiKey || ACCOUNT_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 25000,
  });

// ──────────────────────────────────────────────────────────
// Session lifecycle (account-scoped — uses ACCOUNT_TOKEN)
// ──────────────────────────────────────────────────────────

/**
 * Create a new WhatsApp session for a workspace.
 * Returns { sessionId, apiKey, webhookSecret }.
 */
async function createSession({ workspaceId, webhookUrl, phoneNumber }) {
  if (!ACCOUNT_TOKEN) {
    throw new Error("WASENDER_ACCOUNT_TOKEN not configured");
  }
  if (!phoneNumber) {
    throw new Error("phone_number is required to create a Wasender session");
  }
  const webhookSecret = crypto.randomBytes(24).toString("hex");
  try {
    const { data } = await client().post("/whatsapp-sessions", {
      name: `botlify-${workspaceId}`,
      phone_number: phoneNumber,
      account_protection: true,
      log_messages: true,
      webhook_url: webhookUrl,
      webhook_enabled: true,
      webhook_secret: webhookSecret,
      webhook_events: ["messages.upsert", "session.status"],
    });
    const session = data?.data || data;
    return {
      sessionId: String(session.id || session.session_id),
      apiKey: session.api_key || session.apiKey,
      webhookSecret,
    };
  } catch (err) {
    const payload = err.response?.data;
    logger.error("[wasender] createSession failed", payload || err.message);
    // Bubble up validation errors with field details so the UI can show them
    let msg = payload?.message || "Could not create WasenderAPI session";
    if (payload?.errors && typeof payload.errors === "object") {
      const flat = Object.values(payload.errors).flat().filter(Boolean);
      if (flat.length) msg = flat.join(" ");
    }
    const e = new Error(msg);
    e.status = err.response?.status;
    throw e;
  }
}

/**
 * Get the current QR code (base64 data URL) and connection status.
 * Status values: connecting | qr | connected | disconnected | failed
 */
async function getQR({ sessionId, apiKey }) {
  try {
    const { data } = await client(apiKey).get(
      `/whatsapp-sessions/${sessionId}/qrcode`,
    );
    const payload = data?.data || data || {};
    return {
      status: payload.status || "connecting",
      qr: payload.qr_code || payload.qrCode || null, // data URL
      phoneNumber: payload.phone_number || null,
      displayName: payload.name || null,
    };
  } catch (err) {
    logger.error("[wasender] getQR failed", err.response?.data || err.message);
    return { status: "error", qr: null, lastError: err.message };
  }
}

/**
 * Get session status (without forcing QR fetch).
 */
async function getStatus({ sessionId, apiKey }) {
  try {
    const { data } = await client(apiKey).get(
      `/whatsapp-sessions/${sessionId}/status`,
    );
    const p = data?.data || data || {};
    return {
      status: p.status || "unknown",
      phoneNumber: p.phone_number || null,
      displayName: p.name || null,
    };
  } catch (err) {
    return { status: "error", lastError: err.message };
  }
}

async function deleteSession({ sessionId, apiKey }) {
  try {
    await client(apiKey).delete(`/whatsapp-sessions/${sessionId}`);
    return { success: true };
  } catch (err) {
    logger.warn(
      "[wasender] deleteSession failed",
      err.response?.data || err.message,
    );
    return { success: false, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────
// Sending (uses per-session API key)
// ──────────────────────────────────────────────────────────

const toRecipient = (phone) => {
  if (!phone) return null;
  // Strip non-digits, accept already-formatted
  return String(phone).replace(/[^\d]/g, "");
};

async function sendTextMessage({ apiKey, to, text }) {
  try {
    const { data } = await client(apiKey).post("/send-message", {
      to: toRecipient(to),
      text,
    });
    return { success: true, messageId: data?.data?.id || data?.id };
  } catch (err) {
    logger.error(
      "[wasender] sendText failed",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
}

async function sendImageMessage({ apiKey, to, imageUrl, caption }) {
  try {
    const { data } = await client(apiKey).post("/send-image", {
      to: toRecipient(to),
      imageUrl,
      text: caption || "",
    });
    return { success: true, messageId: data?.data?.id || data?.id };
  } catch (err) {
    logger.error(
      "[wasender] sendImage failed",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
}

async function sendDocumentMessage({ apiKey, to, fileUrl, fileName }) {
  try {
    const { data } = await client(apiKey).post("/send-document", {
      to: toRecipient(to),
      documentUrl: fileUrl,
      fileName: fileName || "document",
    });
    return { success: true, messageId: data?.data?.id || data?.id };
  } catch (err) {
    logger.error(
      "[wasender] sendDoc failed",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
}

async function sendVideoMessage({ apiKey, to, videoUrl, caption }) {
  try {
    const { data } = await client(apiKey).post("/send-video", {
      to: toRecipient(to),
      videoUrl,
      text: caption || "",
    });
    return { success: true, messageId: data?.data?.id || data?.id };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
}

async function sendAudioMessage({ apiKey, to, audioUrl }) {
  try {
    const { data } = await client(apiKey).post("/send-audio", {
      to: toRecipient(to),
      audioUrl,
    });
    return { success: true, messageId: data?.data?.id || data?.id };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.message || err.message,
    };
  }
}

// ──────────────────────────────────────────────────────────
// Webhook helpers
// ──────────────────────────────────────────────────────────

/**
 * Verify Wasender webhook signature.
 * They sign the raw body with HMAC-SHA256 using the per-session webhook secret.
 * Header: X-Wasender-Signature: sha256=<hex>
 */
function verifyWebhookSignature({ rawBody, signatureHeader, secret }) {
  if (!secret || !signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody))
    .digest("hex");
  const provided = String(signatureHeader).replace(/^sha256=/, "");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(provided, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Parse incoming Wasender webhook message into a normalized shape.
 * Their payload roughly looks like:
 *   { event: "messages.upsert", session_id, data: { from, type, text, ... } }
 */
function parseIncomingWebhook(payload) {
  if (!payload) return null;
  const event = payload.event || payload.type;
  const data = payload.data || payload.message || payload;
  const sessionId = String(payload.session_id || payload.sessionId || "");

  if (
    event !== "messages.upsert" &&
    event !== "message" &&
    event !== "message.received"
  ) {
    return { sessionId, event, skip: true };
  }

  // Skip messages we sent ourselves
  if (data.fromMe || data.from_me) return { sessionId, event, skip: true };

  const from = data.from || data.remoteJid || data.chat_id || "";
  const phone = String(from).split("@")[0].replace(/[^\d]/g, "");
  if (!phone) return null;

  let text = "";
  let messageType = "text";
  let mediaUrl = null;

  if (data.text) {
    text = data.text;
  } else if (data.body) {
    text = data.body;
  } else if (data.message?.conversation) {
    text = data.message.conversation;
  } else if (data.message?.extendedTextMessage?.text) {
    text = data.message.extendedTextMessage.text;
  }

  if (data.type === "image" || data.message?.imageMessage) {
    messageType = "image";
    mediaUrl = data.media_url || data.url || null;
    text = data.caption || data.message?.imageMessage?.caption || text;
  } else if (data.type === "video" || data.message?.videoMessage) {
    messageType = "video";
    mediaUrl = data.media_url || data.url || null;
    text = data.caption || text;
  } else if (data.type === "audio" || data.message?.audioMessage) {
    messageType = "audio";
    mediaUrl = data.media_url || data.url || null;
  } else if (data.type === "document" || data.message?.documentMessage) {
    messageType = "document";
    mediaUrl = data.media_url || data.url || null;
  }

  return {
    sessionId,
    event,
    phone,
    text: text || "",
    messageType,
    mediaUrl,
    senderName: data.pushName || data.sender_name || data.name || null,
    timestamp: data.timestamp || Date.now(),
    raw: payload,
  };
}

module.exports = {
  createSession,
  getQR,
  getStatus,
  deleteSession,
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendVideoMessage,
  sendAudioMessage,
  verifyWebhookSignature,
  parseIncomingWebhook,
};
