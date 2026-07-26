const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const { strictLimiter } = require("../middleware/enhancedRateLimiter");
const {
  getPlans,
  getSubscription,
  getInvoices,
  initiatePayment,
  confirmPayment,
  cancelSubscription,
  selectPlan,
  handleXenditWebhook,
  createLemonCheckout,
  getBillingPortal,
  handleLemonSqueezyWebhook,
} = require("../controllers/billingController");

// Public — no auth/workspace needed (used by the marketing pricing page)
router.get("/plans", getPlans);

// Public — Xendit posts recurring webhooks here (verified via x-callback-token).
// Must be registered BEFORE the auth middleware below.
router.post("/webhook/xendit", handleXenditWebhook);

// Public — Lemon Squeezy subscription webhooks (verified via HMAC signature).
// The RAW body is required for the signature; server.js applies express.raw to
// this exact path before express.json runs.
router.post("/lemonsqueezy/webhook", handleLemonSqueezyWebhook);

// Everything below requires an authenticated user + workspace
router.use(protect);
router.use(requireWorkspace);
router.get("/subscription", getSubscription);
router.get("/invoices", getInvoices);
router.post("/initiate", requireOwner, strictLimiter, initiatePayment);
router.post("/confirm", requireOwner, strictLimiter, confirmPayment);
router.post("/select-plan", requireOwner, selectPlan);
router.post("/cancel", requireOwner, cancelSubscription);

// Lemon Squeezy (card subscriptions via Merchant-of-Record)
router.post(
  "/lemonsqueezy/checkout",
  requireOwner,
  strictLimiter,
  createLemonCheckout,
);
router.get("/lemonsqueezy/portal", requireOwner, getBillingPortal);

module.exports = router;
