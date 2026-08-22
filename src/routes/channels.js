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
// Disconnect a channel (owner only).
router.delete(
  "/:platform",
  protect,
  requireWorkspace,
  requireOwner,
  channelCtrl.disconnect,
);

module.exports = router;
