/**
 * UltraMsg Service — Unofficial WhatsApp API (Free Tier)
 * Used for Starter plan QR-based connection
 * Docs: https://docs.ultramsg.com
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const ULTRAMSG_BASE_URL =
  process.env.ULTRAMSG_BASE_URL || "https://api.ultramsg.com";

const getAxiosConfig = () => ({ timeout: 15000 });

/**
 * Send a text message
 */
const sendTextMessage = async ({ instanceId, token, to, text }) => {
  try {
    const response = await axios.post(
      `${ULTRAMSG_BASE_URL}/${instanceId}/messages/chat`,
      new URLSearchParams({ token, to, body: text }),
      getAxiosConfig(),
    );
    return {
      success: true,
      messageId: response.data?.id,
      result: response.data,
    };
  } catch (err) {
    logger.error("UltraMsg sendTextMessage error", {
      error: err.response?.data || err.message,
      to,
    });
    return { success: false, error: err.response?.data?.error || err.message };
  }
};

/**
 * Send an image message
 */
const sendImageMessage = async ({
  instanceId,
  token,
  to,
  imageUrl,
  caption,
}) => {
  try {
    const response = await axios.post(
      `${ULTRAMSG_BASE_URL}/${instanceId}/messages/image`,
      new URLSearchParams({
        token,
        to,
        image: imageUrl,
        caption: caption || "",
      }),
      getAxiosConfig(),
    );
    return { success: true, messageId: response.data?.id };
  } catch (err) {
    logger.error(
      "UltraMsg sendImageMessage error",
      err.response?.data || err.message,
    );
    return { success: false, error: err.response?.data?.error || err.message };
  }
};

/**
 * Send a document
 */
const sendDocumentMessage = async ({
  instanceId,
  token,
  to,
  fileUrl,
  fileName,
}) => {
  try {
    const response = await axios.post(
      `${ULTRAMSG_BASE_URL}/${instanceId}/messages/document`,
      new URLSearchParams({
        token,
        to,
        document: fileUrl,
        filename: fileName || "document",
      }),
      getAxiosConfig(),
    );
    return { success: true, messageId: response.data?.id };
  } catch (err) {
    logger.error(
      "UltraMsg sendDocumentMessage error",
      err.response?.data || err.message,
    );
    return { success: false, error: err.response?.data?.error || err.message };
  }
};

/**
 * Get current instance status (for QR code display & connection check)
 */
const getInstanceStatus = async ({ instanceId, token }) => {
  try {
    const response = await axios.get(
      `${ULTRAMSG_BASE_URL}/${instanceId}/instance/status`,
      { params: { token }, ...getAxiosConfig() },
    );
    const { status, accountStatus, qrCode } = response.data;
    return {
      success: true,
      connected: accountStatus === "authenticated",
      status,
      accountStatus,
      qrCode: qrCode || null,
    };
  } catch (err) {
    logger.error(
      "UltraMsg getInstanceStatus error",
      err.response?.data || err.message,
    );
    return { success: false, connected: false, error: err.message };
  }
};

/**
 * Get QR code for scanning
 */
const getQRCode = async ({ instanceId, token }) => {
  try {
    const response = await axios.get(
      `${ULTRAMSG_BASE_URL}/${instanceId}/instance/qr`,
      { params: { token }, ...getAxiosConfig() },
    );
    return { success: true, qrCode: response.data?.qrCode };
  } catch (err) {
    logger.error("UltraMsg getQRCode error", err.response?.data || err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Get QR as base64 image
 */
const getQRCodeImage = async ({ instanceId, token }) => {
  try {
    const response = await axios.get(
      `${ULTRAMSG_BASE_URL}/${instanceId}/instance/qrCode`,
      { params: { token }, ...getAxiosConfig() },
    );
    return { success: true, qrCodeImage: response.data?.qrCode };
  } catch (err) {
    logger.error(
      "UltraMsg getQRCodeImage error",
      err.response?.data || err.message,
    );
    return { success: false, error: err.message };
  }
};

/**
 * Parse UltraMsg webhook payload
 */
const parseWebhookPayload = (body) => {
  if (!body || body.type !== "notification_received") return null;

  const data = body.data;
  return {
    from: data?.from?.replace("@c.us", ""),
    to: data?.to?.replace("@c.us", ""),
    body: data?.body,
    type: data?.type, // 'chat', 'image', 'document', etc.
    mediaUrl: data?.media,
    timestamp: data?.timestamp,
    id: data?.id,
    instanceId: data?.instanceId,
  };
};

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  getInstanceStatus,
  getQRCode,
  getQRCodeImage,
  parseWebhookPayload,
};
