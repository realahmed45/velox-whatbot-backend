const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const c = require("../controllers/giveawayController");

router.use(protect, requireWorkspace);

router.get("/", c.list);
router.post("/", requireOwner, c.create);
router.get("/:id", c.get);
router.put("/:id", requireOwner, c.update);
router.delete("/:id", requireOwner, c.remove);
router.post("/:id/pick-winners", requireOwner, c.pickWinners);

module.exports = router;
