const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  listPlans,
  getCurrentPlan,
  activatePlan,
} = require("../controllers/planController");

// public
router.get("/", listPlans);

// authenticated
router.use(protect);
router.get("/current", requireWorkspace, getCurrentPlan);
router.post("/activate", requireWorkspace, activatePlan);

module.exports = router;
