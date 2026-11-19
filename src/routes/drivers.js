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
} = require("../controllers/driverController");

// Public: replies from drivers to Botlify's own WhatsApp number (WasenderAPI
// session webhook, X-Webhook-Signature checked). "YES T4K9", "DONE T4K9"…
router.post("/whatsapp/hook", async (req, res) => {
  const platformWA = require("../services/channels/platformWhatsApp");
  if (!platformWA.verifySignature(req)) return res.status(401).json({ error: "Invalid signature" });
  res.status(200).json({ received: true });
  try {
    const { handleDriverMessage } = require("../services/transfers/autoDispatchService");
    for (const m of platformWA.parseWebhook(req.body || {})) {
      await handleDriverMessage({ from: m.from, text: m.text });
    }
  } catch (err) {
    require("../utils/logger").error(`[driverHook] ${err.message}`);
  }
});

router.use(protect, requireWorkspace);

router.get("/", listHotelDrivers);
router.post("/", requireOwner, createHotelDriver);
router.patch("/:id", requireOwner, updateHotelDriver);
router.delete("/:id", requireOwner, deleteHotelDriver);

module.exports = router;
