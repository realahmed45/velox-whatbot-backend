const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const metaService = require("../services/whatsapp/metaService");
const ultramsgService = require("../services/whatsapp/ultramsgService");
const greenApiService = require("../services/whatsapp/greenApiService");
const dispatcher = require("../services/whatsapp/dispatcher");
const { processIncomingMessage } = require("../services/botEngine");
const { encrypt, decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
const getWorkspaceId = (req) =>
  req.headers["x-workspace-id"] || req.user?.activeWorkspace || null;

const findWorkspace = async (req, withSecrets = false) => {
  const id = getWorkspaceId(req);
  if (!id) return null;
  let q = Workspace.findById(id);
  if (withSecrets) {
    q = q.select(
      "+whatsapp.metaPhoneNumberId +whatsapp.metaAccessToken " +
        "+whatsapp.metaWabaId +whatsapp.ultralmsgInstanceId " +
        "+whatsapp.ultramsgToken +whatsapp.cloudInstanceId " +
        "+whatsapp.cloudApiToken +whatsapp.cloudWebhookToken",
    );
  }
  return q;
};

const buildWebhookBaseUrl = () => {
  const base =
    process.env.PUBLIC_API_URL ||
    process.env.BACKEND_URL ||
    "https://botlify-backend.onrender.com";
  return base.replace(/\/$/, "");
};

const sanitizeWaForResponse = (workspace) => {
  if (!workspace?.whatsapp) return null;
  const w = workspace.whatsapp.toObject ? workspace.whatsapp.toObject() : workspace.whatsapp;
  // Strip credentials
  delete w.metaPhoneNumberId;
  delete w.metaAccessToken;
  delete w.metaWabaId;
  delete w.metaAppId;
  delete w.ultralmsgInstanceId;
  delete w.ultramsgToken;
  delete w.cloudInstanceId;
  delete w.cloudApiToken;
  delete w.cloudWebhookToken;
  return w;
};

// ──────────────────────────────────────────────────────────
// META WEBHOOK (existing official Cloud API)
// ──────────────────────────────────────────────────────────
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

const handleMetaWebhook = asyncHandler(async (req, res) => {
  const body = req.body;
  const payload = typeof body === "string" ? JSON.parse(body) : body;

  if (!metaService.verifyWebhookSignature(req)) {
    logger.warn("Meta webhook signature verification failed");
    return res.status(403).json({ error: "Invalid signature" });
  }
  res.status(200).json({ status: "ok" });

  const parsed = metaService.parseWebhookPayload(payload);
  if (!parsed) return;
  const { messages, statuses, phoneNumberId } = parsed;

  const all = await Workspace.find({
    "whatsapp.type": "meta",
    "whatsapp.status": "connected",
  }).select("+whatsapp.metaPhoneNumberId +whatsapp.metaAccessToken");

  const workspace = all.find(
    (ws) => decrypt(ws.whatsapp.metaPhoneNumberId) === phoneNumberId,
  );
  if (!workspace) return;

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

// ──────────────────────────────────────────────────────────
// ULTRAMSG WEBHOOK (legacy; kept for compatibility)
// ──────────────────────────────────────────────────────────
const handleUltramsgWebhook = asyncHandler(async (req, res) => {
  res.status(200).json({ status: "ok" });
  const parsed = ultramsgService.parseWebhookPayload(req.body);
  if (!parsed || !parsed.from) return;
  const { from: phone, body: messageBody, type, mediaUrl, instanceId } = parsed;

  const all = await Workspace.find({
    "whatsapp.type": "ultramsg",
    "whatsapp.status": "connected",
  }).select("+whatsapp.ultralmsgInstanceId +whatsapp.ultramsgToken");

  const workspace = all.find(
    (ws) => decrypt(ws.whatsapp.ultralmsgInstanceId) === instanceId,
  );
  if (!workspace) return;

  await processIncomingMessage({
    workspace,
    phone,
    messageBody,
    messageType: type,
    mediaUrl,
  });
});

// ──────────────────────────────────────────────────────────
// CLOUD WEBHOOK (Botlify Cloud — white-labeled)
// Path: /api/whatsapp/webhook/cloud/:token
// ──────────────────────────────────────────────────────────
const handleCloudWebhook = asyncHandler(async (req, res) => {
  // ACK fast
  res.status(200).json({ status: "ok" });

  const parsed = greenApiService.parseWebhookPayload(req.body);
  if (!parsed || parsed._skip || !parsed.idInstance) return;

  // Lookup workspace by encrypted idInstance
  const all = await Workspace.find({
    "whatsapp.type": "cloud",
  }).select("+whatsapp.cloudInstanceId +whatsapp.cloudWebhookToken");

  const incomingToken = req.params?.token || req.query?.token || null;
  const workspace = all.find((ws) => {
    try {
      if (decrypt(ws.whatsapp.cloudInstanceId) !== String(parsed.idInstance)) {
        return false;
      }
      // Optional shared-secret check for added safety
      if (ws.whatsapp.cloudWebhookToken && incomingToken) {
        return decrypt(ws.whatsapp.cloudWebhookToken) === incomingToken;
      }
      return true;
    } catch {
      return false;
    }
  });

  if (!workspace) {
    logger.warn(
      `[cloud webhook] no workspace match for idInstance=${parsed.idInstance}`,
    );
    return;
  }

  // Update last-seen
  workspace.whatsapp.lastWebhookAt = new Date();
  workspace.whatsapp.lastMessageAt = new Date();
  await workspace.save();

  await processIncomingMessage({
    workspace,
    phone: parsed.from,
    messageBody: parsed.body,
    messageType: parsed.type,
    mediaUrl: parsed.mediaUrl,
  });
});

// ──────────────────────────────────────────────────────────
// AUTHENTICATED ENDPOINTS
// ──────────────────────────────────────────────────────────

// @POST /api/whatsapp/onboard — generic, picks provider based on body.type
const onboardChannel = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, true));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });

  const { type } = req.body || {};
  if (!["meta", "ultramsg", "cloud"].includes(type)) {
    return res.status(400).json({ message: "Invalid provider" });
  }

  // META ───────────────────────────────────────────────────
  if (type === "meta") {
    const { phoneNumberId, accessToken, wabaId, displayName, phoneNumber } =
      req.body;
    if (!phoneNumberId || !accessToken) {
      return res
        .status(400)
        .json({ message: "Phone Number ID and Access Token are required" });
    }
    ws.whatsapp = {
      ...(ws.whatsapp?.toObject?.() || {}),
      type: "meta",
      status: "connected",
      metaPhoneNumberId: encrypt(phoneNumberId),
      metaAccessToken: encrypt(accessToken),
      metaWabaId: wabaId ? encrypt(wabaId) : undefined,
      displayName: displayName || ws.whatsapp?.displayName,
      phoneNumber: phoneNumber || ws.whatsapp?.phoneNumber,
      connectedAt: new Date(),
      botActive: true,
    };
    await ws.save();
    return res.json({
      success: true,
      whatsapp: sanitizeWaForResponse(ws),
    });
  }

  // ULTRAMSG ───────────────────────────────────────────────
  if (type === "ultramsg") {
    const { instanceId, token, displayName, phoneNumber } = req.body;
    if (!instanceId || !token) {
      return res
        .status(400)
        .json({ message: "Instance ID and Token are required" });
    }
    ws.whatsapp = {
      ...(ws.whatsapp?.toObject?.() || {}),
      type: "ultramsg",
      status: "connected",
      ultralmsgInstanceId: encrypt(instanceId),
      ultramsgToken: encrypt(token),
      displayName: displayName || ws.whatsapp?.displayName,
      phoneNumber: phoneNumber || ws.whatsapp?.phoneNumber,
      connectedAt: new Date(),
      botActive: true,
    };
    await ws.save();
    return res.json({ success: true, whatsapp: sanitizeWaForResponse(ws) });
  }

  // CLOUD ─────────────────────────────────────────────────
  // Body: { type:"cloud", idInstance, apiTokenInstance, displayName? }
  if (type === "cloud") {
    const { idInstance, apiTokenInstance, displayName } = req.body;
    if (!idInstance || !apiTokenInstance) {
      return res.status(400).json({
        message: "Connection ID and Connection Key are required",
      });
    }

    // ── Trial / plan gate ──────────────────────────────────
    // Live WhatsApp numbers carry per-number infrastructure cost, so we only
    // allow them on plans that include WhatsApp. Free trial users see a
    // friendly upsell instead of being able to provision a real number.
    const { planAllowsWhatsAppLiveNumber, getPlan } = require("../config/plans");
    const planId = ws.subscription?.plan || "free";
    const subStatus = ws.subscription?.status;
    const isTrialing = subStatus === "trialing" || planId === "free";
    if (isTrialing || !planAllowsWhatsAppLiveNumber(planId)) {
      const plan = getPlan(planId);
      return res.status(402).json({
        success: false,
        code: "PLAN_UPGRADE_REQUIRED",
        message:
          "Connecting a live WhatsApp number requires a paid WhatsApp or Bundle plan. " +
          "Upgrade to WhatsApp Starter, WhatsApp Pro, or Both Channels Pro to continue.",
        currentPlan: plan?.id || planId,
        upgradeOptions: ["wa_starter", "wa_pro", "bundle_pro"],
      });
    }

    // Validate creds by hitting state endpoint
    const stateResp = await greenApiService.getStateInstance({
      idInstance,
      apiTokenInstance,
    });
    if (!stateResp.success) {
      return res.status(400).json({
        message:
          "Could not reach Botlify Cloud with those credentials. Double-check and try again.",
      });
    }

    // Auto-configure webhook so we get incoming messages
    const webhookToken = crypto.randomBytes(20).toString("hex");
    const webhookUrl = `${buildWebhookBaseUrl()}/api/whatsapp/webhook/cloud/${webhookToken}`;
    const settingsResp = await greenApiService.setSettings({
      idInstance,
      apiTokenInstance,
      webhookUrl,
      webhookUrlToken: webhookToken,
    });
    if (!settingsResp.success) {
      logger.warn("[cloud onboard] setSettings failed", settingsResp.error);
    }

    ws.whatsapp = {
      ...(ws.whatsapp?.toObject?.() || {}),
      type: "cloud",
      status: stateResp.state === "authorized" ? "connected" : "pending",
      cloudInstanceId: encrypt(String(idInstance)),
      cloudApiToken: encrypt(String(apiTokenInstance)),
      cloudWebhookToken: encrypt(webhookToken),
      cloudState: stateResp.state || "unknown",
      displayName: displayName || ws.whatsapp?.displayName || "Botlify",
      connectedAt: new Date(),
      webhookSubscribed: !!settingsResp.success,
      botActive: true,
    };
    await ws.save();

    return res.json({
      success: true,
      needsQrScan: stateResp.state !== "authorized",
      cloudState: stateResp.state,
      whatsapp: sanitizeWaForResponse(ws),
    });
  }
});

// @GET /api/whatsapp/cloud/qr — proxy QR fetch to provider
const getCloudQr = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, true));
  if (!ws || ws.whatsapp?.type !== "cloud") {
    return res.status(400).json({ message: "Cloud connection not configured" });
  }
  const idInstance = decrypt(ws.whatsapp.cloudInstanceId);
  const apiTokenInstance = decrypt(ws.whatsapp.cloudApiToken);

  const stateResp = await greenApiService.getStateInstance({
    idInstance,
    apiTokenInstance,
  });
  if (stateResp.success && stateResp.state === "authorized") {
    // Already linked — sync state
    if (
      ws.whatsapp.status !== "connected" ||
      ws.whatsapp.cloudState !== "authorized"
    ) {
      ws.whatsapp.status = "connected";
      ws.whatsapp.cloudState = "authorized";
      await ws.save();
    }
    return res.json({ status: "authorized", qr: null });
  }

  const qrResp = await greenApiService.getQr({ idInstance, apiTokenInstance });
  if (!qrResp.success) {
    return res
      .status(502)
      .json({ message: "Could not fetch link code right now. Try again." });
  }
  if (qrResp.status === "authorized") {
    ws.whatsapp.status = "connected";
    ws.whatsapp.cloudState = "authorized";
    await ws.save();
    return res.json({ status: "authorized", qr: null });
  }
  return res.json({
    status: qrResp.status || "pending",
    qr: qrResp.qr || null,
  });
});

// @GET /api/whatsapp/cloud/state
const getCloudState = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, true));
  if (!ws || ws.whatsapp?.type !== "cloud") {
    return res.status(400).json({ message: "Cloud connection not configured" });
  }
  const idInstance = decrypt(ws.whatsapp.cloudInstanceId);
  const apiTokenInstance = decrypt(ws.whatsapp.cloudApiToken);
  const r = await greenApiService.getStateInstance({
    idInstance,
    apiTokenInstance,
  });
  if (r.success && ws.whatsapp.cloudState !== r.state) {
    ws.whatsapp.cloudState = r.state;
    if (r.state === "authorized" && ws.whatsapp.status !== "connected") {
      ws.whatsapp.status = "connected";
    }
    await ws.save();
  }
  res.json({ state: r.state || "unknown" });
});

// @GET /api/whatsapp/status
const getStatus = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, false));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });
  res.json({ whatsapp: sanitizeWaForResponse(ws) });
});

// @POST /api/whatsapp/test  body: { phone, message? }
const sendTestMessage = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, true));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });
  const { phone, message } = req.body || {};
  if (!phone) return res.status(400).json({ message: "Phone is required" });

  const text =
    message ||
    "👋 This is a test message from Botlify. Your WhatsApp automation is live!";
  const result = await dispatcher.sendMessage(ws, phone, {
    type: "text",
    text,
  });
  if (!result.success) {
    return res.status(400).json({ message: result.error || "Send failed" });
  }
  res.json({ success: true, messageId: result.messageId });
});

// @POST /api/whatsapp/toggle  body: { active }
const toggleBot = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, false));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });
  if (!ws.whatsapp) ws.whatsapp = {};
  ws.whatsapp.botActive =
    typeof req.body?.active === "boolean"
      ? req.body.active
      : !ws.whatsapp.botActive;
  await ws.save();
  res.json({ botActive: ws.whatsapp.botActive });
});

// @DELETE /api/whatsapp/disconnect
const disconnect = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, true));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });

  // Best-effort logout for cloud provider
  if (ws.whatsapp?.type === "cloud" && ws.whatsapp.cloudInstanceId) {
    try {
      await greenApiService.logout({
        idInstance: decrypt(ws.whatsapp.cloudInstanceId),
        apiTokenInstance: decrypt(ws.whatsapp.cloudApiToken),
      });
    } catch (e) {
      logger.warn("[cloud disconnect] logout failed", e.message);
    }
  }

  ws.whatsapp = {
    status: "disconnected",
    type: "none",
    botActive: false,
  };
  await ws.save();
  res.json({ success: true });
});

// @PUT /api/whatsapp/automation  body: { welcomeMessage?, awayMessage?, keywordTriggers? }
const updateAutomation = asyncHandler(async (req, res) => {
  const ws = await (await findWorkspace(req, false));
  if (!ws) return res.status(404).json({ message: "Workspace not found" });
  if (!ws.whatsapp) ws.whatsapp = {};
  const { welcomeMessage, awayMessage, keywordTriggers } = req.body || {};
  if (welcomeMessage !== undefined)
    ws.whatsapp.welcomeMessage = welcomeMessage;
  if (awayMessage !== undefined) ws.whatsapp.awayMessage = awayMessage;
  if (Array.isArray(keywordTriggers))
    ws.whatsapp.keywordTriggers = keywordTriggers;
  await ws.save();
  res.json({ whatsapp: sanitizeWaForResponse(ws) });
});

module.exports = {
  // Webhooks
  verifyMetaWebhook,
  handleMetaWebhook,
  handleUltramsgWebhook,
  handleCloudWebhook,
  // Onboarding + management
  onboardChannel,
  getCloudQr,
  getCloudState,
  getStatus,
  sendTestMessage,
  toggleBot,
  disconnect,
  updateAutomation,
};
