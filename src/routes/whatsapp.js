const express = require("express");
const router = express.Router();
const {
  verifyMetaWebhook,
  handleMetaWebhook,
  handleUltramsgWebhook,
} = require("../controllers/whatsappController");

// Meta webhook — no auth (verified by signature)
router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", handleMetaWebhook);

// UltraMsg webhook
router.post("/webhook/ultramsg", handleUltramsgWebhook);

module.exports = router;
