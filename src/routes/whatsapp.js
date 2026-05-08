const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  // Webhooks
  verifyMetaWebhook,
  handleMetaWebhook,
  handleUltramsgWebhook,
  handleCloudWebhook,
  handleKapsoWebhook,
  // Onboarding + management
  onboardChannel,
  provisionCloudConnection,
  finalizeCloudConnection,
  getCloudQr,
  getCloudState,
  getStatus,
  sendTestMessage,
  toggleBot,
  disconnect,
  updateAutomation,
  // Baileys
  baileysConnect,
  baileysQr,
  baileysStatus,
  baileysDisconnect,
  // Wasender
  wasenderConnect,
  wasenderQr,
  wasenderStatus,
  wasenderDisconnect,
  handleWasenderWebhook,
} = require("../controllers/whatsappController");

// ─── Public webhooks ───────────────────────────────────────
router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", handleMetaWebhook);
router.post("/webhook/ultramsg", handleUltramsgWebhook);
// Botlify Cloud webhook (white-labeled). Token in URL = shared secret.
router.post("/webhook/cloud/:token", handleCloudWebhook);
router.post("/webhook/cloud", handleCloudWebhook);
// Botlify Cloud Pro (Kapso) project webhook — HMAC verified
router.post("/webhook/kapso", handleKapsoWebhook);
// Wasender webhook (per-workspace)
router.post("/webhook/wasender/:workspaceId", handleWasenderWebhook);

// ─── Authenticated onboarding + management ─────────────────
router.post("/onboard", protect, onboardChannel);
// Zero-credential auto-provisioning (preferred path for Botlify Cloud Pro)
router.post("/connect/provision", protect, provisionCloudConnection);
// Called by frontend after upstream embedded-signup redirect lands
router.post("/connect/finalize", protect, finalizeCloudConnection);
router.get("/status", protect, getStatus);
router.post("/test", protect, sendTestMessage);
router.post("/toggle", protect, toggleBot);
router.delete("/disconnect", protect, disconnect);
router.put("/automation", protect, updateAutomation);

// Botlify Cloud QR / state polling (legacy QR-scan flow)
router.get("/cloud/qr", protect, getCloudQr);
router.get("/cloud/state", protect, getCloudState);

// ─── Baileys (QR-scan, free, self-hosted) ──────────────────
router.post("/baileys/connect", protect, baileysConnect);
router.get("/baileys/qr", protect, baileysQr);
router.get("/baileys/status", protect, baileysStatus);
router.delete("/baileys/disconnect", protect, baileysDisconnect);

// ─── WasenderAPI (paid managed QR-scan, $6/mo) ─────────────
router.post("/wasender/connect", protect, wasenderConnect);
router.get("/wasender/qr", protect, wasenderQr);
router.get("/wasender/status", protect, wasenderStatus);
router.delete("/wasender/disconnect", protect, wasenderDisconnect);

module.exports = router;
