/**
 * Driver routes — mounted at /api/drivers (see server.js).
 *
 * A hotel's OWN drivers. Owner-only: a driver holds a guest's phone number and
 * an identity record, so this is not something a receptionist edits.
 * Botlify's shared pool lives under /api/admin/drivers instead.
 */
const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const {
  listHotelDrivers,
  createHotelDriver,
  updateHotelDriver,
  deleteHotelDriver,
  hotelDriverLink,
} = require("../controllers/driverController");

router.use(protect, requireWorkspace);

router.get("/", listHotelDrivers);
router.post("/", requireOwner, createHotelDriver);
router.patch("/:id", requireOwner, updateHotelDriver);
router.delete("/:id", requireOwner, deleteHotelDriver);
router.get("/:id/link", requireOwner, hotelDriverLink);

module.exports = router;
