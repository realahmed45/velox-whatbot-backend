// Botlify Agent + revenue manager — mounted at /api/agent (see server.js).
const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const {
  chat,
  today,
  listSuggestions,
  approveSuggestion,
  skip,
  refreshSuggestions,
  updateRevenueSettings,
} = require("../controllers/agentController");

router.use(protect, requireWorkspace);

// The Today screen (arrivals, departures, in-house, suggestions, revenue).
router.get("/today", today);

// Talk to the agent.
router.post("/chat", chat);

// Pricing suggestions — approve/skip are owner decisions.
router.get("/suggestions", listSuggestions);
router.post("/suggestions/refresh", requireOwner, refreshSuggestions);
router.post("/suggestions/:id/approve", requireOwner, approveSuggestion);
router.post("/suggestions/:id/skip", requireOwner, skip);

router.put("/revenue-settings", requireOwner, updateRevenueSettings);

module.exports = router;
