/**
 * WhatsApp via WasenderAPI — connect (QR or pasted key), webhook, disconnect.
 *
 * One-click: the hotel types its WhatsApp number → we create a WasenderAPI
 * session with our Personal Access Token (webhook pre-pointed at us) → the
 * dashboard shows the QR → the hotel scans it from WhatsApp → Linked devices.
 * Paste mode: the hotel created a session in its own WasenderAPI dashboard and
 * pastes the session API key + webhook secret; we hand back our webhook URL.
 *
 * Every connection gets a random token in its webhook URL (stored hashed +
 * encrypted) that routes inbound events to the workspace. Each request must
 * ALSO carry X-Webhook-Signature equal to the session's webhook secret.
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { encrypt, decrypt } = require("../utils/encryption");
const { hashToken } = require("../utils/crypto");
const wasender = require("../services/channels/wasenderService");

const apiBase = () =>
  (process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com").replace(/\/$/, "");
const hookUrl = (token) => `${apiBase()}/api/channels/whatsapp/wasender/hook/${token}`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Store (or replace) the workspace's WhatsApp channel entry. */
async function saveEntry(workspaceId, { creds, token, status, phoneNumber }) {
  const accountHash = hashToken(`wasender:${creds.sessionId || creds.apiKey}`);
  const clash = await Workspace.findOne({ "channels.accountHash": accountHash, _id: { $ne: workspaceId } }).select("_id");
  if (clash) {
    const e = new Error("This WhatsApp number is already connected to another Botlify account.");
    e.status = 409;
    throw e;
  }
  const fields = {
    platform: "whatsapp",
    provider: "wasender",
    status,
    accountId: encrypt(JSON.stringify(creds)),
    accountHash,
    webhookTokenHash: hashToken(token),
    webhookTokenEnc: encrypt(token),
    phoneNumber: phoneNumber || null,
    connectedAt: status === "connected" ? new Date() : null,
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
  // Guest messages are dropped while the legacy automation switch is off.
  await Workspace.updateOne({ _id: workspaceId }, { $set: { "settings.automationEnabled": true } });
}

async function loadEntry(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select("+channels.accountId");
  const entry = (ws?.channels || []).find((c) => c.platform === "whatsapp" && c.provider === "wasender");
  if (!entry?.accountId) return null;
  return { entry, creds: wasender.readCreds(decrypt(entry.accountId)) };
}

async function setStatus(workspaceId, status, extra = {}) {
  await Workspace.updateOne(
    { _id: workspaceId, "channels.platform": "whatsapp" },
    {
      $set: {
        "channels.$.status": status,
        ...(status === "connected" ? { "channels.$.connectedAt": new Date(), "channels.$.webhookError": null } : {}),
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`channels.$.${k}`, v])),
      },
    },
  );
}

// Wasender session states → our channel status.
const toChannelStatus = (s) => (s === "connected" ? "connected" : s === "logged_out" ? "error" : "pending");

// @POST /api/channels/whatsapp/wasender/start  { phoneNumber }
exports.start = asyncHandler(async (req, res) => {
  if (!wasender.canCreateSessions()) {
    return res.status(503).json({
      message: "One-click WhatsApp isn't switched on yet — paste your WasenderAPI session key instead.",
      pasteKey: true,
    });
  }
  const phone = wasender.normalisePhone(req.body?.phoneNumber);
  if (phone.length < 8) return res.status(400).json({ message: "Enter the hotel's WhatsApp number with country code, e.g. +62 812 3456 789." });

  // Re-use an unfinished session for the same number instead of piling them up.
  const existing = await loadEntry(req.workspace._id);
  let creds = existing?.creds;
  let token;
  if (!creds?.sessionId || wasender.normalisePhone(existing.entry.phoneNumber) !== phone) {
    if (creds?.sessionId) await wasender.deleteSession(creds.sessionId);
    token = crypto.randomBytes(24).toString("hex");
    try {
      const s = await wasender.createSession({
        name: req.workspace.name || "Botlify hotel",
        phoneNumber: phone,
        webhookUrl: hookUrl(token),
      });
      creds = { apiKey: s.apiKey, webhookSecret: s.webhookSecret, sessionId: s.sessionId };
    } catch (err) {
      logger.error("[Wasender] create session failed", { err: err.response?.data || err.message });
      return res.status(400).json({ message: err.response?.data?.message || "Couldn't start WhatsApp — check the number and try again." });
    }
    await saveEntry(req.workspace._id, { creds, token, status: "pending", phoneNumber: `+${phone}` });
  }

  try {
    await wasender.connectSession(creds.sessionId);
  } catch (err) {
    logger.warn("[Wasender] connect call failed", { err: err.response?.data || err.message });
  }
  let status = "need_scan";
  let qr = null;
  try {
    status = (await wasender.getSession(creds.sessionId)).status;
    if (status !== "connected") qr = await wasender.getQr(creds.sessionId);
  } catch (err) {
    logger.warn("[Wasender] qr fetch failed", { err: err.response?.data || err.message });
  }
  if (status === "connected") await setStatus(req.workspace._id, "connected");
  res.json({ success: true, status, qr });
});

// @GET /api/channels/whatsapp/wasender/qr → { status, qr }
exports.qr = asyncHandler(async (req, res) => {
  const loaded = await loadEntry(req.workspace._id);
  if (!loaded?.creds?.sessionId) return res.json({ status: loaded ? "connected" : "disconnected", qr: null });
  const { creds } = loaded;
  let status = "unknown";
  let qr = null;
  try {
    const s = await wasender.getSession(creds.sessionId);
    status = s.status;
    if (status !== "connected") qr = await wasender.getQr(creds.sessionId).catch(() => null);
    await setStatus(req.workspace._id, toChannelStatus(status), s.phoneNumber ? { phoneNumber: s.phoneNumber } : {});
  } catch (err) {
    logger.warn("[Wasender] status check failed", { err: err.response?.data || err.message });
  }
  res.json({ status, qr });
});

// @POST /api/channels/whatsapp/wasender/key  { apiKey, webhookSecret }
exports.connectKey = asyncHandler(async (req, res) => {
  const apiKey = String(req.body?.apiKey || "").trim();
  const webhookSecret = String(req.body?.webhookSecret || "").trim();
  if (apiKey.length < 20) return res.status(400).json({ message: "Paste the session API key from your WasenderAPI dashboard." });
  if (!webhookSecret) return res.status(400).json({ message: "Paste the session's webhook secret too — it keeps forged messages out." });
  let status;
  try {
    status = await wasender.sessionStatus(apiKey);
  } catch (err) {
    const s = err.response?.status;
    return res.status(400).json({
      message: s === 401 || s === 403 ? "WasenderAPI rejected that key. Copy the session API key again." : "Couldn't reach WasenderAPI — try again in a minute.",
    });
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    await saveEntry(req.workspace._id, {
      creds: { apiKey, webhookSecret },
      token,
      status: toChannelStatus(status),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }
  res.json({ success: true, status, webhookUrl: hookUrl(token) });
});

// @POST /api/channels/whatsapp/wasender/hook/:token  (public, called by WasenderAPI)
exports.webhook = async (req, res) => {
  try {
    const tokenHash = hashToken(String(req.params.token || ""));
    const ws = await Workspace.findOne({ "channels.webhookTokenHash": tokenHash }).select("+channels.accountId");
    const entry = ws?.channels?.find((c) => c.webhookTokenHash === tokenHash);
    if (!ws || !entry?.accountId) {
      logger.warn("[Wasender] webhook with unknown token — dropped");
      return res.sendStatus(404);
    }
    const creds = wasender.readCreds(decrypt(entry.accountId));
    if (!safeEqual(req.headers["x-webhook-signature"], creds?.webhookSecret)) {
      logger.warn(`[Wasender] bad webhook signature ws=${ws._id} — dropped`);
      return res.status(401).json({ error: "Invalid signature" });
    }
    res.status(200).json({ received: true }); // ack fast, work after

    const body = req.body || {};
    const sessionState = wasender.parseSessionStatus(body);
    if (sessionState) {
      await setStatus(ws._id, toChannelStatus(sessionState), { lastWebhookAt: new Date() });
      if (sessionState === "connected" || sessionState === "logged_out" || sessionState === "disconnected") {
        const { notify } = require("../services/notificationService");
        const up = sessionState === "connected";
        notify(ws._id, {
          type: up ? "whatsapp.connected" : "whatsapp.disconnected",
          title: up ? "WhatsApp connected" : "WhatsApp disconnected",
          body: up
            ? "Your AI is answering guests on WhatsApp."
            : "Guests on WhatsApp aren't being answered. Reconnect in Settings → Channels.",
          link: "/dashboard/settings?tab=channels",
          channel: "whatsapp",
          priority: up ? "normal" : "high",
          dedupeKey: "whatsapp:status",
        });
      }
      logger.info(`[Wasender] session ${sessionState} ws=${ws._id}`);
      return;
    }
    const messages = wasender.parseWebhook(body);
    await Workspace.updateOne(
      { _id: ws._id, "channels.platform": "whatsapp" },
      { $set: { "channels.$.lastWebhookAt": new Date(), ...(entry.status !== "connected" ? { "channels.$.status": "connected" } : {}) } },
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
        text: m.text || (m.hasImage ? "[Photo]" : ""),
      });
    }
  } catch (err) {
    logger.error("[Wasender] webhook processing failed", { err: err.message });
    if (!res.headersSent) res.sendStatus(200);
  }
};

// @DELETE /api/channels/whatsapp/wasender
exports.disconnect = asyncHandler(async (req, res) => {
  const loaded = await loadEntry(req.workspace._id).catch(() => null);
  if (loaded?.creds?.sessionId && wasender.canCreateSessions()) await wasender.deleteSession(loaded.creds.sessionId);
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

/** Webhook URL for the status endpoint (paste-mode connections). */
exports.webhookUrlFor = (entry) => {
  try {
    return entry?.webhookTokenEnc ? hookUrl(decrypt(entry.webhookTokenEnc)) : null;
  } catch {
    return null;
  }
};

exports._internal = { saveEntry, hookUrl, toChannelStatus };
