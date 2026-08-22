const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const {
  listProperties,
  createProperty,
  updateProperty,
  listChannexProperties,
  importChannexProperty,
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

// Rooms
router.get("/properties/:id/rooms", listRoomTypes);
router.post("/properties/:id/rooms", requireOwner, createRoomType);
router.put("/rooms/:roomId", requireOwner, updateRoomType);

// Availability
router.get("/rooms/:roomId/availability", roomAvailability);
router.get("/rooms/:roomId/check", checkRange);

// Bookings
router.get("/bookings", listBookings);
router.post("/bookings", createManualBooking);
router.patch("/bookings/:id/status", updateBookingStatus);

module.exports = router;
