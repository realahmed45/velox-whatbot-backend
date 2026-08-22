const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../middleware/adminAuth");
const {
  login,
  overview,
  listUsers,
  listSubscriptions,
  listActivity,
  timeline,
  listConsultants,
  approveConsultant,
  suspendConsultant,
  listCommissions,
  verifyCommission,
  markCommissionPaid,
  markCommissionsPaidBulk,
} = require("../controllers/adminController");

// Public — admin login (email + password from env → admin JWT)
router.post("/login", login);

// Everything below requires a valid admin token
router.use(requireAdmin);
router.get("/overview", overview);
router.get("/users", listUsers);
router.get("/subscriptions", listSubscriptions);
router.get("/activity", listActivity); // per-user funnel + activity table
router.get("/timeline", timeline); // live event feed

// Consultant program + commission ledger (hotel product)
router.get("/consultants", listConsultants);
router.post("/consultants/:id/approve", approveConsultant);
router.post("/consultants/:id/suspend", suspendConsultant);
router.get("/commissions", listCommissions);
router.post("/commissions/mark-paid-bulk", markCommissionsPaidBulk);
router.post("/commissions/:id/verify", verifyCommission);
router.post("/commissions/:id/mark-paid", markCommissionPaid);

module.exports = router;
