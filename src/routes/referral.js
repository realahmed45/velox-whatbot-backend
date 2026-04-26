const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const c = require("../controllers/referralController");

router.use(protect, requireWorkspace);

router.get("/", c.getReferral);
router.post("/track", c.trackReferral);
router.post("/convert", c.convertReferral);

module.exports = router;
