/**
 * Botlify — Multi-channel Routes (WhatsApp / TikTok via Zernio)
 */
const express = require("express");
const router = express.Router();
const channelCtrl = require("../controllers/channelController");
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");

// ── WhatsApp via WasenderAPI (the WhatsApp carrier, Nov 2026) ───────────────
const wasenderCtrl = require("../controllers/wasenderController");
router.post("/whatsapp/wasender/hook/:token", wasenderCtrl.webhook); // public: token + X-Webhook-Signature
router.post("/whatsapp/wasender/start", protect, requireWorkspace, requireOwner, wasenderCtrl.start);
router.get("/whatsapp/wasender/qr", protect, requireWorkspace, requireOwner, wasenderCtrl.qr);
router.post("/whatsapp/wasender/key", protect, requireWorkspace, requireOwner, wasenderCtrl.connectKey);
router.delete("/whatsapp/wasender", protect, requireWorkspace, requireOwner, wasenderCtrl.disconnect);

// ── WhatsApp via AiSensy (spare driver) ─────────────────────────────────────
const aisensyCtrl = require("../controllers/aisensyController");
router.post("/whatsapp/aisensy/hook/:token", aisensyCtrl.webhook); // public, token-authenticated
router.post("/whatsapp/aisensy/key", protect, requireWorkspace, requireOwner, aisensyCtrl.connectKey);
router.delete("/whatsapp/aisensy", protect, requireWorkspace, requireOwner, aisensyCtrl.disconnect);

// ── WhatsApp via 360dialog (spare driver) ────────────────────────────────────
const d360 = require("../controllers/dialog360Controller");
// Public: 360dialog posts guest messages here; the token routes + authenticates.
router.post("/whatsapp/360dialog/hook/:token", d360.webhook);
// Public: browser returns here from the 360dialog Connect popup (signed state).
router.get("/whatsapp/360dialog/callback", d360.callback);
router.post("/whatsapp/360dialog/key", protect, requireWorkspace, requireOwner, d360.connectKey);
router.get("/whatsapp/360dialog/connect", protect, requireWorkspace, requireOwner, d360.connectUrl);
router.delete("/whatsapp/360dialog", protect, requireWorkspace, requireOwner, d360.disconnect);

// ── Public callback (NO auth — Zernio redirects the browser here) ────────────
// Must be registered BEFORE any auth middleware.
router.get("/:platform/callback", channelCtrl.oauthCallback);

// ── Authenticated routes ─────────────────────────────────────────────────────
// Connection state of every channel (Instagram + WhatsApp + TikTok).
router.get("/status", protect, requireWorkspace, channelCtrl.getStatus);
// Start the hosted-auth connect flow (owner only).
router.get(
  "/:platform/connect",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.getConnectUrl,
);
// Telegram pairs by code (bot admin + code), not OAuth — its own two routes.
router.get(
  "/telegram/code",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.telegramCode,
);
router.get(
  "/telegram/status",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.telegramStatus,
);

// Messenger headless connect: the hotel picks their Facebook Page inside
// Botlify instead of on the provider's branded screen.
router.get(
  "/messenger/pages",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.listMessengerPages,
);
router.post(
  "/messenger/pages",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.selectMessengerPage,
);

// WhatsApp: buy a number when the hotel has no WhatsApp yet (owner only).
router.get(
  "/whatsapp/number-options",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.whatsappNumberOptions,
);
router.post(
  "/whatsapp/number",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.whatsappBuyNumber,
);

// WhatsApp health + PIN recovery (owner only).
router.get(
  "/whatsapp/health",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.whatsappHealth,
);
router.post(
  "/whatsapp/pin",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.whatsappPin,
);

// Disconnect a channel (owner only).
router.delete(
  "/:platform",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.disconnect,
);

module.exports = router;
