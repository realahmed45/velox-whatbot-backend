const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
  requirePermission,
} = require("../middleware/auth");
const c = require("../controllers/dripController");

router.use(protect, requireWorkspace);
router.use(requirePermission("broadcasts"));

router.get("/", c.list);
router.post("/", requireOwner, c.create);
router.get("/:id", c.get);
router.put("/:id", requireOwner, c.update);
router.delete("/:id", requireOwner, c.remove);
router.post("/:id/enroll", c.enroll);
router.get("/:id/enrollments", c.enrollments);

module.exports = router;
