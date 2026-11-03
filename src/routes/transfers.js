// Airport-transfer routes — mounted at /api/transfers (see server.js).
// Workspace is resolved from the x-workspace-id header by requireWorkspace.
const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  list,
  create,
  updateStatus,
  setDriver,
} = require("../controllers/transferController");

router.use(protect, requireWorkspace);

router.get("/", list);
router.post("/", create);
router.patch("/:id/status", updateStatus);
router.patch("/:id/driver", setDriver);

module.exports = router;
