const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const metaService = require("../services/whatsapp/metaService");
const ultramsgService = require("../services/whatsapp/ultramsgService");
const { processIncomingMessage } = require("../services/botEngine");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

// @GET /api/whatsapp/webhook — Meta webhook verification
const verifyMetaWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info("Meta webhook verified");
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: "Webhook verification failed" });
};

// @POST /api/whatsapp/webhook — Meta webhook messages
const handleMetaWebhook = asyncHandler(async (req, res) => {
  // Verify signature
  const body = req.body;
  const payload = typeof body === "string" ? JSON.parse(body) : body;

  // Verify Meta signature
  if (!metaService.verifyWebhookSignature(req)) {
    logger.warn("Meta webhook signature verification failed");
    return res.status(403).json({ error: "Invalid signature" });
  }

  res.status(200).json({ status: "ok" }); // Always ACK immediately

  // Process async
  const parsed = metaService.parseWebhookPayload(payload);
  if (!parsed) return;

  const { messages, statuses, phoneNumberId } = parsed;

  // Find workspace by Meta phone number ID
  const allWorkspaces = await Workspace.find({
    "whatsapp.type": "meta",
    "whatsapp.status": "connected",
  }).select(
    "+whatsapp.metaPhoneNumberId +whatsapp.metaAccessToken +whatsapp.ultralmsgInstanceId +whatsapp.ultramsgToken",
  );

  const workspace = allWorkspaces.find((ws) => {
    const storedPhoneId = decrypt(ws.whatsapp.metaPhoneNumberId);
    return storedPhoneId === phoneNumberId;
  });

  if (!workspace) {
    logger.warn(`No workspace found for Meta phoneNumberId: ${phoneNumberId}`);
    return;
  }

  // Process each incoming message
  for (const msg of messages) {
    if (msg.type === "text") {
      await processIncomingMessage({
        workspace,
        phone: msg.from,
        messageBody: msg.text?.body,
        messageType: "text",
      });
    } else if (msg.type === "interactive") {
      const buttonId =
        msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
      const buttonTitle =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title;
      await processIncomingMessage({
        workspace,
        phone: msg.from,
        messageBody: buttonTitle,
        messageType: "interactive",
        buttonPayload: buttonId,
      });
    } else if (["image", "audio", "video", "document"].includes(msg.type)) {
      await processIncomingMessage({
        workspace,
        phone: msg.from,
        messageBody: `[${msg.type}]`,
        messageType: msg.type,
        mediaUrl: msg[msg.type]?.link,
      });
    }
  }

  // Handle status updates (delivered/read)
  for (const status of statuses) {
    const Message = require("../models/Message");
    if (["delivered", "read", "failed"].includes(status.status)) {
      await Message.findOneAndUpdate(
        { whatsappMessageId: status.id },
        { status: status.status, statusUpdatedAt: new Date() },
      );
    }
  }
});

// @POST /api/whatsapp/webhook/ultramsg — UltraMsg webhook
const handleUltramsgWebhook = asyncHandler(async (req, res) => {
  res.status(200).json({ status: "ok" });

  const parsed = ultramsgService.parseWebhookPayload(req.body);
  if (!parsed || !parsed.from) return;

  const { from: phone, body: messageBody, type, mediaUrl, instanceId } = parsed;

  // Find workspace by UltraMsg instance ID
  const allWorkspaces = await Workspace.find({
    "whatsapp.type": "ultramsg",
    "whatsapp.status": "connected",
  }).select("+whatsapp.ultralmsgInstanceId +whatsapp.ultramsgToken");

  const workspace = allWorkspaces.find((ws) => {
    const storedInstanceId = decrypt(ws.whatsapp.ultralmsgInstanceId);
    return storedInstanceId === instanceId;
  });

  if (!workspace) {
    logger.warn(`No workspace found for UltraMsg instance: ${instanceId}`);
    return;
  }

  await processIncomingMessage({
    workspace,
    phone,
    messageBody,
    messageType: type,
    mediaUrl,
  });
});

module.exports = {
  verifyMetaWebhook,
  handleMetaWebhook,
  handleUltramsgWebhook,
};
