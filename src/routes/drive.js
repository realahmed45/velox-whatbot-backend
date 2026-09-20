/**
 * Driver job page — mounted at /api/drive (see server.js).
 *
 * PUBLIC BY DESIGN: a driver has no Botlify login. The token in the URL is the
 * credential — 24 random bytes, unguessable, and rotatable from the dashboard
 * if a driver loses their phone. Every handler looks the driver up by token and
 * scopes everything to them, so a valid token still only ever exposes that
 * driver's own jobs.
 */
const express = require("express");
const router = express.Router();
const {
  driverJobs,
  driverAccept,
  driverDecline,
} = require("../controllers/driverController");

router.get("/:token", driverJobs);
router.post("/:token/:transferId/accept", driverAccept);
router.post("/:token/:transferId/decline", driverDecline);

module.exports = router;
