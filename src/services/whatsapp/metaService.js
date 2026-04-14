/**
 * Meta Cloud API (WhatsApp) Service
 * Official WhatsApp Business API for Growth, Business, Agency tiers
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const META_API_VERSION = process.env.META_API_VERSION || "v19.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * Send a text message via Meta Cloud API
 */
const sendTextMessage = async ({ phoneNumberId, accessToken, to, text }) => {
  try {
    const response = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    logger.error("Meta sendTextMessage error", {
      error: err.response?.data || err.message,
      to,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Send an image message
 */
const sendImageMessage = async ({
  phoneNumberId,
  accessToken,
  to,
  imageUrl,
  caption,
}) => {
  try {
    const response = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: imageUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    logger.error("Meta sendImageMessage error", {
      error: err.response?.data || err.message,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Send a document/PDF message
 */
const sendDocumentMessage = async ({
  phoneNumberId,
  accessToken,
  to,
  fileUrl,
  fileName,
  caption,
}) => {
  try {
    const response = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { link: fileUrl, filename: fileName, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    logger.error(
      "Meta sendDocumentMessage error",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Send interactive button message (up to 3 buttons)
 */
const sendButtonMessage = async ({
  phoneNumberId,
  accessToken,
  to,
  bodyText,
  buttons,
  headerText,
  footerText,
}) => {
  try {
    const interactiveButtons = buttons.map((btn) => ({
      type: "reply",
      reply: { id: btn.id, title: btn.label.slice(0, 20) },
    }));

    const response = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          ...(headerText && { header: { type: "text", text: headerText } }),
          body: { text: bodyText },
          ...(footerText && { footer: { text: footerText } }),
          action: { buttons: interactiveButtons },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    logger.error(
      "Meta sendButtonMessage error",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Send interactive list message (up to 10 items)
 */
const sendListMessage = async ({
  phoneNumberId,
  accessToken,
  to,
  bodyText,
  buttonText,
  sections,
  headerText,
  footerText,
}) => {
  try {
    const response = await axios.post(
      `${META_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          ...(headerText && { header: { type: "text", text: headerText } }),
          body: { text: bodyText },
          ...(footerText && { footer: { text: footerText } }),
          action: { button: buttonText || "View Options", sections },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    logger.error(
      "Meta sendListMessage error",
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Verify Meta webhook signature
 */
const verifyWebhookSignature = (req) => {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha256", process.env.META_APP_SECRET);
  const digest = "sha256=" + hmac.update(req.body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
};

/**
 * Parse incoming Meta webhook payload
 */
const parseWebhookPayload = (body) => {
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  if (!value) return null;

  const messages = value.messages || [];
  const statuses = value.statuses || [];
  const phoneNumberId = value.metadata?.phone_number_id;

  return { messages, statuses, phoneNumberId, contacts: value.contacts || [] };
};

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendButtonMessage,
  sendListMessage,
  verifyWebhookSignature,
  parseWebhookPayload,
};
