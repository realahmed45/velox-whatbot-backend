const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const { aiLimiter } = require("../middleware/enhancedRateLimiter");
const c = require("../controllers/aiController");
const bot = require("../controllers/aiBotController");
const multer = require("multer");

// In-memory upload for bulk product import (CSV / PDF / Word / image / txt).
// Generous cap — multi-page image menus/catalogs can be large.
const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

// Diagnostic: confirm Gemini key + model are working on the live server.
// PUBLIC (no auth) so it can be opened directly in a browser. Returns only a
// boolean + a tiny "OK" test reply — no secrets.
router.get("/health", async (req, res) => {
  const ai = require("../services/ai");
  res.json(await ai.healthCheck());
});

router.use(protect, requireWorkspace, aiLimiter);

router.post("/caption", c.generateCaption);
router.post("/suggest-replies", c.suggestReplies);
router.post("/sentiment", c.analyzeSentiment);
router.post("/hashtags", c.researchHashtags);

// AI bot — persona auto-draft + playground test sandbox + bulk product import
router.post("/draft-persona", bot.draftPersona);
router.post("/playground", bot.playground);
router.post(
  "/import-products",
  productUpload.single("file"),
  bot.importProducts,
);

module.exports = router;
