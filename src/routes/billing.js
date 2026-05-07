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

router.use(protect);

router.get("/plans", getPlans); // Public — no workspace needed

router.use(requireWorkspace);
router.get("/subscription", getSubscription);
router.get("/invoices", getInvoices);
router.post("/initiate", requireOwner, initiatePayment);
router.post("/confirm", requireOwner, confirmPayment);
router.post("/select-plan", requireOwner, selectPlan);
router.post("/cancel", requireOwner, cancelSubscription);

module.exports = router;
