/**
 * Public direct-booking page — NO auth. Anyone with the link can read the
 * property and book a room, so the write endpoint is rate-limited per IP.
 */
const express = require("express");
const router = express.Router();
const { strictLimiter } = require("../middleware/enhancedRateLimiter");
const {
  getPublicProperty,
  getPublicAvailability,
  createPublicBooking,
} = require("../controllers/publicBookingController");

router.get("/:slug", getPublicProperty);
router.get("/:slug/availability", getPublicAvailability);
// 5 attempts/min/IP — a real guest books once; anything faster is a script.
router.post("/:slug/book", strictLimiter, createPublicBooking);

module.exports = router;
