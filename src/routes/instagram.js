/**
 * Flowgram — Instagram Routes
 * Handles Instagram OAuth connect, webhook, and account management
 */
const express = require("express");
const router = express.Router();
const igCtrl = require("../controllers/instagramController");
const { protect } = require("../middleware/auth");

// ── OAuth Connect ─────────────────────────────────────────────────────────────
// Step 1: Redirect user to Meta OAuth
router.get("/connect/oauth-url", protect, igCtrl.getOAuthUrl);
// Step 2: Meta redirects back with code
router.get("/connect/callback", igCtrl.oauthCallback);
// Session-cookie connect (fallback)
router.post("/connect/session", protect, igCtrl.connectBySession);
// Disconnect
router.delete("/connect", protect, igCtrl.disconnect);
// Get connection status
router.get("/connection", protect, igCtrl.getConnection);

// ── Webhook ───────────────────────────────────────────────────────────────────
// Meta sends GET to verify the webhook
router.get("/webhook", igCtrl.verifyWebhook);
// Meta sends POST with events
router.post("/webhook", igCtrl.receiveWebhook);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get("/settings", protect, igCtrl.getSettings);
router.put("/settings", protect, igCtrl.updateSettings);

// ── Debug / Test (protected) ──────────────────────────────────────────────────
// Manually fire a trigger for testing
router.post("/test/trigger", protect, igCtrl.testTrigger);
// Health check — "why isn't my automation working?"
router.get("/diagnose", protect, igCtrl.diagnose);
// Force re-subscribe to Meta webhook fields
router.post("/webhook/resubscribe", protect, igCtrl.resubscribeWebhook);

module.exports = router;
