const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  verifyMetaWebhook,
  handleMetaWebhook,
  handleUltramsgWebhook,
  onboardChannel,
  sendTestMessage,
  toggleBot,
  getStatus,
  disconnect,
  updateAutomation,
} = require("../controllers/whatsappController");

// ─── Public webhooks (verified by signature, not auth token) ─
router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", handleMetaWebhook);
router.post("/webhook/ultramsg", handleUltramsgWebhook);

// ─── Authenticated onboarding + management ─────────────────
router.post("/onboard", protect, onboardChannel);
router.get("/status", protect, getStatus);
router.post("/test", protect, sendTestMessage);
router.post("/toggle", protect, toggleBot);
router.delete("/disconnect", protect, disconnect);
router.put("/automation", protect, updateAutomation);

module.exports = router;
