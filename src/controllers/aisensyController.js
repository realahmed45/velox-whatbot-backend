/**
 * WhatsApp via AiSensy — connect, webhook, disconnect.
 *
 * Connect: the hotel pastes its AiSensy Project ID + Project API password. We
 * check them, store them encrypted, and hand back a per-connection webhook URL
 * the hotel adds in AiSensy → Developer Hub → Webhooks. The random token in that
 * URL routes inbound messages to the workspace (stored hashed, plus encrypted so
 * the URL can be shown again) and authenticates them: unknown token → dropped.
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/encryption");
const { hashToken } = require("../utils/crypto");
const aisensy = require("../services/channels/aisensyService");

const apiBase = () =>
  (process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com").replace(/\/$/, "");
const hookUrl = (token) => `${apiBase()}/api/channels/whatsapp/aisensy/hook/${token}`;

async function connect(workspaceId, { projectId, apiKey }) {
  const creds = { projectId: String(projectId || "").trim(), password: String(apiKey || "").trim() };
  if (!creds.projectId || creds.password.length < 6) {
    const e = new Error("Enter your AiSensy Project ID and Project API password.");
    e.status = 400;
    throw e;
  }
  const check = await aisensy.verifyCredentials(creds);
  if (!check.ok) {
    const e = new Error(
      check.reason === "rejected"
        ? "AiSensy rejected those details. Copy the Project ID and Project API password again from AiSensy → Developer Hub."
        : "Couldn't reach AiSensy just now — try again in a minute.",
    );
    e.status = 400;
    throw e;
  }

  const accountHash = hashToken(`aisensy:${creds.projectId}`);
  const clash = await Workspace.findOne({ "channels.accountHash": accountHash, _id: { $ne: workspaceId } }).select("_id");
  if (clash) {
    const e = new Error("This AiSensy project is already connected to another Botlify account.");
    e.status = 409;
    throw e;
  }

  const token = crypto.randomBytes(24).toString("hex");
  const fields = {
    platform: "whatsapp",
    provider: "aisensy",
    status: "connected",
    accountId: encrypt(JSON.stringify(creds)),
    accountHash,
    webhookTokenHash: hashToken(token),
    webhookTokenEnc: encrypt(token),
    username: creds.projectId,
    connectedAt: new Date(),
    lastWebhookAt: null,
    webhookError: null,
  };
  const ws = await Workspace.findById(workspaceId);
  if ((ws.channels || []).some((c) => c.platform === "whatsapp")) {
    await Workspace.updateOne(
      { _id: workspaceId, "channels.platform": "whatsapp" },
      { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`channels.$.${k}`, v])) },
    );
  } else {
    await Workspace.updateOne({ _id: workspaceId }, { $push: { channels: fields } });
  }
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "settings.automationEnabled": true } });
  logger.info(`[AiSensy] WhatsApp connected ws=${workspaceId}`);
  return { webhookUrl: hookUrl(token) };
}

// @POST /api/channels/whatsapp/aisensy/key  { projectId, apiKey }
exports.connectKey = asyncHandler(async (req, res) => {
  try {
    const { webhookUrl } = await connect(req.workspace._id, req.body || {});
    res.json({ success: true, webhookUrl });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// @POST /api/channels/whatsapp/aisensy/hook/:token  (public, called by AiSensy)
exports.webhook = async (req, res) => {
  res.sendStatus(200); // ack first — never make AiSensy wait on the AI
  try {
    const tokenHash = hashToken(String(req.params.token || ""));
    const ws = await Workspace.findOne({ "channels.webhookTokenHash": tokenHash }).select("_id channels");
    if (!ws) {
      logger.warn("[AiSensy] webhook with unknown token — dropped");
      return;
    }
    const messages = aisensy.parseWebhook(req.body || {});
    const entry = ws.channels.find((c) => c.webhookTokenHash === tokenHash);
    await Workspace.updateOne(
      { _id: ws._id, "channels.platform": "whatsapp" },
      {
        $set: {
          "channels.$.lastWebhookAt": new Date(),
          ...(messages[0]?.displayPhone ? { "channels.$.phoneNumber": messages[0].displayPhone } : {}),
          ...(entry?.status === "error" ? { "channels.$.status": "connected", "channels.$.webhookError": null } : {}),
        },
      },
    ).catch(() => {});
    if (!messages.length) return;

    const { handleWebhookEvent, TRIGGERS } = require("../services/instagram/automationEngine");
    for (const m of messages) {
      await handleWebhookEvent(ws._id, {
        type: TRIGGERS.DIRECT_MESSAGE,
        channel: "whatsapp",
        senderId: m.from,
        senderName: m.name,
        providerConversationId: m.from,
        text: m.text,
        incomingImageUrl: m.type === "image" ? m.mediaUrl : null,
      });
    }
  } catch (err) {
    logger.error("[AiSensy] webhook processing failed", { err: err.message });
  }
};

// @DELETE /api/channels/whatsapp/aisensy
exports.disconnect = asyncHandler(async (req, res) => {
  await Workspace.updateOne(
    { _id: req.workspace._id, "channels.platform": "whatsapp" },
    {
      $set: {
        "channels.$.status": "disconnected",
        "channels.$.accountId": null,
        "channels.$.accountHash": null,
        "channels.$.webhookTokenHash": null,
        "channels.$.webhookTokenEnc": null,
      },
    },
  );
  res.json({ success: true });
});

/** Webhook URL for the status endpoint (aisensy only). */
exports.webhookUrlFor = (entry) => {
  try {
    return entry?.webhookTokenEnc ? hookUrl(decrypt(entry.webhookTokenEnc)) : null;
  } catch {
    return null;
  }
};

exports._internal = { connect, hookUrl };
