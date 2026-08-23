const asyncHandler = require("express-async-handler");
const Property = require("../models/Property");
const RateSuggestion = require("../models/RateSuggestion");
const HotelBooking = require("../models/HotelBooking");
const { runAgent } = require("../services/agent/agentService");
const {
  applySuggestion,
  skipSuggestion,
  generateForProperty,
} = require("../services/revenue/revenueService");
const { toDay } = require("../services/hotel/availability");

// ─── Botlify Agent ──────────────────────────────────────────────────────────

// @POST /api/agent/chat — { message, history?, confirm? }
// The owner talks to the agent. Read-only questions answer immediately; any
// action comes back as `pendingAction` for the owner to approve, then the
// client re-posts with `confirm` to execute it.
const chat = asyncHandler(async (req, res) => {
  const { message, history = [], confirm = null } = req.body || {};
  if (!message && !confirm) {
    res.status(400);
    throw new Error("Message required");
  }
  const result = await runAgent({
    workspace: req.workspace,
    user: req.user,
    message,
    history: Array.isArray(history) ? history : [],
    confirm,
  });
  res.json({ success: true, ...result });
});

// ─── Today screen ───────────────────────────────────────────────────────────

// @GET /api/agent/today — everything the owner needs on one screen.
const today = asyncHandler(async (req, res) => {
  const wsId = req.workspace._id;
  const d = toDay(new Date());
  const activeStatuses = ["pending", "confirmed"];

  const [arrivals, departures, inHouse, suggestions, property] =
    await Promise.all([
      HotelBooking.find({ workspaceId: wsId, status: { $in: activeStatuses }, checkIn: d })
        .select("code guestName guestPhone nights source unitLabel checkedInAt roomTypeId")
        .populate("roomTypeId", "name")
        .lean(),
      HotelBooking.find({ workspaceId: wsId, status: { $in: activeStatuses }, checkOut: d })
        .select("code guestName unitLabel checkedOutAt roomTypeId")
        .populate("roomTypeId", "name")
        .lean(),
      HotelBooking.countDocuments({
        workspaceId: wsId,
        status: { $in: activeStatuses },
        checkIn: { $lte: d },
        checkOut: { $gt: d },
      }),
      RateSuggestion.find({ workspaceId: wsId, status: "pending" })
        .sort({ dateFrom: 1 })
        .limit(5)
        .populate("roomTypeId", "name")
        .lean(),
      Property.findOne({ workspaceId: wsId, active: true }).lean(),
    ]);

  // Month-to-date revenue by source (cheap single aggregate).
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const revenue = await HotelBooking.aggregate([
    {
      $match: {
        workspaceId: wsId,
        status: { $in: ["confirmed", "completed"] },
        checkIn: { $gte: monthStart },
      },
    },
    {
      $group: {
        _id: "$source",
        revenue: { $sum: "$totalAmount" },
        bookings: { $sum: 1 },
      },
    },
  ]);

  res.json({
    success: true,
    date: d,
    arrivals,
    departures,
    inHouse,
    suggestions: suggestions.map((s) => ({
      _id: s._id,
      room: s.roomTypeId && s.roomTypeId.name,
      dateFrom: s.dateFrom,
      dateTo: s.dateTo,
      currentRate: s.currentRate,
      suggestedRate: s.suggestedRate,
      currency: s.currency,
      direction: s.direction,
      reason: s.reason,
    })),
    revenue: {
      monthToDate: revenue.reduce((a, r) => a + r.revenue, 0),
      currency: (property && property.currency) || "USD",
      bySource: revenue.map((r) => ({
        source: r._id,
        revenue: Math.round(r.revenue),
        bookings: r.bookings,
      })),
    },
    property: property
      ? { _id: property._id, name: property.name, currency: property.currency }
      : null,
  });
});

// ─── Pricing suggestions ────────────────────────────────────────────────────

// @GET /api/agent/suggestions?status=pending
const listSuggestions = asyncHandler(async (req, res) => {
  const rows = await RateSuggestion.find({
    workspaceId: req.workspace._id,
    status: req.query.status || "pending",
  })
    .sort({ dateFrom: 1 })
    .limit(50)
    .populate("roomTypeId", "name")
    .lean();
  res.json({ success: true, suggestions: rows });
});

// @POST /api/agent/suggestions/:id/approve
const approveSuggestion = asyncHandler(async (req, res) => {
  const doc = await RateSuggestion.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!doc) {
    res.status(404);
    throw new Error("Suggestion not found");
  }
  const result = await applySuggestion(doc, { by: req.user.email });
  if (!result.ok) {
    res.status(400);
    throw new Error("Could not apply that suggestion");
  }
  res.json({ success: true, ...result });
});

// @POST /api/agent/suggestions/:id/skip
const skip = asyncHandler(async (req, res) => {
  const doc = await RateSuggestion.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!doc) {
    res.status(404);
    throw new Error("Suggestion not found");
  }
  await skipSuggestion(doc._id);
  res.json({ success: true });
});

// @POST /api/agent/suggestions/refresh — regenerate now (owner-triggered).
const refreshSuggestions = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    workspaceId: req.workspace._id,
    active: true,
  });
  if (!property) {
    res.status(400);
    throw new Error("Add your property first");
  }
  const result = await generateForProperty(property);
  res.json({ success: true, ...result });
});

// @PUT /api/agent/revenue-settings — { enabled, mode, minRate, maxRate }
const updateRevenueSettings = asyncHandler(async (req, res) => {
  const { enabled, mode, minRate, maxRate } = req.body || {};
  const update = {};
  if (enabled !== undefined) update["revenue.enabled"] = !!enabled;
  if (mode === "suggest" || mode === "auto") update["revenue.mode"] = mode;
  if (minRate !== undefined) update["revenue.minRate"] = Number(minRate) || 0;
  if (maxRate !== undefined) update["revenue.maxRate"] = Number(maxRate) || 0;
  const property = await Property.findOneAndUpdate(
    { workspaceId: req.workspace._id, active: true },
    { $set: update },
    { new: true },
  );
  if (!property) {
    res.status(404);
    throw new Error("Property not found");
  }
  res.json({ success: true, revenue: property.revenue });
});

module.exports = {
  chat,
  today,
  listSuggestions,
  approveSuggestion,
  skip,
  refreshSuggestions,
  updateRevenueSettings,
};
