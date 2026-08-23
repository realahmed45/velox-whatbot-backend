// Growth routes (upsells + reputation) — mounted at /api/growth (see server.js).
// Workspace is resolved from the x-workspace-id header by requireWorkspace.
const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const upsell = require("../controllers/upsellController");
const review = require("../controllers/reviewController");

router.use(protect, requireWorkspace);

// ── Upsells ────────────────────────────────────────────────
router.get("/upsells", upsell.list);
router.post("/upsells", upsell.offer);
router.patch("/upsells/:id", upsell.updateStatus);

router.get("/upsell-catalog", upsell.getCatalog);
router.put("/upsell-catalog", requireOwner, upsell.putCatalog);

// ── Reviews ────────────────────────────────────────────────
// /themes before /:id/* so it is never read as an id.
router.get("/reviews/themes", review.themes);
router.get("/reviews", review.list);
router.post("/reviews/:id/draft", review.draft);
router.patch("/reviews/:id/reply", review.updateReply);

module.exports = router;
