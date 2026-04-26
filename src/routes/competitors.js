const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const c = require("../controllers/competitorController");

router.use(protect, requireWorkspace);

router.get("/", c.list);
router.post("/", requireOwner, c.create);
router.delete("/:id", requireOwner, c.remove);
router.post("/:id/snapshots", c.addSnapshot);

module.exports = router;
