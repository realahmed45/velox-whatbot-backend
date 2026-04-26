const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const c = require("../controllers/linkInBioController");

router.use(protect, requireWorkspace);

router.get("/", c.get);
router.post("/", requireOwner, c.createOrUpdate);
router.delete("/", requireOwner, c.remove);

module.exports = router;
