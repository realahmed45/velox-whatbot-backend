/**
 * Botlify Cloud Pro — Official WhatsApp Cloud API (Kapso adapter).
 *
 * White-labeled internally as "Botlify Cloud Pro". Customers never see the
 * upstream provider name. All vendor strings are stripped from error
 * surfaces via safeError().
 *
 * Required env:
 *   KAPSO_API_KEY            project API key (X-API-Key header)
 *   KAPSO_PROJECT_WEBHOOK_SECRET  HMAC SHA256 secret for project webhook
 *   KAPSO_BASE_URL           optional, defaults to https://api.kapso.ai
 *
 * Endpoints (Platform v1, base = https://api.kapso.ai/platform/v1):
 *   POST /customers
 *   POST /customers/{customer_id}/setup_links
 *   DELETE /customers/{customer_id}
 *   GET  /phone_numbers/{phone_number_id}
 *   DELETE /phone_numbers/{phone_number_id}
 *
 * Send-message (Meta API base = https://api.kapso.ai/meta/whatsapp):
 *   POST /v1/{phone_number_id}/messages
 */
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../../utils/logger");

const BASE = (process.env.KAPSO_BASE_URL || "https://api.kapso.ai").replace(
  /\/$/,
  "",
);
const API_KEY = process.env.KAPSO_API_KEY;
const WEBHOOK_SECRET = process.env.KAPSO_PROJECT_WEBHOOK_SECRET || "";

const PLATFORM = `${BASE}/platform/v1`;
const META = `${BASE}/meta/whatsapp`;

const isConfigured = () => !!API_KEY;

const headers = () => ({
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
});

const VENDOR_RX = /kapso/gi;
const safeError = (err) => {
  const raw = err?.response?.data?.error || err?.message || "Provider error";
  return String(raw).replace(VENDOR_RX, "Botlify Cloud");
};

// ──────────────────────────────────────────────────────────
// Customers
// ──────────────────────────────────────────────────────────
const createCustomer = async ({ name, externalId }) => {
  if (!isConfigured()) {
    return { success: false, error: "Provisioning not configured" };
  }
  try {
    const { data } = await axios.post(
      `${PLATFORM}/customers`,
      {
        customer: {
          name: String(name || "Botlify Customer").slice(0, 80),
          external_customer_id: externalId ? String(externalId) : undefined,
        },
      },
      { headers: headers(), timeout: 15000 },
    );
    return { success: true, customerId: data?.data?.id, customer: data?.data };
  } catch (err) {
    logger.error("[kapso] createCustomer", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const deleteCustomer = async (customerId) => {
  if (!isConfigured() || !customerId) return { success: false };
  try {
    await axios.delete(`${PLATFORM}/customers/${customerId}`, {
      headers: headers(),
      timeout: 15000,
    });
    return { success: true };
  } catch (err) {
    if (err?.response?.status === 404)
      return { success: true, alreadyGone: true };
    logger.warn("[kapso] deleteCustomer", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Setup links — embedded signup URL per customer
// ──────────────────────────────────────────────────────────
/**
 * @param {Object} opts
 * @param {string} opts.customerId
 * @param {string} opts.successUrl
 * @param {string} opts.failureUrl
 * @param {boolean} [opts.instantNumber]   when true → auto-provision a US number
 * @param {string}  [opts.areaCode]        US area code (instant only)
 * @param {("coexistence"|"dedicated")} [opts.connectionType]
 * @param {Object}  [opts.theme]           hex colors
 * @param {string}  [opts.language]        en/es/pt/hi/id/ar
 */
const createSetupLink = async ({
  customerId,
  successUrl,
  failureUrl,
  instantNumber = false,
  areaCode,
  connectionType,
  theme,
  language,
}) => {
  if (!isConfigured()) {
    return { success: false, error: "Provisioning not configured" };
  }
  if (!customerId) return { success: false, error: "customerId required" };

  const body = { setup_link: {} };
  if (successUrl) body.setup_link.success_redirect_url = successUrl;
  if (failureUrl) body.setup_link.failure_redirect_url = failureUrl;

  if (instantNumber) {
    body.setup_link.provision_phone_number = true;
    body.setup_link.phone_number_country_isos = ["US"];
    if (areaCode) body.setup_link.phone_number_area_code = String(areaCode);
    body.setup_link.allowed_connection_types = ["dedicated"];
  } else if (connectionType) {
    body.setup_link.allowed_connection_types = [connectionType];
  }
  if (theme) body.setup_link.theme_config = theme;
  if (language) body.setup_link.language = language;

  try {
    const { data } = await axios.post(
      `${PLATFORM}/customers/${customerId}/setup_links`,
      body,
      { headers: headers(), timeout: 20000 },
    );
    return {
      success: true,
      url: data?.data?.url,
      setupLinkId: data?.data?.id,
      expiresAt: data?.data?.expires_at,
    };
  } catch (err) {
    logger.error("[kapso] createSetupLink", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Phone numbers
// ──────────────────────────────────────────────────────────
const getPhoneNumber = async (phoneNumberId) => {
  if (!isConfigured() || !phoneNumberId) return { success: false };
  try {
    const { data } = await axios.get(
      `${PLATFORM}/phone_numbers/${phoneNumberId}`,
      { headers: headers(), timeout: 12000 },
    );
    return { success: true, data: data?.data };
  } catch (err) {
    return { success: false, error: safeError(err) };
  }
};

const deletePhoneNumber = async (phoneNumberId) => {
  if (!isConfigured() || !phoneNumberId) return { success: false };
  try {
    await axios.delete(`${PLATFORM}/phone_numbers/${phoneNumberId}`, {
      headers: headers(),
      timeout: 12000,
    });
    return { success: true };
  } catch (err) {
    if (err?.response?.status === 404)
      return { success: true, alreadyGone: true };
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Send messages — uses Meta-compatible endpoint Kapso proxies.
// Body shape mirrors Meta Cloud API.
// ──────────────────────────────────────────────────────────
const sendRaw = async ({ phoneNumberId, body }) => {
  if (!isConfigured()) {
    return { success: false, error: "Provider not configured" };
  }
  if (!phoneNumberId) {
    return { success: false, error: "phoneNumberId required" };
  }
  try {
    const { data } = await axios.post(
      `${META}/v1/${phoneNumberId}/messages`,
      body,
      { headers: headers(), timeout: 20000 },
    );
    const messageId = data?.messages?.[0]?.id || data?.data?.id;
    return { success: true, messageId, raw: data };
  } catch (err) {
    logger.error("[kapso] send", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const sendTextMessage = ({ phoneNumberId, to, text }) =>
  sendRaw({
    phoneNumberId,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: String(text || "").slice(0, 4096), preview_url: false },
    },
  });

const sendImageMessage = ({ phoneNumberId, to, imageUrl, caption }) =>
  sendRaw({
    phoneNumberId,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, caption },
    },
  });

const sendDocumentMessage = ({
  phoneNumberId,
  to,
  fileUrl,
  fileName,
  caption,
}) =>
  sendRaw({
    phoneNumberId,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { link: fileUrl, filename: fileName, caption },
    },
  });

const sendButtonMessage = ({
  phoneNumberId,
  to,
  bodyText,
  buttons,
  headerText,
  footerText,
}) => {
  // Meta interactive button format. Max 3 buttons.
  const btns = (buttons || []).slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: {
      id: b.id || `btn_${i}`,
      title: String(b.label || b.title || `Option ${i + 1}`).slice(0, 20),
    },
  }));
  return sendRaw({
    phoneNumberId,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        ...(headerText
          ? { header: { type: "text", text: String(headerText).slice(0, 60) } }
          : {}),
        body: { text: String(bodyText || "").slice(0, 1024) },
        ...(footerText
          ? { footer: { text: String(footerText).slice(0, 60) } }
          : {}),
        action: { buttons: btns },
      },
    },
  });
};

const sendListMessage = ({
  phoneNumberId,
  to,
  bodyText,
  buttonText,
  sections,
  headerText,
  footerText,
}) =>
  sendRaw({
    phoneNumberId,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        ...(headerText
          ? { header: { type: "text", text: String(headerText).slice(0, 60) } }
          : {}),
        body: { text: String(bodyText || "").slice(0, 1024) },
        ...(footerText
          ? { footer: { text: String(footerText).slice(0, 60) } }
          : {}),
        action: {
          button: String(buttonText || "Choose").slice(0, 20),
          sections: sections || [],
        },
      },
    },
  });

// ──────────────────────────────────────────────────────────
// Webhook helpers
// ──────────────────────────────────────────────────────────
/**
 * Verifies Kapso project webhook signature (HMAC SHA256 of raw body).
 * Pass the RAW body buffer (Express raw middleware) AND the signature header.
 */
const verifyWebhookSignature = ({ rawBody, signature }) => {
  if (!WEBHOOK_SECRET) return true; // skip if not configured (dev)
  if (!signature) return false;
  try {
    const buf = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(
          typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {}),
        );
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(buf)
      .digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

/**
 * Normalizes an inbound Kapso webhook event into a shape the bot engine can
 * consume. Returns null for events we don't act on.
 *
 * Notable events:
 *   whatsapp.phone_number.created — customer finished onboarding
 *   whatsapp.message.received     — inbound message
 *   whatsapp.message.status       — delivery status update
 */
const parseWebhookPayload = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const event = payload.event || payload.type || "";
  const data = payload.data || payload;

  if (event === "whatsapp.phone_number.created") {
    return {
      _kind: "phone_connected",
      phoneNumberId: data.phone_number_id || data.phone_number?.id,
      customerId: data.customer?.id,
      displayPhoneNumber: data.phone_number?.display_phone_number,
      wabaId: data.business_account_id,
    };
  }

  if (event === "whatsapp.message.received" || event === "message.received") {
    const msg = data.message || data;
    const from = msg.from || data.from;
    const phoneNumberId =
      data.phone_number_id || data.phone_number?.id || msg.phone_number_id;
    let body = "";
    let type = "text";
    let mediaUrl = null;

    if (msg.text?.body) {
      body = msg.text.body;
      type = "text";
    } else if (msg.interactive) {
      type = "interactive";
      body =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        "";
    } else if (msg.image) {
      type = "image";
      body = "[image]";
      mediaUrl = msg.image?.link || msg.image?.url || null;
    } else if (msg.document) {
      type = "document";
      body = "[document]";
      mediaUrl = msg.document?.link || msg.document?.url || null;
    } else if (msg.audio) {
      type = "audio";
      body = "[audio]";
      mediaUrl = msg.audio?.link || msg.audio?.url || null;
    } else if (msg.video) {
      type = "video";
      body = "[video]";
      mediaUrl = msg.video?.link || msg.video?.url || null;
    }

    return {
      _kind: "message",
      phoneNumberId,
      from,
      body,
      type,
      mediaUrl,
      buttonPayload:
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.id ||
        null,
    };
  }

  if (event === "whatsapp.message.status" || event === "message.status") {
    return {
      _kind: "status",
      phoneNumberId: data.phone_number_id,
      messageId: data.message_id || data.id,
      status: data.status,
    };
  }

  return null;
};

module.exports = {
  isConfigured,
  // customers
  createCustomer,
  deleteCustomer,
  // setup
  createSetupLink,
  // phone numbers
  getPhoneNumber,
  deletePhoneNumber,
  // send
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendButtonMessage,
  sendListMessage,
  // webhook
  verifyWebhookSignature,
  parseWebhookPayload,
};
