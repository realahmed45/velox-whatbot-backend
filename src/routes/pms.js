const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  today,
  checkIn,
  checkOut,
  addFolioLine,
  removeFolioLine,
  listUnits,
  updateUnit,
  propertySlug,
  demand,
} = require("../controllers/pmsController");

router.use(protect);
router.use(requireWorkspace);

// Front desk
router.get("/today", today);
router.post("/bookings/:id/check-in", checkIn);
router.post("/bookings/:id/check-out", checkOut);

// Folio (extras charged during the stay)
router.post("/bookings/:id/folio", addFolioLine);
router.delete("/bookings/:id/folio/:lineId", removeFolioLine);

// Housekeeping
router.get("/units", listUnits);
router.patch("/units", updateUnit);

// Public booking page link
router.put("/property/slug", propertySlug);

// Anonymous city demand
router.get("/demand", demand);

module.exports = router;
