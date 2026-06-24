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
} = require("../controllers/billingController");

// Public — no auth/workspace needed (used by the marketing pricing page)
router.get("/plans", getPlans);

// Public — Xendit posts recurring webhooks here (verified via x-callback-token).
// Must be registered BEFORE the auth middleware below.
router.post("/webhook/xendit", handleXenditWebhook);

// Everything below requires an authenticated user + workspace
router.use(protect);
router.use(requireWorkspace);
router.get("/subscription", getSubscription);
router.get("/invoices", getInvoices);
router.post("/initiate", requireOwner, strictLimiter, initiatePayment);
router.post("/confirm", requireOwner, strictLimiter, confirmPayment);
router.post("/select-plan", requireOwner, selectPlan);
router.post("/cancel", requireOwner, cancelSubscription);

module.exports = router;
