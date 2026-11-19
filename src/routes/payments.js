const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const ctrl = require("../controllers/paymentsController");

// Public: Xendit callbacks (invoice paid/expired, payout succeeded/failed).
router.post("/xendit/webhook", ctrl.webhook);

router.use(protect, requireWorkspace);
router.get("/status", ctrl.status);
router.get("/", ctrl.list);
router.post("/connect", requireOwner, ctrl.connect);
router.post("/refresh", requireOwner, ctrl.refresh);
router.patch("/settings", requireOwner, ctrl.updateSettings);
router.post("/link", ctrl.createLink);

module.exports = router;
