const express = require("express");
const router = express.Router();
const {
  getScheduledPosts,
  createScheduledPost,
  cancelScheduledPost,
  getSmartTiming,
} = require("../controllers/scheduledPostsController");
const { protect } = require("../middleware/auth");

// All routes require authentication
router.use(protect);

router.get("/", getScheduledPosts);
router.post("/", createScheduledPost);
router.delete("/:id", cancelScheduledPost);
router.get("/smart-timing", getSmartTiming);

module.exports = router;
