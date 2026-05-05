const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
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
} = require("../controllers/whatsappController");

// ─── Public webhooks ───────────────────────────────────────
router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", handleMetaWebhook);
router.post("/webhook/ultramsg", handleUltramsgWebhook);
// Botlify Cloud webhook (white-labeled). Token in URL = shared secret.
router.post("/webhook/cloud/:token", handleCloudWebhook);
router.post("/webhook/cloud", handleCloudWebhook);

// ─── Authenticated onboarding + management ─────────────────
router.post("/onboard", protect, onboardChannel);
router.get("/status", protect, getStatus);
router.post("/test", protect, sendTestMessage);
router.post("/toggle", protect, toggleBot);
router.delete("/disconnect", protect, disconnect);
router.put("/automation", protect, updateAutomation);

// Botlify Cloud QR / state polling
router.get("/cloud/qr", protect, getCloudQr);
router.get("/cloud/state", protect, getCloudState);

module.exports = router;
