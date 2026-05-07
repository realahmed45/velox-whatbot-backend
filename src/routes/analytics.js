const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  getOverview,
  getMessagesOverTime,
  getPeakHours,
  getFlowAnalytics,
  getContactsGrowth,
} = require("../controllers/analyticsController");
const { getRoiReport } = require("../controllers/roiController");

router.use(protect);
router.use(requireWorkspace);

router.get("/overview", getOverview);
router.get("/messages-over-time", getMessagesOverTime);
router.get("/peak-hours", getPeakHours);
router.get("/flows", getFlowAnalytics);
router.get("/flow-performance", getFlowAnalytics); // alias used by frontend
router.get("/contacts-growth", getContactsGrowth);
router.get("/roi", getRoiReport);

module.exports = router;
