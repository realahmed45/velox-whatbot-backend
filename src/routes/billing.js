const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const {
  getPlans,
  getSubscription,
  getInvoices,
  initiatePayment,
  confirmPayment,
  cancelSubscription,
  selectPlan,
} = require("../controllers/billingController");

// Public — no auth/workspace needed (used by the marketing pricing page)
router.get("/plans", getPlans);

// Everything below requires an authenticated user + workspace
router.use(protect);
router.use(requireWorkspace);
router.get("/subscription", getSubscription);
router.get("/invoices", getInvoices);
router.post("/initiate", requireOwner, initiatePayment);
router.post("/confirm", requireOwner, confirmPayment);
router.post("/select-plan", requireOwner, selectPlan);
router.post("/cancel", requireOwner, cancelSubscription);

module.exports = router;
