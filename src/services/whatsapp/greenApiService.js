/**
 * Botlify Cloud WhatsApp Provider (white-labeled internally)
 *
 * IMPORTANT: this provider is exposed to end-users as "Botlify Cloud" only.
 * Never reference the underlying vendor name in user-facing strings,
 * error messages, frontend, API responses or response payloads.
 *
 * Internally we wrap the Green-API REST endpoints. Backend logs may include
 * the vendor name (developer-only) but anything sent to the client must
 * be vendor-neutral.
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE = process.env.GREEN_API_BASE || "https://api.green-api.com";

const buildUrl = (idInstance, apiTokenInstance, path) =>
  `${BASE}/waInstance${idInstance}/${path}/${apiTokenInstance}`;

const safeError = (err, fallback = "Connection failed") => {
  // Strip vendor identifiers from error before returning
  const raw = err.response?.data?.message || err.message || fallback;
  return String(raw)
    .replace(/green[- ]?api/gi, "Botlify Cloud")
    .replace(/waInstance\d+/gi, "instance");
};

/**
 * Normalize phone (E.164 → chatId expected by provider: digits + @c.us)
 */
const toChatId = (phone) => {
  if (!phone) return null;
  if (String(phone).includes("@")) return String(phone);
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@c.us`;
};

const fromChatId = (chatId) => {
  if (!chatId) return null;
  return `+${String(chatId).split("@")[0]}`;
};

// ──────────────────────────────────────────────────────────
// Instance state / QR
// ──────────────────────────────────────────────────────────
const getStateInstance = async ({ idInstance, apiTokenInstance }) => {
  try {
    const { data } = await axios.get(
      buildUrl(idInstance, apiTokenInstance, "getStateInstance"),
      { timeout: 10000 },
    );
    return { success: true, state: data?.stateInstance || "unknown" };
  } catch (err) {
    logger.error("[cloud] getStateInstance error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const getQr = async ({ idInstance, apiTokenInstance }) => {
  try {
    const { data } = await axios.get(
      buildUrl(idInstance, apiTokenInstance, "qr"),
      { timeout: 15000 },
    );
    // data: { type: "qrCode" | "alreadyLogged" | "error", message: "<base64>" }
    if (data?.type === "qrCode") {
      return { success: true, qr: data.message, status: "pending" };
    }
    if (data?.type === "alreadyLogged") {
      return { success: true, qr: null, status: "authorized" };
    }
    return { success: true, qr: null, status: "error", message: data?.message };
  } catch (err) {
    logger.error("[cloud] getQr error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const getWaSettings = async ({ idInstance, apiTokenInstance }) => {
  try {
    const { data } = await axios.get(
      buildUrl(idInstance, apiTokenInstance, "getWaSettings"),
      { timeout: 10000 },
    );
    return { success: true, settings: data };
  } catch (err) {
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Webhook configuration
// ──────────────────────────────────────────────────────────
const setSettings = async ({
  idInstance,
  apiTokenInstance,
  webhookUrl,
  webhookUrlToken,
}) => {
  try {
    const body = {
      webhookUrl: webhookUrl || "",
      webhookUrlToken: webhookUrlToken || "",
      incomingWebhook: "yes",
      outgoingMessageWebhook: "no",
      outgoingAPIMessageWebhook: "no",
      stateWebhook: "yes",
      deviceWebhook: "no",
      statusInstanceWebhook: "yes",
      markIncomingMessagesReaded: "no",
    };
    const { data } = await axios.post(
      buildUrl(idInstance, apiTokenInstance, "setSettings"),
      body,
      { timeout: 15000 },
    );
    return { success: true, result: data };
  } catch (err) {
    logger.error("[cloud] setSettings error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const logout = async ({ idInstance, apiTokenInstance }) => {
  try {
    await axios.get(buildUrl(idInstance, apiTokenInstance, "logout"), {
      timeout: 10000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Sending
// ──────────────────────────────────────────────────────────
const sendTextMessage = async ({ idInstance, apiTokenInstance, to, text }) => {
  try {
    const { data } = await axios.post(
      buildUrl(idInstance, apiTokenInstance, "sendMessage"),
      { chatId: toChatId(to), message: text },
      { timeout: 15000 },
    );
    return { success: true, messageId: data?.idMessage };
  } catch (err) {
    logger.error("[cloud] sendTextMessage error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const sendImageMessage = async ({
  idInstance,
  apiTokenInstance,
  to,
  imageUrl,
  caption,
}) => {
  try {
    const { data } = await axios.post(
      buildUrl(idInstance, apiTokenInstance, "sendFileByUrl"),
      {
        chatId: toChatId(to),
        urlFile: imageUrl,
        fileName: "image.jpg",
        caption: caption || "",
      },
      { timeout: 20000 },
    );
    return { success: true, messageId: data?.idMessage };
  } catch (err) {
    logger.error("[cloud] sendImageMessage error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

const sendDocumentMessage = async ({
  idInstance,
  apiTokenInstance,
  to,
  fileUrl,
  fileName,
}) => {
  try {
    const { data } = await axios.post(
      buildUrl(idInstance, apiTokenInstance, "sendFileByUrl"),
      {
        chatId: toChatId(to),
        urlFile: fileUrl,
        fileName: fileName || "document.pdf",
        caption: "",
      },
      { timeout: 20000 },
    );
    return { success: true, messageId: data?.idMessage };
  } catch (err) {
    return { success: false, error: safeError(err) };
  }
};

// ──────────────────────────────────────────────────────────
// Webhook payload parsing
// ──────────────────────────────────────────────────────────
/**
 * Parse incoming webhook from provider.
 * Returns { idInstance, type, from, body, mediaUrl, messageId }
 * or null if irrelevant (status/state events).
 */
const parseWebhookPayload = (body) => {
  if (!body || typeof body !== "object") return null;
  const idInstance = body.instanceData?.idInstance;
  const type = body.typeWebhook;

  if (type !== "incomingMessageReceived") {
    return { idInstance, type, _skip: true };
  }

  const senderData = body.senderData || {};
  const messageData = body.messageData || {};
  const chatId = senderData.chatId;
  const from = fromChatId(chatId);
  const senderName = senderData.senderName;

  let messageType = messageData.typeMessage;
  let bodyText = "";
  let mediaUrl = null;

  switch (messageType) {
    case "textMessage":
    case "extendedTextMessage":
      bodyText =
        messageData.textMessageData?.textMessage ||
        messageData.extendedTextMessageData?.text ||
        "";
      messageType = "text";
      break;
    case "imageMessage":
      bodyText = messageData.fileMessageData?.caption || "[image]";
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      messageType = "image";
      break;
    case "videoMessage":
      bodyText = messageData.fileMessageData?.caption || "[video]";
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      messageType = "video";
      break;
    case "audioMessage":
    case "voiceMessage":
      bodyText = "[audio]";
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      messageType = "audio";
      break;
    case "documentMessage":
      bodyText =
        messageData.fileMessageData?.caption ||
        messageData.fileMessageData?.fileName ||
        "[document]";
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      messageType = "document";
      break;
    case "buttonsResponseMessage":
    case "listResponseMessage":
      bodyText =
        messageData.buttonsResponseMessage?.selectedDisplayText ||
        messageData.listResponseMessage?.title ||
        "";
      messageType = "interactive";
      break;
    default:
      bodyText = "[unsupported]";
  }

  return {
    idInstance,
    type: messageType,
    from,
    senderName,
    body: bodyText,
    mediaUrl,
    messageId: body.idMessage,
    timestamp: body.timestamp,
    _skip: false,
  };
};

module.exports = {
  // state / QR
  getStateInstance,
  getQr,
  getWaSettings,
  // config
  setSettings,
  logout,
  // send
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  // parse
  parseWebhookPayload,
  // helpers
  toChatId,
  fromChatId,
};
