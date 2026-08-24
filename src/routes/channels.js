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
