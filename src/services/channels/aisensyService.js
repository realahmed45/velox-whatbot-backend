/**
 * aisensyService — WhatsApp via AiSensy (official Meta BSP). The owner's choice
 * for WhatsApp as of Nov 2026 (replacing Zernio; 360dialog stays as a spare
 * driver).
 *
 * Each hotel brings its own AiSensy project. We store, encrypted, the project
 * id + Project API password as the workspace.channels entry's accountId (JSON),
 * so the automation engine's transport stays provider-agnostic.
 *
 * Project API (AiSensy official reference, aisensy.stoplight.io → Project API):
 *   send   POST {AISENSY_API_BASE}/project/{projectId}/messages
 *          header  X-AiSensy-Project-API-Pwd: <password>
 *          body    { to, type:"text", recipient_type:"individual", text:{ body } }
 *   Project APIs need AiSensy's Pro plan; webhooks need Premium.
 *
 * Webhooks: the hotel adds our per-connection URL in AiSensy → Developer Hub →
 * Webhooks. The exact AiSensy webhook envelope isn't machine-readable in their
 * public docs, so parseWebhook() accepts both shapes seen in the wild:
 *   - Meta Cloud API: entry[].changes[].value.{contacts, messages}
 *   - AiSensy envelope: { topic|event, data: { message: { phone_number|from,
 *       userName|name, message_type|type, message_content|text, id|messageId,
 *       sender } } }  (only USER/inbound messages are returned)
 *
 * Env: AISENSY_API_BASE (default https://apis.aisensy.com/project-apis/v1)
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE = (process.env.AISENSY_API_BASE || "https://apis.aisensy.com/project-apis/v1").replace(/\/$/, "");

const isConfigured = () => true;
const normalisePhone = (p) => String(p || "").replace(/[^\d]/g, "");

/** accountId is the decrypted JSON {projectId, password}. */
const readCreds = (accountId) => {
  try {
    const c = typeof accountId === "string" ? JSON.parse(accountId) : accountId;
    return c?.projectId && c?.password ? c : null;
  } catch {
    return null;
  }
};

const client = (creds) =>
  axios.create({
    baseURL: `${BASE}/project/${encodeURIComponent(creds.projectId)}`,
    timeout: 15000,
    headers: { "X-AiSensy-Project-API-Pwd": creds.password, "Content-Type": "application/json" },
  });

const isOutsideWindowError = (data = {}) => {
  const blob = JSON.stringify(data || {}).toLowerCase();
  return blob.includes("131047") || blob.includes("re-engagement") || blob.includes("24 hour") || blob.includes("session expired");
};

/**
 * Send a WhatsApp message — same signature as every provider's sendDM.
 * @param {string} accountId  decrypted JSON credentials
 */
async function sendDM(accountId, recipientId, text, opts = {}) {
  const creds = readCreds(accountId);
  const to = normalisePhone(recipientId);
  if (!creds || !to) return { success: false, error: "WhatsApp isn't connected for this hotel." };
  const body = opts.mediaUrl
    ? {
        to,
        recipient_type: "individual",
        type: opts.mediaType === "document" ? "document" : "image",
        [opts.mediaType === "document" ? "document" : "image"]: {
          link: opts.mediaUrl,
          ...(text ? { caption: text } : {}),
        },
      }
    : { to, recipient_type: "individual", type: "text", text: { body: String(text || "") } };
  try {
    const { data } = await client(creds).post("/messages", body);
    return { success: true, messageId: data?.messages?.[0]?.id || data?.id || data?.messageId || null };
  } catch (err) {
    const d = err.response?.data || {};
    const outsideWindow = isOutsideWindowError(d);
    logger.warn("[AiSensy] send failed", { status: err.response?.status, err: JSON.stringify(d).slice(0, 300) });
    return {
      success: false,
      outsideWindow,
      rateLimited: err.response?.status === 429,
      error: outsideWindow
        ? "This guest last messaged over 24 hours ago, so WhatsApp only allows an approved template message. Ask them to message again, or send a template."
        : d?.message || d?.error?.message || err.message,
    };
  }
}

/**
 * Check the credentials. AiSensy has no documented "whoami", so we read a
 * message id that can't exist: 401/403 = wrong password or project, 404 (or
 * any other answer from AiSensy) = credentials accepted.
 */
async function verifyCredentials(creds) {
  try {
    await client(creds).get("/messages/botlify-credential-check");
    return { ok: true };
  } catch (err) {
    const s = err.response?.status;
    if (s === 401 || s === 403) return { ok: false, reason: "rejected" };
    if (!err.response) return { ok: false, reason: "unreachable", detail: err.message };
    return { ok: true };
  }
}

const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");

/** Inbound guest messages from either webhook shape. Status/outbound events are skipped. */
function parseWebhook(body = {}) {
  const out = [];
  // Meta Cloud API shape
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
      for (const m of v.messages || []) {
        const media = m.image || m.document || m.audio || m.video || null;
        out.push({
          from: m.from,
          name: names[m.from] || "",
          id: m.id,
          type: m.type,
          text: pick(m.text?.body, m.button?.text, m.interactive?.button_reply?.title, m.interactive?.list_reply?.title, media?.caption) || "",
          mediaUrl: media?.link || media?.url || null,
          displayPhone: v.metadata?.display_phone_number || null,
        });
      }
    }
  }
  if (out.length) return out;

  // AiSensy envelope (single event or list)
  const events = Array.isArray(body) ? body : body.events || [body];
  for (const evt of events) {
    const topic = String(pick(evt.topic, evt.event, evt.type, "") || "").toLowerCase();
    const m = evt.data?.message || evt.message || evt.data || {};
    const sender = String(pick(m.sender, m.direction, m.from_type, "") || "").toLowerCase();
    // Only the guest's own messages — never echoes of what we/agents sent.
    const inbound =
      sender === "user" || sender === "customer" || sender === "inbound" || topic.includes("sender.user") || topic.includes("incoming") || topic.includes("received");
    if (!inbound || topic.includes("status") || topic.includes("agent") || topic.includes("sent")) continue;
    const content = m.message_content || m.content || {};
    const from = normalisePhone(pick(m.phone_number, m.from, m.waId, m.wa_id, evt.data?.phone_number, m.userNumber));
    if (!from) continue;
    out.push({
      from,
      name: pick(m.userName, m.name, m.contact_name, evt.data?.userName, "") || "",
      id: String(pick(m.id, m.messageId, m.message_id, m.wamid, `${from}:${Date.now()}`)),
      type: pick(m.message_type, m.type, "text"),
      text: pick(content.text, content.body, content.caption, typeof content === "string" ? content : undefined, m.text?.body, m.text, m.body) || "",
      mediaUrl: pick(content.url, content.link, m.mediaUrl, null),
      displayPhone: pick(evt.data?.business_number, m.business_number, null),
    });
  }
  return out;
}

module.exports = { isConfigured, sendDM, verifyCredentials, parseWebhook, readCreds, normalisePhone };
