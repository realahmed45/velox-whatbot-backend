const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const c = require("../controllers/aiController");

router.use(protect, requireWorkspace);

router.post("/caption", c.generateCaption);
router.post("/suggest-replies", c.suggestReplies);
router.post("/sentiment", c.analyzeSentiment);
router.post("/hashtags", c.researchHashtags);

module.exports = router;
