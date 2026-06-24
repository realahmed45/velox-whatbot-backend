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

// Public — Xendit posts recurring webhooks here (verified via x-callback-token).
// Must be registered BEFORE the auth middleware below.
router.post("/webhook/xendit", handleXenditWebhook);

router.use(protect);

router.get("/plans", getPlans); // Public — no workspace needed

router.use(requireWorkspace);
router.get("/subscription", getSubscription);
router.get("/invoices", getInvoices);
router.post("/initiate", requireOwner, strictLimiter, initiatePayment);
router.post("/confirm", requireOwner, strictLimiter, confirmPayment);
router.post("/select-plan", requireOwner, selectPlan);
router.post("/cancel", requireOwner, cancelSubscription);

module.exports = router;
