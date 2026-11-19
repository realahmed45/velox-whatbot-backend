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

// Botlify's own driver pool — dispatched for hotels that have no taxi service
// of their own. A hotel's own drivers are managed from its dashboard instead.
const {
  listPlatformDrivers,
  createPlatformDriver,
  updatePlatformDriver,
  deletePlatformDriver,
  listPlatformTransfers,
  assignPlatformDriver,
} = require("../controllers/driverController");
router.get("/drivers", listPlatformDrivers);
router.post("/drivers", createPlatformDriver);
router.patch("/drivers/:id", updatePlatformDriver);
router.delete("/drivers/:id", deletePlatformDriver);
router.get("/transfers", listPlatformTransfers);
router.patch("/transfers/:id/driver", assignPlatformDriver);

// Money: guest payments through Botlify + automatic payouts.
router.get("/payments", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const payments = await Payment.find(req.query.status ? { status: req.query.status } : {})
      .sort({ createdAt: -1 })
      .limit(200)
      .populate("workspaceId", "name")
      .lean();
    const totals = await Payment.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: "$currency", volume: { $sum: "$amount" }, fees: { $sum: "$platformFee" }, count: { $sum: 1 } } },
    ]);
    res.json({ payments, totals });
  } catch (e) {
    next(e);
  }
});
router.get("/payouts", async (req, res, next) => {
  try {
    const Payout = require("../models/Payout");
    const filter = {};
    if (req.query.type) filter.recipientType = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    const payouts = await Payout.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ payouts });
  } catch (e) {
    next(e);
  }
});
// Preview (dryRun) or run a payout batch now: { type: "driver"|"consultant", dryRun }
router.post("/payouts/run", async (req, res, next) => {
  try {
    const type = req.body?.type === "consultant" ? "consultant" : "driver";
    const { runPayouts } = require("../services/payments/payoutService");
    res.json(await runPayouts(type, { dryRun: !!req.body?.dryRun }));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
