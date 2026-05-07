/**
 * Flowgram — Instagram Routes
 * Handles Instagram OAuth connect, webhook, and account management
 */
const express = require("express");
const router = express.Router();
const igCtrl = require("../controllers/instagramController");
const { protect } = require("../middleware/auth");

// ── OAuth Connect ─────────────────────────────────────────────────────────────
// Step 1: Redirect user to Meta OAuth (auto-switches to hosted provider when configured)
router.get("/connect/oauth-url", protect, igCtrl.getOAuthUrl);
// Step 2: Meta redirects back with code
router.get("/connect/callback", igCtrl.oauthCallback);

// Hosted provider (white-labeled) — alternate path; auto-selected by getOAuthUrl
router.get("/connect/botlify-url", protect, igCtrl.getBotlifyOAuthUrl);
router.get("/connect/callback-botlify", igCtrl.botlifyOAuthCallback);

// Session-cookie connect (fallback)
router.post("/connect/session", protect, igCtrl.connectBySession);
// Disconnect
router.delete("/connect", protect, igCtrl.disconnect);
// Get connection status
router.get("/connection", protect, igCtrl.getConnection);

// ── Meta-required public callbacks (NO auth — Meta calls these directly) ─────
// Deauthorize: Meta POSTs here when a user removes the app from their IG.
router.post("/deauthorize", igCtrl.deauthorize);
// Data deletion request: user-initiated full wipe. Returns {url, confirmation_code}.
router.post("/data-deletion", igCtrl.dataDeletion);
// Public status page Meta links the user to after a deletion request.
router.get("/data-deletion/status", igCtrl.dataDeletionStatus);

// ── Webhook ───────────────────────────────────────────────────────────────────
// Meta sends GET to verify the webhook
router.get("/webhook", igCtrl.verifyWebhook);
// Meta sends POST with events
router.post("/webhook", igCtrl.receiveWebhook);
// Hosted provider (white-labeled) — POSTs translated events here
router.post("/webhook/botlify", igCtrl.receiveBotlifyWebhook);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get("/settings", protect, igCtrl.getSettings);
router.put("/settings", protect, igCtrl.updateSettings);

// ── Debug / Test (protected) ──────────────────────────────────────────────────
// Manually fire a trigger for testing
router.post("/test/trigger", protect, igCtrl.testTrigger);
// Health check — "why isn't my automation working?"
router.get("/diagnose", protect, igCtrl.diagnose);
// Reveal decrypted IG identity for Postman webhook simulation
router.get("/debug/identity", protect, igCtrl.debugIdentity);
// Force re-subscribe to Meta webhook fields
router.post("/webhook/resubscribe", protect, igCtrl.resubscribeWebhook);

module.exports = router;
