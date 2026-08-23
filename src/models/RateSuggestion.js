const mongoose = require("mongoose");

/**
 * RateSuggestion — one AI pricing recommendation awaiting the owner's tap.
 *
 * The revenue engine writes these daily; the owner approves or skips on the
 * Today screen. Nothing reaches the OTAs until `status` becomes "approved" and
 * the push succeeds. Kept deliberately small: one room type, one date range,
 * one price, one reason the owner can actually read.
 */
const rateSuggestionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    dateFrom: { type: Date, required: true },
    dateTo: { type: Date, required: true },
    currentRate: { type: Number, required: true },
    suggestedRate: { type: Number, required: true },
    currency: { type: String, default: "USD" },
    // Plain-language justification shown verbatim to the owner.
    reason: { type: String, required: true },
    // What drove it — for our own tuning, never shown raw.
    signals: {
      occupancyPct: Number,
      expectedOccupancyPct: Number,
      daysToArrival: Number,
      unsoldUnits: Number,
      networkOccupancyPct: Number, // anonymous cross-hotel demand signal
    },
    direction: { type: String, enum: ["raise", "drop", "hold"], required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "skipped", "expired", "failed"],
      default: "pending",
      index: true,
    },
    appliedAt: Date,
    appliedBy: { type: String, default: "" }, // user email or "agent"
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

// One live suggestion per room/date-range — regenerating replaces it.
rateSuggestionSchema.index(
  { roomTypeId: 1, dateFrom: 1, dateTo: 1, status: 1 },
);
rateSuggestionSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("RateSuggestion", rateSuggestionSchema);
