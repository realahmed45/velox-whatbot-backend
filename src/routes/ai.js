const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const { aiLimiter } = require("../middleware/enhancedRateLimiter");
const c = require("../controllers/aiController");
const bot = require("../controllers/aiBotController");

router.use(protect, requireWorkspace, aiLimiter);

router.post("/caption", c.generateCaption);
router.post("/suggest-replies", c.suggestReplies);
router.post("/sentiment", c.analyzeSentiment);
router.post("/hashtags", c.researchHashtags);

// AI bot — persona auto-draft + playground test sandbox
router.post("/draft-persona", bot.draftPersona);
router.post("/playground", bot.playground);

module.exports = router;
