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
const {
  listHotels,
  getHotel,
  platformStats,
  getConsultant,
} = require("../controllers/adminHotelsController");

// Public — admin login (email + password from env → admin JWT)
router.post("/login", login);

// Everything below requires a valid admin token
router.use(requireAdmin);
router.get("/overview", overview);
router.get("/users", listUsers);
router.get("/subscriptions", listSubscriptions);
router.get("/activity", listActivity); // per-user funnel + activity table
router.get("/timeline", timeline); // live event feed
router.get("/stats", platformStats); // platform-wide hotel/booking/commission numbers

// Hotels — the full per-workspace hotel view
router.get("/hotels", listHotels);
router.get("/hotels/:workspaceId", getHotel);

// Consultant program + commission ledger (hotel product)
router.get("/consultants", listConsultants);
router.get("/consultants/:id", getConsultant);
router.post("/consultants/:id/approve", approveConsultant);
router.post("/consultants/:id/suspend", suspendConsultant);
router.get("/commissions", listCommissions);
router.post("/commissions/mark-paid-bulk", markCommissionsPaidBulk);
router.post("/commissions/:id/verify", verifyCommission);
router.post("/commissions/:id/mark-paid", markCommissionPaid);

module.exports = router;
