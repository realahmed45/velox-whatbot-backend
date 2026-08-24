const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
  requirePermission,
} = require("../middleware/auth");
const {
  listProperties,
  createProperty,
  updateProperty,
  listChannexProperties,
  importChannexProperty,
  listBeds24Properties,
  importBeds24Property,
  listRoomTypes,
  createRoomType,
  updateRoomType,
  roomAvailability,
  checkRange,
  listBookings,
  createManualBooking,
  updateBookingStatus,
} = require("../controllers/hotelController");

router.use(protect);
router.use(requireWorkspace);

// Properties
router.get("/properties", listProperties);
router.post("/properties", requireOwner, createProperty);
router.put("/properties/:id", requireOwner, updateProperty);

// Channex (OTA) connect/import
router.get("/channex/properties", requireOwner, listChannexProperties);
router.post("/channex/import", requireOwner, importChannexProperty);

// Beds24 (OTA) connect/import — the alternative channel manager
router.get("/beds24/properties", requireOwner, listBeds24Properties);
router.post("/beds24/import", requireOwner, importBeds24Property);

// Rooms
router.get("/properties/:id/rooms", listRoomTypes);
router.post("/properties/:id/rooms", requireOwner, createRoomType);
router.put("/rooms/:roomId", requireOwner, updateRoomType);

// Availability
router.get(
  "/rooms/:roomId/availability",
  requirePermission("calendar"),
  roomAvailability,
);
router.get("/rooms/:roomId/check", requirePermission("calendar"), checkRange);

// Bookings
router.get("/bookings", requirePermission("bookings"), listBookings);
router.post("/bookings", requirePermission("bookings"), createManualBooking);
router.patch(
  "/bookings/:id/status",
  requirePermission("bookings"),
  updateBookingStatus,
);

module.exports = router;
