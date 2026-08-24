const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requirePermission,
} = require("../middleware/auth");
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
  listGuestProfiles,
  getGuestProfile,
  addGuestPreference,
} = require("../controllers/pmsController");

router.use(protect);
router.use(requireWorkspace);

// Front desk
router.get("/today", requirePermission("bookings"), today);
router.post(
  "/bookings/:id/check-in",
  requirePermission("bookings"),
  checkIn,
);
router.post(
  "/bookings/:id/check-out",
  requirePermission("bookings"),
  checkOut,
);

// Folio (extras charged during the stay)
router.post(
  "/bookings/:id/folio",
  requirePermission("bookings"),
  addFolioLine,
);
router.delete(
  "/bookings/:id/folio/:lineId",
  requirePermission("bookings"),
  removeFolioLine,
);

// Housekeeping
router.get("/units", requirePermission("calendar"), listUnits);
router.patch("/units", requirePermission("calendar"), updateUnit);

// Public booking page link
router.put("/property/slug", propertySlug);

// Anonymous city demand
router.get("/demand", demand);

// Unified guest profiles (one person across every channel and OTA).
router.get("/guests", requirePermission("guests"), listGuestProfiles);
router.get("/guests/:id", requirePermission("guests"), getGuestProfile);
router.post(
  "/guests/:id/preferences",
  requirePermission("guests"),
  addGuestPreference,
);

module.exports = router;
