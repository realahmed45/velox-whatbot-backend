// Consultant (marketer) routes — mounted at /api/consultants (see server.js).
const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const {
  validateCode,
  apply,
  getMe,
  updateMe,
  myHotels,
  attribute,
} = require("../controllers/consultantController");

// Public — referral-code check at hotel onboarding (no auth).
router.get("/validate/:code", validateCode);

// Consultant self-service (any logged-in user).
router.post("/apply", protect, apply);
router.get("/me", protect, getMe);
router.put("/me", protect, updateMe);
router.get("/me/hotels", protect, myHotels);

// Hotel owner attributes their workspace to a consultant's code.
router.post("/attribute", protect, requireWorkspace, requireOwner, attribute);

module.exports = router;
