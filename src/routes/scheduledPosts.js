const express = require("express");
const router = express.Router();
const c = require("../controllers/scheduledPostsController");
const {
  protect,
  requireWorkspace,
  requirePermission,
} = require("../middleware/auth");

router.use(protect);
router.use(requireWorkspace);
router.use(requirePermission("content"));

router.get("/", c.getScheduledPosts);
router.post("/", c.createScheduledPost);
router.post("/bulk", c.bulkCreate);
router.post("/ai-caption", c.aiCaption);
router.get("/smart-timing", c.getSmartTiming);
router.put("/:id", c.updateScheduledPost);
router.delete("/:id", c.cancelScheduledPost);

module.exports = router;
