/**
 * WhatsApp via 360dialog — connect, webhook, disconnect.
 *
 * Two ways in:
 *  1. Paste key — the hotel creates an API key for their number in the
 *     360dialog hub and pastes it here. We validate it by pointing the
 *     number's webhook at us (a bad key fails that call).
 *  2. One-click — the 360dialog Connect popup (partner flow). On return we
 *     mint the number's key through the Partner API and continue as in (1).
 *
 * Each connection gets a random hook token in its webhook URL. That token is
 * how inbound messages find their workspace (stored as a hash) and it is the
 * webhook's authentication: an unknown token is dropped.
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/encryption");
const { hashToken } = require("../utils/crypto");
const d360 = require("../services/channels/dialog360Service");

const apiBase = () =>
  (process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com").replace(/\/$/, "");
const hookUrl = (token) => `${apiBase()}/api/channels/whatsapp/360dialog/hook/${token}`;

// Signed state for the popup round-trip: "<workspaceId>.<ts>.<hmac>".
const STATE_SECRET = () => process.env.JWT_SECRET || "botlify-state";
const signState = (wsId) => {
  const body = `${wsId}.${Date.now()}`;
  const mac = crypto.createHmac("sha256", STATE_SECRET()).update(body).digest("hex").slice(0, 32);
  return `${body}.${mac}`;
};
const readState = (state) => {
  const [wsId, ts, mac] = String(state || "").split(".");
  if (!wsId || !ts || !mac) return null;
  const good = crypto.createHmac("sha256", STATE_SECRET()).update(`${wsId}.${ts}`).digest("hex").slice(0, 32);
  if (good !== mac || Date.now() - Number(ts) > 60 * 60 * 1000) return null;
  return wsId;
};

/** Validate a key, wire its webhook, and store the connection. */
async function connectWithKey(workspaceId, apiKey) {
  const key = String(apiKey || "").trim();
  if (key.length < 10) {
    const e = new Error("That doesn't look like a 360dialog API key.");
    e.status = 400;
    throw e;
  }
  const token = d360.newHookToken();
  try {
    await d360.configureWebhook(key, hookUrl(token));
  } catch (err) {
    const status = err.response?.status;
    const e = new Error(
      status === 401 || status === 403
        ? "360dialog rejected that API key. Copy it again from your 360dialog hub."
        : `Couldn't reach 360dialog: ${err.response?.data?.meta?.developer_message || err.message}`,
    );
    e.status = 400;
    throw e;
  }

  const accountHash = hashToken(`360dialog:${key}`);
  const clash = await Workspace.findOne({
    "channels.accountHash": accountHash,
    _id: { $ne: workspaceId },
  }).select("_id");
  if (clash) {
    const e = new Error("This WhatsApp number is already connected to another Botlify account.");
    e.status = 409;
    throw e;
  }

  const fields = {
    platform: "whatsapp",
    provider: "360dialog",
    status: "connected",
    accountId: encrypt(key),
    accountHash,
    webhookTokenHash: hashToken(token),
    connectedAt: new Date(),
    webhookError: null,
  };
  const ws = await Workspace.findById(workspaceId);
  const has = (ws.channels || []).some((c) => c.platform === "whatsapp");
  if (has) {
    await Workspace.updateOne(
      { _id: workspaceId, "channels.platform": "whatsapp" },
      { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`channels.$.${k}`, v])) },
    );
  } else {
    await Workspace.updateOne({ _id: workspaceId }, { $push: { channels: fields } });
  }
  // Guest messages are dropped while the legacy automation switch is off.
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "settings.automationEnabled": true } });
  logger.info(`[360dialog] WhatsApp connected ws=${workspaceId}`);
  return { ok: true };
}

// @POST /api/channels/whatsapp/360dialog/key  { apiKey }
exports.connectKey = asyncHandler(async (req, res) => {
  try {
    await connectWithKey(req.workspace._id, req.body?.apiKey);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// @GET /api/channels/whatsapp/360dialog/connect → { url } (partner popup)
exports.connectUrl = asyncHandler(async (req, res) => {
  const url = d360.connectUrl({
    redirectUrl: `${apiBase()}/api/channels/whatsapp/360dialog/callback`,
    state: signState(String(req.workspace._id)),
  });
  if (!url) {
    return res.status(503).json({
      message: "One-click connect isn't switched on yet — paste your 360dialog API key instead.",
      pasteKey: true,
    });
  }
  res.json({ url });
});

// @GET /api/channels/whatsapp/360dialog/callback?client=…&channels=[…]&state=…  (public)
exports.callback = asyncHandler(async (req, res) => {
  const dash = `${process.env.CLIENT_URL || ""}/dashboard/settings?tab=channels`;
  const wsId = readState(req.query.state);
  if (!wsId) return res.redirect(302, `${dash}&error=connect_expired`);
  const channelId = d360.parseChannels(req.query.channels)[0];
  if (!channelId) return res.redirect(302, `${dash}&error=no_number`);
  try {
    const { apiKey } = await d360.createChannelApiKey(channelId);
    await connectWithKey(wsId, apiKey);
    return res.redirect(302, `${dash}&connected=whatsapp`);
  } catch (err) {
    logger.error("[360dialog] connect callback failed", { err: err.message });
    return res.redirect(302, `${dash}&error=connect_failed`);
  }
});

// @POST /api/channels/whatsapp/360dialog/hook/:token  (public, called by 360dialog)
exports.webhook = async (req, res) => {
  // 360dialog wants a 200 within ~80ms and retries for days otherwise:
  // acknowledge first, work after.
  res.sendStatus(200);
  try {
    const tokenHash = hashToken(String(req.params.token || ""));
    const ws = await Workspace.findOne({ "channels.webhookTokenHash": tokenHash }).select("+channels.accountId");
    if (!ws) {
      logger.warn("[360dialog] webhook with unknown token — dropped");
      return;
    }
    const entry = ws.channels.find((c) => c.webhookTokenHash === tokenHash);
    const { messages } = d360.parseWebhook(req.body || {});
    if (!messages.length) return;

    await Workspace.updateOne(
      { _id: ws._id, "channels.platform": "whatsapp" },
      {
        $set: {
          "channels.$.lastWebhookAt": new Date(),
          ...(messages[0].displayPhone ? { "channels.$.phoneNumber": messages[0].displayPhone } : {}),
          ...(entry?.status === "error" ? { "channels.$.status": "connected", "channels.$.webhookError": null } : {}),
        },
      },
    ).catch(() => {});

    const { handleWebhookEvent, TRIGGERS } = require("../services/instagram/automationEngine");
    for (const m of messages) {
      let incomingImageUrl = null;
      if (m.mediaId && m.mediaType === "image") {
        incomingImageUrl = await hostIncomingImage(entry, m.mediaId).catch(() => null);
      }
      await handleWebhookEvent(ws._id, {
        type: TRIGGERS.DIRECT_MESSAGE,
        channel: "whatsapp",
        senderId: m.from,
        senderName: m.name,
        providerConversationId: m.from,
        text: m.text,
        incomingImageUrl,
      });
    }
  } catch (err) {
    logger.error("[360dialog] webhook processing failed", { err: err.message });
  }
};

/** Re-host a guest's photo so the AI (vision) can read it by URL. */
async function hostIncomingImage(entry, mediaId) {
  if (!entry?.accountId || !process.env.CLOUDINARY_CLOUD_NAME) return null;
  const key = decrypt(entry.accountId);
  const { buffer } = await d360.downloadMedia(key, mediaId);
  const { uploadBuffer } = require("../services/cloudinaryService");
  const up = await uploadBuffer(buffer, { folder: "botlify/whatsapp-in" });
  return up?.secure_url || up?.url || null;
}

// @DELETE /api/channels/whatsapp/360dialog
exports.disconnect = asyncHandler(async (req, res) => {
  await Workspace.updateOne(
    { _id: req.workspace._id, "channels.platform": "whatsapp" },
    {
      $set: {
        "channels.$.status": "disconnected",
        "channels.$.accountId": null,
        "channels.$.accountHash": null,
        "channels.$.webhookTokenHash": null,
      },
    },
  );
  res.json({ success: true });
});

exports._internal = { connectWithKey, signState, readState, hookUrl };
